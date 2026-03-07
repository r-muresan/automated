'use client';

import { useEffect, useRef, useImperativeHandle, forwardRef, useCallback } from 'react';
import { VncScreen } from 'react-vnc';
import type { VncScreenHandle } from 'react-vnc';
import type { Interaction } from '../../../hooks/useBrowserCDP';

export interface NoVNCViewerHandle {
  /** Access the live visible VNC canvas */
  getCanvas: () => HTMLCanvasElement | null;
  /** Grab a screenshot from the VNC canvas as a data URL */
  captureScreenshot: (type?: string, quality?: number) => string | null;
}

interface NoVNCViewerProps {
  vncUrl: string;
  viewOnly?: boolean;
  scaleViewport?: boolean;
  onConnect?: () => void;
  onDisconnect?: (clean: boolean) => void;
  onError?: (message: string) => void;
  onInteraction?: (interaction: Interaction) => void;
  onInteractionUpdate?: (id: string, updates: Partial<Interaction>) => void;
}

const CLICK_SNAPSHOT_CROP_RATIO = 0.4;
const CLICK_SNAPSHOT_MARKER_RATIO = 0.02;

const clampNumber = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const waitForNextPaint = async () => {
  if (typeof window === 'undefined') return;
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
};

export const NoVNCViewer = forwardRef<NoVNCViewerHandle, NoVNCViewerProps>(
  ({ vncUrl, viewOnly = false, scaleViewport = true, onConnect, onDisconnect, onError, onInteraction, onInteractionUpdate }, ref) => {
    const vncRef = useRef<VncScreenHandle>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const remoteClipboardTextRef = useRef('');
    const pendingClipboardResolveRef = useRef<((blob: Blob) => void) | null>(null);

    // Refs for interaction tracking
    const onInteractionRef = useRef(onInteraction);
    const onInteractionUpdateRef = useRef(onInteractionUpdate);
    const lastClickTimestampRef = useRef<number>(0);
    const typingBufferRef = useRef<{
      interactionId: string;
      text: string;
      lastTimestamp: number;
    } | null>(null);

    // Keep refs updated
    useEffect(() => {
      onInteractionRef.current = onInteraction;
    }, [onInteraction]);
    useEffect(() => {
      onInteractionUpdateRef.current = onInteractionUpdate;
    }, [onInteractionUpdate]);

    // Detect local OS for Cmd→Ctrl translation
    const isMac =
      typeof navigator !== 'undefined' &&
      (navigator.userAgent.includes('Mac') ||
        /Mac|iPhone|iPad|iPod/.test(navigator.platform) ||
        ((navigator as any).userAgentData?.platform === 'macOS'));

    const getVisibleCanvas = useCallback(() => {
      const canvases = Array.from(containerRef.current?.querySelectorAll('canvas') ?? []) as HTMLCanvasElement[];
      if (canvases.length === 0) return null;

      const nonZeroCanvases = canvases.filter((canvas) => canvas.width > 0 && canvas.height > 0);
      if (nonZeroCanvases.length === 0) {
        return canvases[0] ?? null;
      }

      return nonZeroCanvases.reduce((largest, current) =>
        current.width * current.height > largest.width * largest.height ? current : largest,
      );
    }, []);

    const captureScreenshot = useCallback((type = 'image/jpeg', quality = 0.55): string | null => {
      try {
        const visibleCanvas = getVisibleCanvas();
        if (visibleCanvas && visibleCanvas.width > 0 && visibleCanvas.height > 0) {
          return visibleCanvas.toDataURL(type, quality);
        }
        const rfb = vncRef.current?.rfb;
        if (!rfb) return null;
        return rfb.toDataURL(type, quality);
      } catch {
        return null;
      }
    }, [getVisibleCanvas]);

    useImperativeHandle(ref, () => ({
      getCanvas: () => getVisibleCanvas(),
      captureScreenshot,
    }));

    /** Create a cropped click snapshot with blue dot marker */
    const createClickSnapshot = useCallback(
      (screenshotUrl: string, clickX: number, clickY: number): Promise<string | null> => {
        return new Promise((resolve) => {
          if (typeof document === 'undefined') {
            resolve(screenshotUrl);
            return;
          }

          const liveCanvas = getVisibleCanvas();
          if (liveCanvas && liveCanvas.width > 0 && liveCanvas.height > 0) {
            const result = cropAndMark(liveCanvas, liveCanvas.width, liveCanvas.height, clickX, clickY);
            resolve(result);
            return;
          }

          // Fall back to loading the screenshot URL as an image
          const image = new Image();
          image.onload = () => {
            const w = image.naturalWidth || image.width;
            const h = image.naturalHeight || image.height;
            if (!w || !h) { resolve(null); return; }
            const result = cropAndMark(image, w, h, clickX, clickY);
            resolve(result);
          };
          image.onerror = () => resolve(null);
          image.src = screenshotUrl;
        });
      },
      [getVisibleCanvas],
    );

    // X11 keysyms for sendKey
    const XK_Control_L = 0xffe3;
    const XK_Shift_L = 0xffe1;

    const isViewerFocused = useCallback(() => {
      const activeElement = document.activeElement;
      return !!(activeElement && containerRef.current?.contains(activeElement));
    }, []);

    /** Send Ctrl+<key> to remote (used for copy/paste/cut/undo/etc.) */
    const sendCtrlKey = useCallback(
      (keysym: number, code: string, withShift = false) => {
        const handle = vncRef.current;
        if (!handle?.rfb || handle.rfb.viewOnly) return;
        if (withShift) handle.sendKey(XK_Shift_L, 'ShiftLeft', true);
        handle.sendKey(XK_Control_L, 'ControlLeft', true);
        handle.sendKey(keysym, code, true);
        handle.sendKey(keysym, code, false);
        handle.sendKey(XK_Control_L, 'ControlLeft', false);
        if (withShift) handle.sendKey(XK_Shift_L, 'ShiftLeft', false);
      },
      [],
    );

    // Map of Cmd+<key> shortcuts that should be translated to Ctrl+<key> on remote.
    const cmdToCtrlMap: Record<string, [number, string, boolean?]> = {
      c: [0x0063, 'KeyC'], // Copy
      x: [0x0078, 'KeyX'], // Cut
      v: [0x0076, 'KeyV'], // Paste
      a: [0x0061, 'KeyA'], // Select All
      z: [0x007a, 'KeyZ'], // Undo (Shift variant = Redo)
      y: [0x0079, 'KeyY'], // Redo alt
      f: [0x0066, 'KeyF'], // Find
      s: [0x0073, 'KeyS'], // Save
      w: [0x0077, 'KeyW'], // Close tab
      t: [0x0074, 'KeyT'], // New tab
      n: [0x006e, 'KeyN'], // New window
      l: [0x006c, 'KeyL'], // Address bar
      r: [0x0072, 'KeyR'], // Reload
      p: [0x0070, 'KeyP'], // Print
    };

    const getTranslatedShortcut = useCallback(
      (event: KeyboardEvent): [number, string, boolean] | null => {
        const isPrimary = isMac ? event.metaKey || event.ctrlKey : event.ctrlKey;
        if (!isPrimary) return null;

        const key = event.key.toLowerCase();
        const entry = cmdToCtrlMap[key];
        if (!entry) return null;

        const withShift = event.shiftKey && (entry[2] !== undefined ? entry[2] : true);
        return [entry[0], entry[1], withShift];
      },
      [isMac],
    );

    // Click interaction tracking on the VNC canvas
    useEffect(() => {
      const container = containerRef.current;
      if (!container || viewOnly) return;

      const handleMouseDown = async (event: MouseEvent) => {
        // Only track left clicks on the canvas area
        if (event.button !== 0) return;

        const now = Date.now();
        if (now - lastClickTimestampRef.current < 100) return;
        lastClickTimestampRef.current = now;

        // Clear typing buffer on click
        typingBufferRef.current = null;

        // Get raw canvas pixel coordinates
        const canvas = getVisibleCanvas();
        if (!canvas) return;

        const rect = canvas.getBoundingClientRect();
        // Map DOM click position to canvas pixel coordinates
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const x = Math.round((event.clientX - rect.left) * scaleX);
        const y = Math.round((event.clientY - rect.top) * scaleY);

        const interactionId = `click-${now}-${Math.random().toString(36).substring(2, 9)}`;

        const interaction: Interaction = {
          id: interactionId,
          type: 'user_event',
          timestamp: now,
          pageId: '',
          element: {
            tagName: 'CLICK',
            text: `(${x}, ${y})`,
            selector: 'coordinates',
          },
          data: {
            type: 'click',
            x,
            y,
          },
        };

        onInteractionRef.current?.(interaction);

        // Capture screenshot asynchronously and update
        try {
          await waitForNextPaint();
          const screenshotUrl = captureScreenshot('image/jpeg', 0.55);
          if (!screenshotUrl) return;

          const croppedUrl = await createClickSnapshot(screenshotUrl, x, y);
          if (croppedUrl) {
            onInteractionUpdateRef.current?.(interactionId, { screenshotUrl: croppedUrl });
          }
        } catch (error) {
          console.warn('[NoVNCViewer] Failed to capture click screenshot:', error);
        }
      };

      // Use capture phase so we see the event before noVNC's canvas consumes it
      container.addEventListener('mousedown', handleMouseDown, true);
      return () => container.removeEventListener('mousedown', handleMouseDown, true);
    }, [viewOnly, getVisibleCanvas, captureScreenshot, createClickSnapshot]);

    // Clipboard & keyboard event handlers
    useEffect(() => {
      let disposed = false;

      const handleRemoteClipboard = (e: { detail: { text: string } }) => {
        const text = e.detail.text;
        remoteClipboardTextRef.current = text;

        if (pendingClipboardResolveRef.current) {
          pendingClipboardResolveRef.current(new Blob([text], { type: 'text/plain' }));
          pendingClipboardResolveRef.current = null;
          return;
        }

        if (!navigator.clipboard?.writeText) return;
        void navigator.clipboard.writeText(text).catch((error) => {
          console.warn('[NoVNCViewer] Failed to write remote clipboard locally:', error);
        });
      };

      const handleCopy = (event: ClipboardEvent) => {
        if (!isViewerFocused()) return;
        if (remoteClipboardTextRef.current) {
          event.preventDefault();
          event.clipboardData?.setData('text/plain', remoteClipboardTextRef.current);
        }
      };

      const handlePaste = (event: ClipboardEvent) => {
        if (!isViewerFocused()) return;
        event.preventDefault();
        event.stopPropagation();

        const text = event.clipboardData?.getData('text/plain') ?? '';
        const handle = vncRef.current;
        if (text && handle?.rfb && !handle.rfb.viewOnly) {
          handle.clipboardPaste(text);
          setTimeout(() => {
            if (disposed) return;
            sendCtrlKey(0x0076, 'KeyV');
          }, 50);
        }
      };

      const handleKeyDown = (event: KeyboardEvent) => {
        if (!isViewerFocused()) return;

        if (isMac && event.key === 'Meta') {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }

        const translated = getTranslatedShortcut(event);

        if (translated) {
          const [keysym, code, withShift] = translated;
          const key = event.key.toLowerCase();

          if (key === 'c' || key === 'x') {
            event.preventDefault();
            event.stopImmediatePropagation();
            sendCtrlKey(keysym, code, withShift);

            if (navigator.clipboard?.write) {
              const clipboardPromise = new Promise<Blob>((resolve) => {
                pendingClipboardResolveRef.current = resolve;
                setTimeout(() => {
                  if (pendingClipboardResolveRef.current === resolve) {
                    pendingClipboardResolveRef.current = null;
                    resolve(new Blob([remoteClipboardTextRef.current], { type: 'text/plain' }));
                  }
                }, 2000);
              });

              void navigator.clipboard
                .write([new ClipboardItem({ 'text/plain': clipboardPromise })])
                .catch((err) => {
                  console.warn('[NoVNCViewer] Deferred clipboard write failed:', err);
                });
            }
            return;
          }

          if (key === 'v') {
            event.preventDefault();
            event.stopImmediatePropagation();
            void (async () => {
              try {
                const text = await navigator.clipboard.readText();
                if (disposed) return;
                const handle = vncRef.current;
                if (!handle?.rfb || handle.rfb.viewOnly) return;
                if (text) handle.clipboardPaste(text);
                setTimeout(() => {
                  if (disposed) return;
                  sendCtrlKey(keysym, code, withShift);
                }, 50);
              } catch (err) {
                console.warn('[NoVNCViewer] Paste failed:', err);
              }
            })();
            return;
          }

          event.preventDefault();
          event.stopImmediatePropagation();
          sendCtrlKey(keysym, code, withShift);
          return;
        }

        if (event.shiftKey && event.key === 'Insert') {
          event.preventDefault();
          event.stopImmediatePropagation();
          void (async () => {
            try {
              const text = await navigator.clipboard.readText();
              if (disposed) return;
              const handle = vncRef.current;
              if (!handle?.rfb || handle.rfb.viewOnly) return;
              if (text) handle.clipboardPaste(text);
              setTimeout(() => {
                if (disposed) return;
                sendCtrlKey(0x0076, 'KeyV');
              }, 50);
            } catch (err) {
              console.warn('[NoVNCViewer] Shift+Insert paste failed:', err);
            }
          })();
          return;
        }

        // --- Interaction tracking for keydown events ---
        if (!viewOnly && onInteractionRef.current) {
          trackKeydown(event);
        }

        const hasModifier = event.ctrlKey || event.altKey || event.metaKey;
        const isSpecialKey = [
          'Tab',
          'Escape',
          'F1',
          'F2',
          'F3',
          'F4',
          'F5',
          'F6',
          'F7',
          'F8',
          'F9',
          'F10',
          'F11',
          'F12',
        ].includes(event.key);

        if (hasModifier || isSpecialKey) {
          event.preventDefault();
        }
      };

      /** Track keydown events for interaction recording */
      const trackKeydown = (event: KeyboardEvent) => {
        const { key, ctrlKey, altKey, metaKey } = event;

        if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(key)) return;

        const now = Date.now();

        // Handle modifier key combinations (Ctrl+C, Cmd+V, etc.) as separate "keypress" interactions
        if (ctrlKey || altKey || metaKey) {
          const modifiers: string[] = [];
          if (ctrlKey) modifiers.push('Ctrl');
          if (altKey) modifiers.push('Alt');
          if (metaKey) modifiers.push('Cmd');
          modifiers.push(key.length === 1 ? key.toUpperCase() : key);
          const combo = modifiers.join('+');

          // Clear typing buffer since this is a command, not typing
          typingBufferRef.current = null;

          const interactionId = `keypress-${now}-${Math.random().toString(36).substring(2, 9)}`;
          const newInteraction: Interaction = {
            id: interactionId,
            type: 'user_event',
            timestamp: now,
            pageId: '',
            element: {
              tagName: 'KEYPRESS',
              text: combo,
            },
            data: { type: 'keypress', combo },
          };

          onInteractionRef.current?.(newInteraction);
          return;
        }

        // Handle Backspace - remove last character from buffer
        if (key === 'Backspace') {
          if (
            typingBufferRef.current &&
            now - typingBufferRef.current.lastTimestamp < 3000 &&
            typingBufferRef.current.text.length > 0
          ) {
            const interactionId = typingBufferRef.current.interactionId;
            let currentText = typingBufferRef.current.text;
            if (currentText.endsWith(']')) {
              const bracketStart = currentText.lastIndexOf('[');
              if (bracketStart !== -1) {
                currentText = currentText.substring(0, bracketStart);
              } else {
                currentText = currentText.slice(0, -1);
              }
            } else {
              currentText = currentText.slice(0, -1);
            }

            typingBufferRef.current = {
              ...typingBufferRef.current,
              text: currentText,
              lastTimestamp: now,
            };

            onInteractionUpdateRef.current?.(interactionId, {
              timestamp: now,
              element: { text: currentText },
            });
          }
          return;
        }

        // Regular character or special key (Enter, Tab, etc.)
        const char = key.length === 1 ? key : `[${key}]`;

        if (
          typingBufferRef.current &&
          now - typingBufferRef.current.lastTimestamp < 3000
        ) {
          const newText = typingBufferRef.current.text + char;
          const interactionId = typingBufferRef.current.interactionId;

          typingBufferRef.current = {
            ...typingBufferRef.current,
            text: newText,
            lastTimestamp: now,
          };

          onInteractionUpdateRef.current?.(interactionId, {
            timestamp: now,
            element: { text: newText },
          });
        } else {
          const interactionId = `typing-${now}-${Math.random().toString(36).substring(2, 9)}`;
          const newInteraction: Interaction = {
            id: interactionId,
            type: 'user_event',
            timestamp: now,
            pageId: '',
            element: {
              text: char,
            },
            data: { type: 'keydown' },
          };

          typingBufferRef.current = {
            interactionId,
            text: char,
            lastTimestamp: now,
          };

          onInteractionRef.current?.(newInteraction);
        }
      };

      const handleKeyUp = (event: KeyboardEvent) => {
        if (!isViewerFocused()) return;

        if (isMac && event.key === 'Meta') {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }

        if (getTranslatedShortcut(event)) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      };

      // Listen for clipboard events from the VncScreen's RFB
      // We poll for rfb availability since VncScreen connects asynchronously
      let clipboardListenerAdded = false;
      const pollInterval = setInterval(() => {
        const rfb = vncRef.current?.rfb;
        if (rfb && !clipboardListenerAdded) {
          rfb.addEventListener('clipboard', handleRemoteClipboard as any);
          clipboardListenerAdded = true;
          clearInterval(pollInterval);
        }
      }, 200);

      window.addEventListener('keydown', handleKeyDown, true);
      window.addEventListener('keyup', handleKeyUp, true);
      window.addEventListener('paste', handlePaste, true);
      window.addEventListener('copy', handleCopy, true);

      return () => {
        disposed = true;
        clearInterval(pollInterval);
        window.removeEventListener('keydown', handleKeyDown, true);
        window.removeEventListener('keyup', handleKeyUp, true);
        window.removeEventListener('paste', handlePaste, true);
        window.removeEventListener('copy', handleCopy, true);
        if (clipboardListenerAdded) {
          const rfb = vncRef.current?.rfb;
          if (rfb) {
            rfb.removeEventListener('clipboard', handleRemoteClipboard as any);
          }
        }
      };
    }, [vncUrl, viewOnly, isViewerFocused, sendCtrlKey, getTranslatedShortcut, isMac]);

    const handleConnect = useCallback(() => {
      console.log('[NoVNCViewer] Connected successfully');
      vncRef.current?.focus();
      onConnect?.();
    }, [onConnect]);

    const handleDisconnect = useCallback(
      (rfb?: any) => {
        // react-vnc doesn't directly tell us if it's clean, but we can check
        // The disconnect callback receives the rfb object
        // A clean disconnect is when we intentionally disconnect
        const clean = !rfb; // If no rfb passed, it was clean
        console.log('[NoVNCViewer] Disconnected');
        onDisconnect?.(clean);
      },
      [onDisconnect],
    );

    const handleCredentialsRequired = useCallback(() => {
      console.log('[NoVNCViewer] Credentials requested, sending vncpassword');
      vncRef.current?.sendCredentials({ username: '', password: 'vncpassword', target: '' });
    }, []);

    const handleSecurityFailure = useCallback(
      (e?: any) => {
        console.error('[NoVNCViewer] Security failure:', e);
        onError?.('VNC security failure');
      },
      [onError],
    );

    return (
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: '100%',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <VncScreen
          url={vncUrl}
          scaleViewport={scaleViewport}
          viewOnly={viewOnly}
          focusOnClick
          resizeSession={false}
          autoConnect
          rfbOptions={{ credentials: { username: '', password: 'vncpassword', target: '' } }}
          onConnect={handleConnect}
          onDisconnect={handleDisconnect}
          onCredentialsRequired={handleCredentialsRequired}
          onSecurityFailure={handleSecurityFailure}
          ref={vncRef}
          style={{
            width: '100%',
            height: '100%',
          }}
        />
      </div>
    );
  },
);

NoVNCViewer.displayName = 'NoVNCViewer';

/** Crop around (clickX, clickY) on the source image and draw a blue dot marker */
function cropAndMark(
  imageSource: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  clickX: number,
  clickY: number,
): string | null {
  if (typeof document === 'undefined') return null;

  const cropWidth = Math.max(1, Math.round(sourceWidth * CLICK_SNAPSHOT_CROP_RATIO));
  const cropHeight = Math.max(1, Math.round(sourceHeight * CLICK_SNAPSHOT_CROP_RATIO));

  const xInImage = clampNumber(clickX, 0, sourceWidth - 1);
  const yInImage = clampNumber(clickY, 0, sourceHeight - 1);

  let cropLeft = xInImage - cropWidth / 2;
  let cropTop = yInImage - cropHeight / 2;
  cropLeft = clampNumber(cropLeft, 0, Math.max(0, sourceWidth - cropWidth));
  cropTop = clampNumber(cropTop, 0, Math.max(0, sourceHeight - cropHeight));

  const canvas = document.createElement('canvas');
  canvas.width = cropWidth;
  canvas.height = cropHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const srcLeft = clampNumber(cropLeft, 0, sourceWidth);
  const srcTop = clampNumber(cropTop, 0, sourceHeight);
  const srcRight = clampNumber(cropLeft + cropWidth, 0, sourceWidth);
  const srcBottom = clampNumber(cropTop + cropHeight, 0, sourceHeight);
  const srcW = Math.max(0, srcRight - srcLeft);
  const srcH = Math.max(0, srcBottom - srcTop);

  const destX = srcLeft - cropLeft;
  const destY = srcTop - cropTop;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cropWidth, cropHeight);
  if (srcW > 0 && srcH > 0) {
    ctx.drawImage(imageSource, srcLeft, srcTop, srcW, srcH, destX, destY, srcW, srcH);
  }

  const dotRadius = Math.max(
    3,
    Math.round(Math.min(cropWidth, cropHeight) * CLICK_SNAPSHOT_MARKER_RATIO),
  );
  const markerX = clampNumber(xInImage - cropLeft, 0, cropWidth);
  const markerY = clampNumber(yInImage - cropTop, 0, cropHeight);
  ctx.fillStyle = 'rgba(37, 99, 235, 0.92)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.lineWidth = Math.max(2, Math.round(dotRadius * 0.45));
  ctx.beginPath();
  ctx.arc(markerX, markerY, dotRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  return canvas.toDataURL('image/jpeg', 0.88);
}

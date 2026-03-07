'use client';

import { useEffect, useRef, useImperativeHandle, forwardRef, useCallback } from 'react';
import { VncScreen } from 'react-vnc';
import type { VncScreenHandle } from 'react-vnc';

export interface NoVNCViewerHandle {
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
}

export const NoVNCViewer = forwardRef<NoVNCViewerHandle, NoVNCViewerProps>(
  ({ vncUrl, viewOnly = false, scaleViewport = true, onConnect, onDisconnect, onError }, ref) => {
    const vncRef = useRef<VncScreenHandle>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const remoteClipboardTextRef = useRef('');
    const pendingClipboardResolveRef = useRef<((blob: Blob) => void) | null>(null);

    // Detect local OS for Cmd→Ctrl translation
    const isMac =
      typeof navigator !== 'undefined' &&
      (navigator.userAgent.includes('Mac') ||
        /Mac|iPhone|iPad|iPod/.test(navigator.platform) ||
        ((navigator as any).userAgentData?.platform === 'macOS'));

    useImperativeHandle(ref, () => ({
      captureScreenshot: (type = 'image/jpeg', quality = 0.55) => {
        const rfb = vncRef.current?.rfb;
        if (!rfb) return null;
        try {
          return rfb.toDataURL(type, quality);
        } catch {
          return null;
        }
      },
    }));

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
    }, [vncUrl, isViewerFocused, sendCtrlKey, getTranslatedShortcut, isMac]);

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

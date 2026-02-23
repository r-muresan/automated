'use client';

import { Box } from '@chakra-ui/react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';

const SCREENCAST_OPTIONS = {
  format: 'jpeg',
  quality: 70,
  maxWidth: 1920,
  maxHeight: 1080,
  everyNthFrame: 1,
};

const MODIFIER_KEYS: Record<string, boolean> = {
  Shift: true,
  Control: true,
  Alt: true,
  Meta: true,
};

const SPECIAL_KEY_TEXT: Record<string, string> = {
  Enter: '\\r',
  Tab: '\\t',
};

const DOUBLE_CLICK_WINDOW_MS = 450;
const DOUBLE_CLICK_MAX_DISTANCE_PX = 6;

const EVENT_TRACKING_SCRIPT = `(${function eventTrackingScript() {
  if ((window as any).__bbEventListenerInjected) return;
  (window as any).__bbEventListenerInjected = true;

  function reportEvent(data: unknown) {
    if (typeof (window as any).__cdpEvent === 'function') {
      try {
        (window as any).__cdpEvent(JSON.stringify(data));
      } catch {}
    }
  }

  function getElementSelector(el: Element | null): string {
    if (!el) return '';
    if ((el as HTMLElement).id) return `#${(el as HTMLElement).id}`;

    const path: string[] = [];
    let current: Element | null = el;

    while (current && current.nodeType === 1) {
      let selector = current.nodeName.toLowerCase();
      const className = (current as HTMLElement).className;
      if (className && typeof className === 'string') {
        selector += `.${className.trim().split(/\\s+/).join('.')}`;
      }
      path.unshift(selector);
      current = current.parentElement;
      if (path.length > 3) break;
    }

    return path.join(' > ');
  }

  function getElementInfo(target: EventTarget | null) {
    const el = target as HTMLElement | null;
    if (!el) return null;

    return {
      tagName: el.tagName || 'unknown',
      id: el.id || '',
      className: el.className || '',
      selector: getElementSelector(el),
      text: (el.textContent || '').substring(0, 200),
      value: (el as HTMLInputElement).value || '',
      href: (el as HTMLAnchorElement).href || '',
      type: (el as HTMLInputElement).type || '',
      name: (el as HTMLInputElement).name || '',
    };
  }

  document.addEventListener(
    'click',
    (event) => {
      reportEvent({
        type: 'click',
        x: event.clientX,
        y: event.clientY,
        target: getElementInfo(event.target),
        timestamp: Date.now(),
      });
    },
    true,
  );

  document.addEventListener(
    'keydown',
    (event) => {
      reportEvent({
        type: 'keydown',
        key: event.key,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        target: getElementInfo(event.target),
        timestamp: Date.now(),
      });
    },
    true,
  );
}.toString()})();`;

interface ScreencastFrameParams {
  data: string;
  sessionId: number;
  metadata?: {
    deviceWidth?: number;
    deviceHeight?: number;
  };
}

interface RuntimeBindingCalledParams {
  name?: string;
  payload?: string;
}

interface FrameNavigatedParams {
  frame?: {
    id?: string;
    parentId?: string;
    name?: string;
    url?: string;
  };
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

export interface RemoteCdpPlayerRef {
  getCurrentFrameDataUrl: () => string | null;
}

interface RemoteCdpPlayerProps {
  wsUrl: string;
  pageId: string;
  active: boolean;
  watchOnly?: boolean;
  onFirstFrame?: (pageId: string) => void;
}

interface LastClickInfo {
  button: number;
  x: number;
  y: number;
  time: number;
  count: number;
}

type PreventableEvent = {
  preventDefault: () => void;
  nativeEvent: Event;
  type: string;
  timeStamp: number;
};

export const RemoteCdpPlayer = forwardRef<RemoteCdpPlayerRef, RemoteCdpPlayerProps>(
  ({ wsUrl, pageId, active, watchOnly = false, onFirstFrame }, ref) => {
    const [frameSrc, setFrameSrc] = useState<string | null>(null);

    const socketRef = useRef<WebSocket | null>(null);
    const overlayRef = useRef<HTMLDivElement | null>(null);
    const imageRef = useRef<HTMLImageElement | null>(null);

    const messageIdRef = useRef(1);
    const reconnectTimeoutRef = useRef<number | null>(null);
    const heartbeatIntervalRef = useRef<number | null>(null);
    const destroyedRef = useRef(false);

    const screencastWidthRef = useRef(0);
    const screencastHeightRef = useRef(0);
    const lastFrameTimeRef = useRef(0);
    const lastFrameNotifyTimeRef = useRef(0);
    const firstFrameSeenRef = useRef(false);
    const lastClickRef = useRef<LastClickInfo | null>(null);
    const activeClickRef = useRef<{ button: number; count: number } | null>(null);
    const currentUrlRef = useRef<string>('');
    const activeRef = useRef(active);
    const screencastRunningRef = useRef(false);
    const pendingResponseHandlersRef = useRef<Map<number, (message: CdpMessage) => void>>(
      new Map(),
    );
    activeRef.current = active;

    const send = useCallback((method: string, params?: Record<string, unknown>) => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return null;

      const id = messageIdRef.current++;

      socket.send(
        JSON.stringify({
          id,
          method,
          params: params || {},
        }),
      );
      return id;
    }, []);

    const requestCurrentUrl = useCallback(
      (reason: string) => {
        const id = send('Runtime.evaluate', {
          expression: 'window.location.href',
          returnByValue: true,
        });
        if (id === null) return;

        pendingResponseHandlersRef.current.set(id, (message) => {
          const evalResult = message.result as { result?: { value?: unknown } } | undefined;
          const url = evalResult?.result?.value;
          if (typeof url !== 'string' || !url) return;

          if (url !== currentUrlRef.current) {
            currentUrlRef.current = url;
          }

          window.postMessage(
            {
              type: 'screencast:url-sync',
              pageId,
              url,
              reason,
            },
            '*',
          );
        });
      },
      [pageId, send],
    );

    const startScreencast = useCallback(
      (force = false) => {
        if (!activeRef.current) return;
        if (!force && screencastRunningRef.current) return;
        const requestId = send(
          'Page.startScreencast',
          SCREENCAST_OPTIONS as unknown as Record<string, unknown>,
        );
        if (requestId === null) return;
        screencastRunningRef.current = true;
        lastFrameTimeRef.current = Date.now();
      },
      [send],
    );

    const stopScreencast = useCallback(() => {
      if (!screencastRunningRef.current) return;
      send('Page.stopScreencast');
      screencastRunningRef.current = false;
    }, [send]);

    const emitMessage = useCallback((payload: Record<string, unknown>) => {
      window.postMessage(payload, '*');
    }, []);

    const clearHeartbeat = useCallback(() => {
      if (heartbeatIntervalRef.current) {
        window.clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
    }, []);

    const focusOverlay = useCallback(() => {
      const overlay = overlayRef.current;
      if (!overlay) return;
      window.requestAnimationFrame(() => {
        overlay.focus();
      });
    }, []);

    const startHeartbeat = useCallback(() => {
      clearHeartbeat();

      if (watchOnly) return;

      heartbeatIntervalRef.current = window.setInterval(() => {
        const socket = socketRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN) return;

        if (Date.now() - lastFrameTimeRef.current > 3000) {
          startScreencast(true);
        }
      }, 2000);
    }, [clearHeartbeat, startScreencast, watchOnly]);

    const toDeviceCoords = useCallback((clientX: number, clientY: number) => {
      const image = imageRef.current;
      const screencastWidth = screencastWidthRef.current;
      const screencastHeight = screencastHeightRef.current;

      if (!image || !screencastWidth || !screencastHeight) return null;

      const rect = image.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;

      const imageAspect = screencastWidth / screencastHeight;
      const boxAspect = rect.width / rect.height;

      let renderWidth = rect.width;
      let renderHeight = rect.height;
      let offsetX = 0;
      let offsetY = 0;

      if (imageAspect > boxAspect) {
        renderHeight = rect.width / imageAspect;
        offsetY = (rect.height - renderHeight) / 2;
      } else {
        renderWidth = rect.height * imageAspect;
        offsetX = (rect.width - renderWidth) / 2;
      }

      const x = ((clientX - rect.left - offsetX) / renderWidth) * screencastWidth;
      const y = ((clientY - rect.top - offsetY) / renderHeight) * screencastHeight;

      return { x: Math.round(x), y: Math.round(y) };
    }, []);

    const getModifiers = useCallback(
      (event: Pick<MouseEvent | KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>) => {
        let modifiers = 0;
        if (event.altKey) modifiers |= 1;
        if (event.ctrlKey) modifiers |= 2;
        if (event.metaKey) modifiers |= 4;
        if (event.shiftKey) modifiers |= 8;
        return modifiers;
      },
      [],
    );

    const connect = useCallback(() => {
      if (destroyedRef.current) return;

      const socket = new WebSocket(wsUrl);
      socketRef.current = socket;

      socket.onopen = () => {
        send('Page.enable');
        send('DOM.enable');
        send('Runtime.enable');
        send('Input.setIgnoreInputEvents', { ignore: false });
        send('Runtime.addBinding', { name: '__cdpEvent' });
        send('Page.addScriptToEvaluateOnNewDocument', { source: EVENT_TRACKING_SCRIPT });
        send('Runtime.evaluate', { expression: EVENT_TRACKING_SCRIPT });

        if (activeRef.current) {
          send('Page.bringToFront');
          startScreencast(true);
          startHeartbeat();
        }

        if (!watchOnly && activeRef.current) {
          focusOverlay();
        }

        // Populate URL early in case navigation happened before this listener attached.
        window.setTimeout(() => requestCurrentUrl('ws-open'), 250);
      };

      socket.onmessage = (event) => {
        let message: CdpMessage;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }

        if (typeof message.id === 'number') {
          const pending = pendingResponseHandlersRef.current.get(message.id);
          if (pending) {
            pendingResponseHandlersRef.current.delete(message.id);
            pending(message);
          }
          return;
        }

        if (message.method === 'Page.screencastFrame') {
          const params = (message.params || {}) as unknown as ScreencastFrameParams;

          if (typeof params.metadata?.deviceWidth === 'number') {
            screencastWidthRef.current = params.metadata.deviceWidth;
          }
          if (typeof params.metadata?.deviceHeight === 'number') {
            screencastHeightRef.current = params.metadata.deviceHeight;
          }

          lastFrameTimeRef.current = Date.now();
          setFrameSrc(`data:image/jpeg;base64,${params.data}`);

          send('Page.screencastFrameAck', { sessionId: params.sessionId });

          if (!firstFrameSeenRef.current) {
            firstFrameSeenRef.current = true;
            onFirstFrame?.(pageId);
          }

          const now = Date.now();
          if (now - lastFrameNotifyTimeRef.current > 1000) {
            lastFrameNotifyTimeRef.current = now;
            emitMessage({ type: 'screencast:frame-received', pageId });
          }

          return;
        }

        if (message.method === 'Runtime.bindingCalled') {
          const params = (message.params || {}) as unknown as RuntimeBindingCalledParams;
          if (params.name !== '__cdpEvent' || !params.payload) return;

          try {
            const data = JSON.parse(params.payload) as { type?: string };
            if (data.type === 'click' || data.type === 'keydown') {
              emitMessage({
                type: 'screencast:cdp-event',
                pageId,
                data,
              });
            }
          } catch {
            // Ignore malformed payloads from page runtime.
          }

          return;
        }

        if (message.method === 'Page.frameNavigated') {
          const params = (message.params || {}) as unknown as FrameNavigatedParams;
          const frame = params.frame;
          if (!frame || frame.parentId) return;

          if (typeof frame.url === 'string' && frame.url) {
            currentUrlRef.current = frame.url;
            emitMessage({
              type: 'screencast:url-sync',
              pageId,
              url: frame.url,
              reason: 'frame-navigated',
            });
          }

          emitMessage({
            type: 'screencast:frame-navigated',
            pageId,
            frame: {
              url: frame.url,
              id: frame.id,
              name: frame.name,
            },
          });
          return;
        }

        if (
          message.method === 'Page.loadEventFired' ||
          message.method === 'Page.domContentEventFired'
        ) {
          requestCurrentUrl(message.method);
          emitMessage({
            type: 'screencast:page-loaded',
            pageId,
            event: message.method,
          });
        }
      };

      socket.onclose = () => {
        clearHeartbeat();
        screencastRunningRef.current = false;
        pendingResponseHandlersRef.current.clear();

        if (destroyedRef.current) return;

        reconnectTimeoutRef.current = window.setTimeout(() => {
          connect();
        }, 2000);
      };

      socket.onerror = () => {
        // Error details are surfaced via the close/reconnect flow.
      };
    }, [
      clearHeartbeat,
      emitMessage,
      focusOverlay,
      onFirstFrame,
      pageId,
      requestCurrentUrl,
      send,
      startHeartbeat,
      startScreencast,
      watchOnly,
      wsUrl,
    ]);

    useEffect(() => {
      destroyedRef.current = false;
      connect();

      return () => {
        destroyedRef.current = true;
        clearHeartbeat();
        stopScreencast();

        if (reconnectTimeoutRef.current) {
          window.clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }

        const socket = socketRef.current;
        if (socket) {
          socket.close();
          socketRef.current = null;
        }
      };
    }, [clearHeartbeat, connect, stopScreencast]);

    useEffect(() => {
      if (active) {
        send('Page.bringToFront');
        startScreencast(true);
        startHeartbeat();
        if (!watchOnly) {
          focusOverlay();
        }
        return;
      }

      if (overlayRef.current === document.activeElement) {
        overlayRef.current?.blur();
      }
      clearHeartbeat();
      stopScreencast();
    }, [
      active,
      clearHeartbeat,
      focusOverlay,
      send,
      startHeartbeat,
      startScreencast,
      stopScreencast,
      watchOnly,
    ]);

    useImperativeHandle(
      ref,
      () => ({
        getCurrentFrameDataUrl: () => frameSrc,
      }),
      [frameSrc],
    );

    const getButtonName = useCallback((button: number) => {
      if (button === 1) return 'middle';
      if (button === 2) return 'right';
      return 'left';
    }, []);

    const getButtonMask = useCallback((button: number) => {
      if (button === 0) return 1;
      if (button === 1) return 4;
      if (button === 2) return 2;
      return 0;
    }, []);

    const maybePreventDefault = useCallback(
      (event: PreventableEvent, source: string, details?: Record<string, unknown>) => {
        const nativeEvent = event.nativeEvent;
        if (!nativeEvent.cancelable) {
          const target = nativeEvent.target as HTMLElement | null;
          const currentTarget = nativeEvent.currentTarget as HTMLElement | null;

          console.error('[RemoteCdpPlayer] Non-cancelable event; preventDefault skipped', {
            source,
            pageId,
            wsUrl,
            active,
            watchOnly,
            eventType: nativeEvent.type || event.type,
            cancelable: nativeEvent.cancelable,
            defaultPrevented: nativeEvent.defaultPrevented,
            isTrusted: nativeEvent.isTrusted,
            timeStamp: event.timeStamp,
            targetTag: target?.tagName ?? null,
            targetClass: target?.className ?? null,
            currentTargetTag: currentTarget?.tagName ?? null,
            ...details,
          });
          return false;
        }

        event.preventDefault();
        return true;
      },
      [active, pageId, watchOnly, wsUrl],
    );

    const inputDisabled = useMemo(() => watchOnly || !active, [active, watchOnly]);

    const sendMouseEvent = useCallback(
      (
        type: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel',
        event: {
          clientX: number;
          clientY: number;
          button?: number;
          deltaX?: number;
          deltaY?: number;
          altKey: boolean;
          ctrlKey: boolean;
          metaKey: boolean;
          shiftKey: boolean;
        },
        clickCountOverride?: number,
      ) => {
        if (!active) return;
        const coords = toDeviceCoords(event.clientX, event.clientY);
        if (!coords) return;

        const params: Record<string, unknown> = {
          type,
          x: coords.x,
          y: coords.y,
          modifiers: getModifiers(event),
        };

        if (type === 'mousePressed' || type === 'mouseReleased') {
          const button = typeof event.button === 'number' ? event.button : 0;
          params.button = getButtonName(button);
          params.buttons = type === 'mouseReleased' ? 0 : getButtonMask(button);
          params.clickCount = clickCountOverride ?? 1;
        } else if (type === 'mouseWheel') {
          params.deltaX = event.deltaX ?? 0;
          params.deltaY = event.deltaY ?? 0;
        }

        send('Input.dispatchMouseEvent', params);
      },
      [active, getButtonMask, getButtonName, getModifiers, send, toDeviceCoords],
    );

    return (
      <Box position="absolute" inset={0} bg="white" overflow="hidden">
        <img
          ref={imageRef}
          id="screencast"
          src={frameSrc || ''}
          alt="Remote browser screencast"
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            display: 'block',
            userSelect: 'none',
          }}
          draggable={false}
        />
        <Box
          ref={overlayRef}
          tabIndex={inputDisabled ? -1 : 0}
          position="absolute"
          inset={0}
          outline="none"
          _focus={{ outline: 'none' }}
          _focusVisible={{ outline: 'none' }}
          cursor={inputDisabled ? 'default' : 'default'}
          pointerEvents={inputDisabled ? 'none' : 'auto'}
          onMouseDown={(event) => {
            maybePreventDefault(event, 'onMouseDown', {
              button: event.nativeEvent.button,
              clientX: event.nativeEvent.clientX,
              clientY: event.nativeEvent.clientY,
            });
            const button = event.nativeEvent.button ?? 0;
            const now = Date.now();
            const previous = lastClickRef.current;

            let clickCount = 1;
            if (
              previous &&
              previous.button === button &&
              now - previous.time <= DOUBLE_CLICK_WINDOW_MS
            ) {
              const dx = event.nativeEvent.clientX - previous.x;
              const dy = event.nativeEvent.clientY - previous.y;
              const maxDistanceSq = DOUBLE_CLICK_MAX_DISTANCE_PX * DOUBLE_CLICK_MAX_DISTANCE_PX;
              if (dx * dx + dy * dy <= maxDistanceSq) {
                clickCount = Math.min(previous.count + 1, 3);
              }
            }

            activeClickRef.current = { button, count: clickCount };
            lastClickRef.current = {
              button,
              count: clickCount,
              x: event.nativeEvent.clientX,
              y: event.nativeEvent.clientY,
              time: now,
            };

            sendMouseEvent('mousePressed', event.nativeEvent, clickCount);
          }}
          onMouseUp={(event) => {
            maybePreventDefault(event, 'onMouseUp', {
              button: event.nativeEvent.button,
              clientX: event.nativeEvent.clientX,
              clientY: event.nativeEvent.clientY,
            });
            const button = event.nativeEvent.button ?? 0;
            const activeClick = activeClickRef.current;
            const clickCount = activeClick && activeClick.button === button ? activeClick.count : 1;
            sendMouseEvent('mouseReleased', event.nativeEvent, clickCount);
            activeClickRef.current = null;
          }}
          onMouseMove={(event) => {
            sendMouseEvent('mouseMoved', event.nativeEvent);
          }}
          onWheel={(event) => {
            maybePreventDefault(event, 'onWheel', {
              deltaX: event.nativeEvent.deltaX,
              deltaY: event.nativeEvent.deltaY,
              deltaMode: event.nativeEvent.deltaMode,
              clientX: event.nativeEvent.clientX,
              clientY: event.nativeEvent.clientY,
            });
            sendMouseEvent('mouseWheel', event.nativeEvent);
          }}
          onKeyDown={(event) => {
            if (!active) return;
            maybePreventDefault(event, 'onKeyDown', {
              key: event.key,
              code: event.code,
            });
            if (MODIFIER_KEYS[event.key]) return;

            const text = event.key.length === 1 ? event.key : SPECIAL_KEY_TEXT[event.key] || '';

            send('Input.dispatchKeyEvent', {
              type: text ? 'keyDown' : 'rawKeyDown',
              key: event.key,
              code: event.code,
              windowsVirtualKeyCode: event.keyCode,
              nativeVirtualKeyCode: event.keyCode,
              modifiers: getModifiers(event.nativeEvent),
              text,
              unmodifiedText: text,
            });
          }}
          onKeyUp={(event) => {
            if (!active) return;
            maybePreventDefault(event, 'onKeyUp', {
              key: event.key,
              code: event.code,
            });
            if (MODIFIER_KEYS[event.key]) return;

            send('Input.dispatchKeyEvent', {
              type: 'keyUp',
              key: event.key,
              code: event.code,
              windowsVirtualKeyCode: event.keyCode,
              nativeVirtualKeyCode: event.keyCode,
              modifiers: getModifiers(event.nativeEvent),
            });
          }}
          onClick={() => {
            if (!inputDisabled) {
              overlayRef.current?.focus();
            }
          }}
          onContextMenu={(event) => event.preventDefault()}
        />
      </Box>
    );
  },
);

RemoteCdpPlayer.displayName = 'RemoteCdpPlayer';

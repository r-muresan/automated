'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type Protocol from 'devtools-protocol';

type CDPMethod = string;
type CDPParams = Record<string, unknown>;
type CDPResult = Record<string, unknown>;

interface CDPMessage {
  id: number;
  sessionId?: string;
  method?: CDPMethod;
  params?: CDPParams;
  result?: CDPResult;
  error?: { code: number; message: string };
}

interface PendingRequest {
  resolve: (result: CDPResult) => void;
  reject: (error: Error) => void;
}

interface BrowserCDPState {
  isConnected: boolean;
  error: string | null;
}

export interface Interaction {
  id: string;
  type: 'user_event' | 'tab_navigation' | 'frame_navigation';
  timestamp: number;
  pageId: string;
  screenshotUrl?: string;
  transcript?: string;
  element: {
    tagName?: string;
    text?: string;
    selector?: string;
    href?: string;
    [key: string]: any;
  };
  data?: any;
}

export interface InteractionCallbacks {
  onInteraction?: (interaction: Interaction) => void;
  onFrameNavigation?: (url: string, frameId: string, pageId: string) => void;
  onTitleUpdate?: (title: string, pageId: string) => void;
  onFaviconUpdate?: (faviconUrl: string, pageId: string) => void;
  onNewTabDetected?: (targetId: string, url: string) => void;
  onWebSocketDisconnected?: () => void;
}

interface UseBrowserCDPReturn extends BrowserCDPState {
  // Tab management
  createTarget: (url?: string) => Promise<Protocol.Target.CreateTargetResponse>;
  closeTarget: (targetId: string) => Promise<Protocol.Target.CloseTargetResponse>;
  getTargets: () => Promise<Protocol.Target.GetTargetsResponse>;
  activateTarget: (targetId: string) => Promise<void>;

  // Navigation
  navigate: (targetId: string, url: string) => Promise<Protocol.Page.NavigateResponse>;
  goBack: (targetId: string) => Promise<void>;
  goForward: (targetId: string) => Promise<void>;
  reload: (targetId: string) => Promise<void>;

  // DOM interaction
  focusElement: (targetId: string, selector: string, maxAttempts?: number) => Promise<boolean>;

  // Generic CDP commands
  send: <T = CDPResult>(method: CDPMethod, params?: CDPParams) => Promise<T>;
  sendToPage: <T = CDPResult>(
    targetId: string,
    method: CDPMethod,
    params?: CDPParams,
  ) => Promise<T>;

  // Connection management
  connect: (pageId: string) => void;
  connectToPage: (pageId: string) => void;
  ensurePageConnections: (pageIds: string[]) => void;
  disconnect: () => void;

  // Interactions
  interactions: Interaction[];
  clearInteractions: () => void;
  removeInteraction: (id: string) => void;
  addInteraction: (
    type: Interaction['type'],
    element: Interaction['element'],
    pageId?: string,
    data?: any,
  ) => void;
}

/**
 * Hook for sending CDP commands to control the browser.
 *
 * Target domain commands (createTarget, closeTarget, etc.) are browser-level
 * but can be sent through any page's WebSocket connection - CDP routes them
 * to the browser automatically.
 */
// Default to Browserbase URL pattern if no template provided
const DEFAULT_CDP_WS_TEMPLATE = (sessionId: string) =>
  `wss://connect.browserbase.com/debug/${sessionId}/devtools/page/{pageId}`;
const LATEST_SCREENCAST_FRAMES_KEY = '__cuaLatestScreencastFrameByPage';
const CLICK_SCREENSHOT_REUSE_WINDOW_MS = 400;

const clampNumber = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

// Script injected into pages to report click/keydown events through the
// __cdpEvent Runtime binding.
const EVENT_TRACKING_SCRIPT = `(function() {
  if (window.__bbEventListenerInjected) return;
  window.__bbEventListenerInjected = true;
  function reportEvent(data) {
    if (typeof window.__cdpEvent === 'function') {
      try { window.__cdpEvent(JSON.stringify(data)); } catch(e) {}
    }
  }
  function getElementSelector(el) {
    if (!el) return '';
    if (el.id) return '#' + el.id;
    var path = [];
    while (el && el.nodeType === 1) {
      var s = el.nodeName.toLowerCase();
      if (el.className && typeof el.className === 'string') {
        s += '.' + el.className.trim().split(/\\s+/).join('.');
      }
      path.unshift(s);
      el = el.parentNode;
      if (path.length > 3) break;
    }
    return path.join(' > ');
  }
  function getElementInfo(el) {
    if (!el) return null;
    return {
      tagName: el.tagName || 'unknown',
      id: el.id || '',
      className: el.className || '',
      selector: getElementSelector(el),
      text: (el.textContent || '').substring(0, 200),
      value: el.value || '',
      href: el.href || '',
      type: el.type || '',
      name: el.name || ''
    };
  }
  document.addEventListener('click', function(e) {
    reportEvent({ type: 'click', x: e.clientX, y: e.clientY, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1, target: getElementInfo(e.target), timestamp: Date.now() });
  }, true);
  document.addEventListener('keydown', function(e) {
    reportEvent({ type: 'keydown', key: e.key, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, target: getElementInfo(e.target), timestamp: Date.now() });
  }, true);
})()`;

export function useBrowserCDP(
  sessionId: string | null,
  initialPageId?: string,
  callbacks?: InteractionCallbacks,
  cdpWsUrlTemplate?: string | null,
): UseBrowserCDPReturn {
  const usesBrowserLevelCdp = Boolean(
    cdpWsUrlTemplate && !cdpWsUrlTemplate.includes('{pageId}'),
  );
  const [state, setState] = useState<BrowserCDPState>({
    isConnected: false,
    error: null,
  });

  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const callbacksRef = useRef(callbacks);

  // Keep callbacks ref updated
  useEffect(() => {
    callbacksRef.current = callbacks;
  }, [callbacks]);

  // Refs for grouping keypresses
  const typingBufferRef = useRef<{
    interactionId: string;
    text: string;
    lastTimestamp: number;
    selector: string;
  } | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const currentPageIdRef = useRef<string | null>(null);
  const messageIdRef = useRef(1);
  const pendingRequestsRef = useRef<Map<number, PendingRequest>>(new Map());
  const pageSessionsRef = useRef<Map<string, WebSocket>>(new Map());
  const pageTargetSessionIdsRef = useRef<Map<string, string>>(new Map());
  const targetPageIdsBySessionRef = useRef<Map<string, string>>(new Map());
  const pendingTargetAttachmentRef = useRef<Map<string, Promise<string>>>(new Map());
  const knownPageIdsRef = useRef<Set<string>>(new Set());
  const injectedPagesRef = useRef<Set<string>>(new Set());
  const lastRawScreenshotByPageRef = useRef<
    Map<string, { timestamp: number; screenshotUrl: string }>
  >(new Map());
  const pendingRawScreenshotByPageRef = useRef<Map<string, Promise<string | null>>>(new Map());

  // Throttling refs for interaction events
  const lastNavigationRefreshByPageRef = useRef<Map<string, number>>(new Map());
  const lastClickTimestampRef = useRef<number>(0);

  // Handler refs (set later, used in connectToPage)
  const addInteractionRef = useRef<
    | ((
        type: Interaction['type'],
        element: Interaction['element'],
        pageId?: string,
        data?: any,
      ) => void)
    | null
  >(null);
  const handleKeydownRef = useRef<((eventData: any, pageId?: string) => void) | null>(null);

  const queryPageMetadata = useCallback(
    async (
      pageId: string,
      options?: { includeUrl?: boolean; includeTitle?: boolean; includeFavicon?: boolean },
    ) => {
      const includeUrl = options?.includeUrl ?? true;
      const includeTitle = options?.includeTitle ?? true;
      const includeFavicon = options?.includeFavicon ?? true;

      if (usesBrowserLevelCdp) {
        try {
          const attachedSessionId = await attachToTargetSession(pageId);
          const requests: Array<Promise<void>> = [];

          if (includeUrl) {
            requests.push(
              sendToAttachedTarget<{ result?: { result?: { value?: string } } }>(
                attachedSessionId,
                'Runtime.evaluate',
                { expression: 'window.location.href', returnByValue: true },
              ).then((response) => {
                const url = response.result?.result?.value;
                if (typeof url === 'string' && url && callbacksRef.current?.onFrameNavigation) {
                  callbacksRef.current.onFrameNavigation(url, pageId, pageId);
                }
              }),
            );
          }

          if (includeTitle) {
            requests.push(
              sendToAttachedTarget<{ result?: { result?: { value?: string } } }>(
                attachedSessionId,
                'Runtime.evaluate',
                { expression: 'document.title', returnByValue: true },
              ).then((response) => {
                const title = response.result?.result?.value;
                if (title && callbacksRef.current?.onTitleUpdate) {
                  callbacksRef.current.onTitleUpdate(title, pageId);
                }
              }),
            );
          }

          if (includeFavicon) {
            requests.push(
              sendToAttachedTarget<{ result?: { result?: { value?: string } } }>(
                attachedSessionId,
                'Runtime.evaluate',
                {
                  expression: `(function() { var link = document.querySelector('link[rel~="icon"]'); return link ? link.href : (location.origin + '/favicon.ico'); })()`,
                  returnByValue: true,
                },
              ).then((response) => {
                const faviconUrl = response.result?.result?.value;
                if (faviconUrl && callbacksRef.current?.onFaviconUpdate) {
                  callbacksRef.current.onFaviconUpdate(faviconUrl, pageId);
                }
              }),
            );
          }

          await Promise.allSettled(requests);
        } catch (error) {
          console.warn('[CDP] Failed to query page metadata over browser-level CDP:', error);
        }
        return;
      }

      const ws = pageSessionsRef.current.get(pageId);
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      const urlMsgId = includeUrl ? messageIdRef.current++ : null;
      const titleMsgId = includeTitle ? messageIdRef.current++ : null;
      const faviconMsgId = includeFavicon ? messageIdRef.current++ : null;

      if (urlMsgId === null && titleMsgId === null && faviconMsgId === null) return;

      const handler = (event: MessageEvent) => {
        try {
          const response = JSON.parse(event.data);

          if (urlMsgId !== null && response.id === urlMsgId) {
            const url = response.result?.result?.value;
            if (typeof url === 'string' && url && callbacksRef.current?.onFrameNavigation) {
              callbacksRef.current.onFrameNavigation(url, pageId, pageId);
            }
          }

          if (titleMsgId !== null && response.id === titleMsgId) {
            const title = response.result?.result?.value;
            if (title && callbacksRef.current?.onTitleUpdate) {
              callbacksRef.current.onTitleUpdate(title, pageId);
            }
          }

          if (faviconMsgId !== null && response.id === faviconMsgId) {
            const faviconUrl = response.result?.result?.value;
            if (faviconUrl && callbacksRef.current?.onFaviconUpdate) {
              callbacksRef.current.onFaviconUpdate(faviconUrl, pageId);
            }
          }
        } catch {
          // Ignore parse errors
        }
      };

      ws.addEventListener('message', handler);
      setTimeout(() => ws.removeEventListener('message', handler), 5000);

      if (urlMsgId !== null) {
        ws.send(
          JSON.stringify({
            id: urlMsgId,
            method: 'Runtime.evaluate',
            params: { expression: 'window.location.href', returnByValue: true },
          }),
        );
      }
      if (titleMsgId !== null) {
        ws.send(
          JSON.stringify({
            id: titleMsgId,
            method: 'Runtime.evaluate',
            params: { expression: 'document.title', returnByValue: true },
          }),
        );
      }
      if (faviconMsgId !== null) {
        ws.send(
          JSON.stringify({
            id: faviconMsgId,
            method: 'Runtime.evaluate',
            params: {
              expression: `(function() { var link = document.querySelector('link[rel~="icon"]'); return link ? link.href : (location.origin + '/favicon.ico'); })()`,
              returnByValue: true,
            },
          }),
        );
      }
    },
    [usesBrowserLevelCdp],
  );

  const connectToPage = useCallback(
    (pageId: string) => {
      if (!sessionId) return;

      knownPageIdsRef.current.add(pageId);

      if (usesBrowserLevelCdp) {
        void attachToTargetSession(pageId)
          .then(() => {
            void queryPageMetadata(pageId);
          })
          .catch((error) => {
            console.warn(`[CDP] Failed to attach to target ${pageId}:`, error);
          });
        return;
      }

      const existingWs = pageSessionsRef.current.get(pageId);
      if (
        existingWs?.readyState === WebSocket.OPEN ||
        existingWs?.readyState === WebSocket.CONNECTING
      ) {
        console.log(`[CDP] WebSocket already open/connecting for page ${pageId}`);
        return;
      }

      const template = cdpWsUrlTemplate || DEFAULT_CDP_WS_TEMPLATE(sessionId);
      const wsUrl = template.replace('{pageId}', pageId);
      console.log(`[CDP] Connecting WebSocket for page ${pageId}:`, wsUrl);

      const ws = new WebSocket(wsUrl);
      pageSessionsRef.current.set(pageId, ws);
      let msgId = 1000;

      ws.onopen = () => {
        console.log(`[CDP] WebSocket connected for page ${pageId}`);

        // Enable Page (for navigation events) and Runtime (required for
        // Runtime.bindingCalled delivery). DOM.enable is omitted — it is
        // not needed for event tracking and adds noise.
        // Note: Runtime.enable on a CDP debugging session is invisible to
        // web-page JavaScript, so it does NOT affect bot detection.
        ws.send(JSON.stringify({ id: msgId++, method: 'Page.enable' }));
        ws.send(JSON.stringify({ id: msgId++, method: 'Runtime.enable' }));
        ws.send(
          JSON.stringify({
            id: msgId++,
            method: 'Runtime.addBinding',
            params: { name: '__cdpEvent' },
          }),
        );
        if (!injectedPagesRef.current.has(pageId)) {
          // Inject listeners for current and future documents so interaction
          // recording works even when the screencast renderer is a proxy iframe.
          ws.send(
            JSON.stringify({
              id: msgId++,
              method: 'Page.addScriptToEvaluateOnNewDocument',
              params: { source: EVENT_TRACKING_SCRIPT },
            }),
          );
          ws.send(
            JSON.stringify({
              id: msgId++,
              method: 'Runtime.evaluate',
              params: { expression: EVENT_TRACKING_SCRIPT },
            }),
          );
          injectedPagesRef.current.add(pageId);
        }

        // Ensure URL/title/favicon are populated even if Page.frameNavigated
        // fired before this WebSocket listener was attached.
        setTimeout(() => {
          void queryPageMetadata(pageId);
        }, 250);
      };

      ws.onclose = (event) => {
        console.log(`[CDP] WebSocket closed for page ${pageId}:`, event.code, event.reason);
        pageSessionsRef.current.delete(pageId);
        injectedPagesRef.current.delete(pageId);

        // Check if all page connections are lost
        const hasActiveConnections = Array.from(pageSessionsRef.current.values()).some(
          (ws) => ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING,
        );

        // If no active connections and this wasn't a clean close, trigger reconnect callback
        if (
          !hasActiveConnections &&
          event.code !== 1000 &&
          callbacksRef.current?.onWebSocketDisconnected
        ) {
          console.log('[CDP] All WebSocket connections lost, triggering disconnect callback');
          callbacksRef.current.onWebSocketDisconnected();
        }
      };

      ws.onerror = (error) => {
        console.error(`[CDP] WebSocket error for page ${pageId}:`, error);
      };

      ws.onmessage = (event) => {
        try {
          const message: CDPMessage = JSON.parse(event.data);

          // Handle pending CDP command responses
          if (message.id !== undefined) {
            const pending = pendingRequestsRef.current.get(message.id);
            if (pending) {
              pendingRequestsRef.current.delete(message.id);
              if (message.error) {
                pending.reject(new Error(message.error.message));
              } else {
                pending.resolve(message.result || {});
              }
            }
          }

          // Handle interaction events via Runtime.bindingCalled (stealth
          // alternative to Runtime.consoleAPICalled).
          if (
            message.method === 'Runtime.bindingCalled' &&
            (message.params as Record<string, unknown>)?.name === '__cdpEvent'
          ) {
            try {
              const eventData = JSON.parse(
                ((message.params as Record<string, unknown>)?.payload as string) || '{}',
              );
              const now = Date.now();

              if (eventData.type === 'keydown') {
                handleKeydownRef.current?.(eventData, pageId);
              } else if (eventData.type === 'click') {
                // Deduplicate clicks within 100ms to prevent duplicate events
                if (now - lastClickTimestampRef.current < 100) {
                  return;
                }
                lastClickTimestampRef.current = now;
                addInteractionRef.current?.(
                  'user_event',
                  eventData.target || {
                    tagName: 'CLICK',
                    text: 'click',
                    selector: 'unknown',
                  },
                  pageId,
                  eventData,
                );
              }
            } catch (e) {
              console.warn('[CDP] Failed to parse binding event:', e);
            }
          }

          // Handle page load events - re-query title when page finishes loading
          if (
            message.method === 'Page.loadEventFired' ||
            message.method === 'Page.domContentEventFired'
          ) {
            console.log(
              `[CDP] ${message.method} fired for page ${pageId}, querying URL/title/favicon`,
            );
            void queryPageMetadata(pageId);
          }

          // Handle frame navigation events
          if (message.method === 'Page.frameNavigated') {
            const frame = (message.params as any)?.frame;
            // Only handle main frame navigations (parentId is undefined for main frame)
            if (frame && !frame.parentId) {
              const now = Date.now();
              const lastNavigationAt = lastNavigationRefreshByPageRef.current.get(pageId) || 0;
              if (now - lastNavigationAt > 1000) {
                lastNavigationRefreshByPageRef.current.set(pageId, now);
                addInteractionRef.current?.(
                  'frame_navigation',
                  {
                    tagName: 'FRAME_NAVIGATION',
                    text: `Navigated to ${frame.url}`,
                    selector: frame.id,
                    href: frame.url,
                  },
                  pageId,
                  {
                    url: frame.url,
                    frameId: frame.id,
                    name: frame.name,
                    pageId,
                  },
                );

                // Immediately notify with URL (title will come later)
                if (callbacksRef.current?.onFrameNavigation) {
                  callbacksRef.current.onFrameNavigation(frame.url, frame.id, pageId);
                }

                // Query title and favicon after a short delay to let the page load
                setTimeout(() => {
                  console.log(
                    `[CDP] 500ms fast-path: querying URL/title/favicon for page ${pageId}`,
                  );
                  void queryPageMetadata(pageId);
                }, 500);
              }
            }
          }
        } catch (e) {
          console.warn('[CDP] Failed to parse message:', e);
        }
      };
    },
    [sessionId, cdpWsUrlTemplate, queryPageMetadata, usesBrowserLevelCdp],
  );

  const ensurePageConnections = useCallback(
    (pageIds: string[]) => {
      if (!sessionId) return;

      console.log('[CDP] Ensuring connections for pages:', pageIds);

      pageIds.forEach((pageId) => {
        knownPageIdsRef.current.add(pageId);
        if (usesBrowserLevelCdp) {
          connectToPage(pageId);
          return;
        }
        const existingWs = pageSessionsRef.current.get(pageId);
        const isConnected =
          existingWs?.readyState === WebSocket.OPEN ||
          existingWs?.readyState === WebSocket.CONNECTING;
        if (!isConnected) {
          connectToPage(pageId);
        }
      });

      const removedPages = Array.from(knownPageIdsRef.current).filter(
        (id) => !pageIds.includes(id),
      );
      removedPages.forEach((pageId) => {
        knownPageIdsRef.current.delete(pageId);
        const attachedSessionId = pageTargetSessionIdsRef.current.get(pageId);
        if (attachedSessionId) {
          pageTargetSessionIdsRef.current.delete(pageId);
          targetPageIdsBySessionRef.current.delete(attachedSessionId);
          pendingTargetAttachmentRef.current.delete(pageId);
          if (usesBrowserLevelCdp && wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(
              JSON.stringify({
                id: messageIdRef.current++,
                method: 'Target.detachFromTarget',
                params: { sessionId: attachedSessionId },
              }),
            );
          }
        }
        const ws = pageSessionsRef.current.get(pageId);
        if (ws) {
          ws.close();
          pageSessionsRef.current.delete(pageId);
        }
      });
    },
    [sessionId, connectToPage, usesBrowserLevelCdp],
  );

  const connect = useCallback(
    (pageId: string) => {
      if (!sessionId) return;

      if (wsRef.current?.readyState === WebSocket.OPEN && currentPageIdRef.current === pageId) {
        return;
      }

      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }

      currentPageIdRef.current = pageId;

      const template = cdpWsUrlTemplate || DEFAULT_CDP_WS_TEMPLATE(sessionId);
      const wsUrl = template.replace('{pageId}', pageId);
      console.log('[CDP] Connecting to page WebSocket for browser commands:', wsUrl);

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[CDP] Page WebSocket connected (for browser commands)');
        setState({ isConnected: true, error: null });

        // Enable target discovery to detect new tabs (e.g. target="_blank" links)
        const discoverMsgId = messageIdRef.current++;
        ws.send(
          JSON.stringify({
            id: discoverMsgId,
            method: 'Target.setDiscoverTargets',
            params: { discover: true },
          }),
        );
      };

      ws.onclose = (event) => {
        console.log('[CDP] Page WebSocket closed:', event.code, event.reason);
        if (currentPageIdRef.current === pageId) {
          setState({ isConnected: false, error: null });
          wsRef.current = null;
          currentPageIdRef.current = null;
          pageTargetSessionIdsRef.current.clear();
          targetPageIdsBySessionRef.current.clear();
          pendingTargetAttachmentRef.current.clear();

          // If this wasn't a clean close, trigger disconnect callback
          if (event.code !== 1000 && callbacksRef.current?.onWebSocketDisconnected) {
            console.log('[CDP] Main WebSocket connection lost, triggering disconnect callback');
            callbacksRef.current.onWebSocketDisconnected();
          }
        }
      };

      ws.onerror = (error) => {
        console.error('[CDP] Page WebSocket error:', error);
        setState({ isConnected: false, error: 'WebSocket connection error' });
      };

      ws.onmessage = (event) => {
        try {
          const message: CDPMessage = JSON.parse(event.data);

          if (message.id !== undefined) {
            const pending = pendingRequestsRef.current.get(message.id);
            if (pending) {
              pendingRequestsRef.current.delete(message.id);
              if (message.error) {
                pending.reject(new Error(message.error.message));
              } else {
                pending.resolve(message.result || {});
              }
            }
          }

          if (usesBrowserLevelCdp && typeof message.sessionId === 'string') {
            const targetPageId = targetPageIdsBySessionRef.current.get(message.sessionId) || '';

            if (
              message.method === 'Runtime.bindingCalled' &&
              (message.params as Record<string, unknown>)?.name === '__cdpEvent'
            ) {
              try {
                const eventData = JSON.parse(
                  ((message.params as Record<string, unknown>)?.payload as string) || '{}',
                );
                const now = Date.now();

                if (eventData.type === 'keydown') {
                  handleKeydownRef.current?.(eventData, targetPageId);
                } else if (eventData.type === 'click') {
                  if (now - lastClickTimestampRef.current < 100) {
                    return;
                  }
                  lastClickTimestampRef.current = now;
                  addInteractionRef.current?.(
                    'user_event',
                    eventData.target || {
                      tagName: 'CLICK',
                      text: 'click',
                      selector: 'unknown',
                    },
                    targetPageId,
                    eventData,
                  );
                }
              } catch (e) {
                console.warn('[CDP] Failed to parse binding event:', e);
              }
              return;
            }

            if (
              message.method === 'Page.loadEventFired' ||
              message.method === 'Page.domContentEventFired'
            ) {
              if (targetPageId) {
                console.log(
                  `[CDP] ${message.method} fired for page ${targetPageId}, querying URL/title/favicon`,
                );
                void queryPageMetadata(targetPageId);
              }
              return;
            }

            if (message.method === 'Page.frameNavigated') {
              const frame = (message.params as any)?.frame;
              if (frame && !frame.parentId && targetPageId) {
                const now = Date.now();
                const lastNavigationAt =
                  lastNavigationRefreshByPageRef.current.get(targetPageId) || 0;
                if (now - lastNavigationAt > 1000) {
                  lastNavigationRefreshByPageRef.current.set(targetPageId, now);
                  addInteractionRef.current?.(
                    'frame_navigation',
                    {
                      tagName: 'FRAME_NAVIGATION',
                      text: `Navigated to ${frame.url}`,
                      selector: frame.id,
                      href: frame.url,
                    },
                    targetPageId,
                    {
                      url: frame.url,
                      frameId: frame.id,
                      name: frame.name,
                      pageId: targetPageId,
                    },
                  );

                  if (callbacksRef.current?.onFrameNavigation) {
                    callbacksRef.current.onFrameNavigation(frame.url, frame.id, targetPageId);
                  }

                  setTimeout(() => {
                    console.log(
                      `[CDP] 500ms fast-path: querying URL/title/favicon for page ${targetPageId}`,
                    );
                    void queryPageMetadata(targetPageId);
                  }, 500);
                }
              }
              return;
            }
          }

          // Detect new tabs opened via target="_blank" or window.open
          if (message.method === 'Target.targetCreated') {
            const targetInfo = (message.params as any)?.targetInfo;
            if (targetInfo?.type === 'page' && !knownPageIdsRef.current.has(targetInfo.targetId)) {
              console.log('[CDP] New tab detected:', targetInfo.targetId, targetInfo.url);
              if (callbacksRef.current?.onNewTabDetected) {
                callbacksRef.current.onNewTabDetected(
                  targetInfo.targetId,
                  targetInfo.url || 'about:blank',
                );
              }
            }
          }
        } catch (e) {
          console.warn('[CDP] Failed to parse message:', e);
        }
      };

      // Note: connectToPage is called separately via ensurePageConnections
      // to avoid duplicate connections
    },
    [sessionId, cdpWsUrlTemplate, queryPageMetadata, usesBrowserLevelCdp],
  );

  const disconnect = useCallback(() => {
    pageSessionsRef.current.forEach((ws) => ws.close());
    pageSessionsRef.current.clear();
    pageTargetSessionIdsRef.current.clear();
    targetPageIdsBySessionRef.current.clear();
    pendingTargetAttachmentRef.current.clear();

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    currentPageIdRef.current = null;
    setState({ isConnected: false, error: null });
  }, []);

  useEffect(() => {
    if (sessionId && initialPageId) {
      connect(initialPageId);
    } else if (!sessionId) {
      disconnect();
    }

    return () => disconnect();
  }, [sessionId, initialPageId, connect, disconnect]);

  useEffect(() => {
    if (!sessionId) return;

    const knownPages = Array.from(knownPageIdsRef.current);
    if (knownPages.length > 0) {
      console.log('[CDP] Reconnecting to known pages:', knownPages);
      knownPages.forEach((pageId) => {
        const existingWs = pageSessionsRef.current.get(pageId);
        if (!existingWs || existingWs.readyState !== WebSocket.OPEN) {
          connectToPage(pageId);
        }
      });
    }
  }, [sessionId, connectToPage]);

  const send = useCallback(<T = CDPResult>(method: CDPMethod, params?: CDPParams): Promise<T> => {
    return new Promise((resolve, reject) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const id = messageIdRef.current++;
      const message: CDPMessage = { id, method, params };

      pendingRequestsRef.current.set(id, {
        resolve: resolve as (result: CDPResult) => void,
        reject,
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        if (pendingRequestsRef.current.has(id)) {
          pendingRequestsRef.current.delete(id);
          reject(new Error(`CDP command timeout: ${method}`));
        }
      }, 30000);

      wsRef.current.send(JSON.stringify(message));
    });
  }, []);

  const sendToAttachedTarget = useCallback(
    async <T = CDPResult>(
      targetSessionId: string,
      method: CDPMethod,
      params?: CDPParams,
    ): Promise<T> => {
      return new Promise((resolve, reject) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          reject(new Error('Main WebSocket not connected'));
          return;
        }

        const id = messageIdRef.current++;
        const message: CDPMessage = { id, sessionId: targetSessionId, method, params };

        pendingRequestsRef.current.set(id, {
          resolve: resolve as (result: CDPResult) => void,
          reject,
        });

        setTimeout(() => {
          if (pendingRequestsRef.current.has(id)) {
            pendingRequestsRef.current.delete(id);
            reject(new Error(`CDP target command timeout: ${method}`));
          }
        }, 30000);

        wsRef.current.send(JSON.stringify(message));
      });
    },
    [],
  );

  const attachToTargetSession = useCallback(
    async (targetId: string): Promise<string> => {
      if (!usesBrowserLevelCdp) {
        return targetId;
      }

      const existingSessionId = pageTargetSessionIdsRef.current.get(targetId);
      if (existingSessionId) {
        return existingSessionId;
      }

      const pendingAttachment = pendingTargetAttachmentRef.current.get(targetId);
      if (pendingAttachment) {
        return pendingAttachment;
      }

      const attachmentPromise = (async () => {
        const response = await send<{ sessionId?: string }>('Target.attachToTarget', {
          targetId,
          flatten: true,
        });
        const attachedSessionId = response.sessionId;
        if (!attachedSessionId) {
          throw new Error(`Target.attachToTarget did not return a sessionId for ${targetId}`);
        }

        pageTargetSessionIdsRef.current.set(targetId, attachedSessionId);
        targetPageIdsBySessionRef.current.set(attachedSessionId, targetId);

        await sendToAttachedTarget(attachedSessionId, 'Page.enable');
        await sendToAttachedTarget(attachedSessionId, 'Runtime.enable');
        await sendToAttachedTarget(attachedSessionId, 'Runtime.addBinding', {
          name: '__cdpEvent',
        });

        if (!injectedPagesRef.current.has(targetId)) {
          await sendToAttachedTarget(attachedSessionId, 'Page.addScriptToEvaluateOnNewDocument', {
            source: EVENT_TRACKING_SCRIPT,
          });
          await sendToAttachedTarget(attachedSessionId, 'Runtime.evaluate', {
            expression: EVENT_TRACKING_SCRIPT,
          });
          injectedPagesRef.current.add(targetId);
        }

        return attachedSessionId;
      })().finally(() => {
        pendingTargetAttachmentRef.current.delete(targetId);
      });

      pendingTargetAttachmentRef.current.set(targetId, attachmentPromise);
      return attachmentPromise;
    },
    [send, sendToAttachedTarget, usesBrowserLevelCdp],
  );

  const sendToPage = useCallback(
    async <T = CDPResult>(targetId: string, method: CDPMethod, params?: CDPParams): Promise<T> => {
      if (usesBrowserLevelCdp) {
        const attachedSessionId = await attachToTargetSession(targetId);
        return sendToAttachedTarget<T>(attachedSessionId, method, params);
      }

      return new Promise((resolve, reject) => {
        if (!sessionId) {
          reject(new Error('No session ID'));
          return;
        }

        let pageWs = pageSessionsRef.current.get(targetId);

        const executeCommand = () => {
          const id = messageIdRef.current++;
          const message: CDPMessage = { id, method, params };

          const handleMessage = (event: MessageEvent) => {
            try {
              const response: CDPMessage = JSON.parse(event.data);
              if (response.id === id) {
                pageWs?.removeEventListener('message', handleMessage);
                if (response.error) {
                  reject(new Error(response.error.message));
                } else {
                  resolve((response.result || {}) as T);
                }
              }
            } catch (e) {
              // Ignore parse errors for other messages
            }
          };

          pageWs?.addEventListener('message', handleMessage);
          pageWs?.send(JSON.stringify(message));

          setTimeout(() => {
            pageWs?.removeEventListener('message', handleMessage);
            reject(new Error(`Page CDP command timeout: ${method}`));
          }, 30000);
        };

        if (!pageWs || pageWs.readyState !== WebSocket.OPEN) {
          connectToPage(targetId);
          pageWs = pageSessionsRef.current.get(targetId);

          if (pageWs) {
            pageWs.addEventListener(
              'open',
              () => {
                executeCommand();
              },
              { once: true },
            );

            pageWs.addEventListener(
              'error',
              () => {
                reject(new Error('Failed to connect to page target'));
              },
              { once: true },
            );
          } else {
            reject(new Error('Failed to create WebSocket for page'));
          }
        } else {
          executeCommand();
        }
      });
    },
    [attachToTargetSession, connectToPage, sendToAttachedTarget, sessionId, usesBrowserLevelCdp],
  );

  const getLatestScreencastFrame = useCallback((pageId: string): string | null => {
    if (!pageId || typeof window === 'undefined') return null;
    const frameStore = (
      window as Window & { [LATEST_SCREENCAST_FRAMES_KEY]?: Record<string, string> }
    )[LATEST_SCREENCAST_FRAMES_KEY];
    const frameData = frameStore?.[pageId];
    if (typeof frameData === 'string' && frameData.startsWith('data:image/')) {
      return frameData;
    }
    return null;
  }, []);

  const getRawClickScreenshot = useCallback(
    async (pageId: string): Promise<string | null> => {
      if (!pageId) return null;

      const now = Date.now();
      const latestFrame = getLatestScreencastFrame(pageId);
      if (latestFrame) {
        lastRawScreenshotByPageRef.current.set(pageId, {
          timestamp: now,
          screenshotUrl: latestFrame,
        });
        return latestFrame;
      }

      const recent = lastRawScreenshotByPageRef.current.get(pageId);
      if (recent && now - recent.timestamp <= CLICK_SCREENSHOT_REUSE_WINDOW_MS) {
        return recent.screenshotUrl;
      }

      const pendingCapture = pendingRawScreenshotByPageRef.current.get(pageId);
      if (pendingCapture) {
        return pendingCapture;
      }

      const capturePromise = (async () => {
        try {
          const screenshot = await sendToPage<{ data?: string }>(pageId, 'Page.captureScreenshot', {
            format: 'jpeg',
            quality: 55,
          });
          const base64Data = typeof screenshot?.data === 'string' ? screenshot.data : '';
          if (!base64Data) return null;

          const screenshotUrl = `data:image/jpeg;base64,${base64Data}`;
          lastRawScreenshotByPageRef.current.set(pageId, {
            timestamp: Date.now(),
            screenshotUrl,
          });
          return screenshotUrl;
        } catch (error) {
          console.warn('[CDP] Failed to capture click screenshot:', error);
          return null;
        } finally {
          pendingRawScreenshotByPageRef.current.delete(pageId);
        }
      })();

      pendingRawScreenshotByPageRef.current.set(pageId, capturePromise);
      return capturePromise;
    },
    [getLatestScreencastFrame, sendToPage],
  );

  const createClickSnapshot = useCallback(
    async (screenshotUrl: string, clickData: any): Promise<string | null> => {
      const clickX = typeof clickData?.x === 'number' ? clickData.x : null;
      const clickY = typeof clickData?.y === 'number' ? clickData.y : null;
      if (clickX === null || clickY === null || typeof document === 'undefined') {
        return screenshotUrl;
      }

      const viewportWidth =
        typeof clickData?.viewportWidth === 'number' && clickData.viewportWidth > 0
          ? clickData.viewportWidth
          : null;
      const viewportHeight =
        typeof clickData?.viewportHeight === 'number' && clickData.viewportHeight > 0
          ? clickData.viewportHeight
          : null;

      const image = new Image();
      const loaded = await new Promise<boolean>((resolve) => {
        image.onload = () => resolve(true);
        image.onerror = () => resolve(false);
        image.src = screenshotUrl;
      });
      if (!loaded) return null;

      const sourceWidth = image.naturalWidth || image.width;
      const sourceHeight = image.naturalHeight || image.height;
      if (!sourceWidth || !sourceHeight) return null;

      const cropWidth = Math.max(1, Math.round(sourceWidth * 0.4));
      const cropHeight = Math.max(1, Math.round(sourceHeight * 0.4));

      const scaleX = viewportWidth ? sourceWidth / viewportWidth : 1;
      const scaleY = viewportHeight ? sourceHeight / viewportHeight : 1;
      const xInImage = clampNumber(clickX * scaleX, 0, sourceWidth - 1);
      const yInImage = clampNumber(clickY * scaleY, 0, sourceHeight - 1);

      // Keep the click at the center of the output. If the crop would exceed
      // image bounds, we pad the out-of-bounds area instead of shifting center.
      const cropLeft = xInImage - cropWidth / 2;
      const cropTop = yInImage - cropHeight / 2;

      const canvas = document.createElement('canvas');
      canvas.width = cropWidth;
      canvas.height = cropHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      const srcLeft = clampNumber(cropLeft, 0, sourceWidth);
      const srcTop = clampNumber(cropTop, 0, sourceHeight);
      const srcRight = clampNumber(cropLeft + cropWidth, 0, sourceWidth);
      const srcBottom = clampNumber(cropTop + cropHeight, 0, sourceHeight);
      const srcWidth = Math.max(0, srcRight - srcLeft);
      const srcHeight = Math.max(0, srcBottom - srcTop);

      const destX = srcLeft - cropLeft;
      const destY = srcTop - cropTop;

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cropWidth, cropHeight);
      if (srcWidth > 0 && srcHeight > 0) {
        ctx.drawImage(
          image,
          srcLeft,
          srcTop,
          srcWidth,
          srcHeight,
          destX,
          destY,
          srcWidth,
          srcHeight,
        );
      }

      const dotRadius = Math.max(3, Math.round(Math.min(cropWidth, cropHeight) * 0.02));
      ctx.fillStyle = 'rgba(37, 99, 235, 0.5)';
      ctx.beginPath();
      ctx.arc(cropWidth / 2, cropHeight / 2, dotRadius, 0, Math.PI * 2);
      ctx.fill();

      return canvas.toDataURL('image/jpeg', 0.88);
    },
    [],
  );

  const getClickScreenshot = useCallback(
    async (pageId: string, clickData?: any): Promise<string | null> => {
      const providedScreenshot =
        typeof clickData?.screenshotUrl === 'string' &&
        clickData.screenshotUrl.startsWith('data:image/')
          ? clickData.screenshotUrl
          : null;

      const screenshotUrl = providedScreenshot || (await getRawClickScreenshot(pageId));
      if (!screenshotUrl) return null;

      return createClickSnapshot(screenshotUrl, clickData);
    },
    [createClickSnapshot, getRawClickScreenshot],
  );

  // Tab management methods
  const createTarget = useCallback(
    async (url = 'about:blank'): Promise<Protocol.Target.CreateTargetResponse> => {
      const result = await send<Protocol.Target.CreateTargetResponse>('Target.createTarget', {
        url,
      });
      // Register immediately so Target.targetCreated event doesn't trigger onNewTabDetected
      if (result.targetId) {
        knownPageIdsRef.current.add(result.targetId);
      }
      return result;
    },
    [send],
  );

  const closeTarget = useCallback(
    async (targetId: string): Promise<Protocol.Target.CloseTargetResponse> => {
      knownPageIdsRef.current.delete(targetId);
      const attachedSessionId = pageTargetSessionIdsRef.current.get(targetId);
      if (attachedSessionId) {
        pageTargetSessionIdsRef.current.delete(targetId);
        targetPageIdsBySessionRef.current.delete(attachedSessionId);
        pendingTargetAttachmentRef.current.delete(targetId);
      }

      const pageWs = pageSessionsRef.current.get(targetId);
      if (pageWs) {
        pageWs.close();
        pageSessionsRef.current.delete(targetId);
      }
      return send<Protocol.Target.CloseTargetResponse>('Target.closeTarget', { targetId });
    },
    [send],
  );

  const getTargets = useCallback(async (): Promise<Protocol.Target.GetTargetsResponse> => {
    return send<Protocol.Target.GetTargetsResponse>('Target.getTargets');
  }, [send]);

  const activateTarget = useCallback(
    async (targetId: string): Promise<void> => {
      await send('Target.activateTarget', { targetId });
    },
    [send],
  );

  // Navigation
  const navigate = useCallback(
    async (targetId: string, url: string): Promise<Protocol.Page.NavigateResponse> => {
      // First enable the Page domain on this target
      await sendToPage(targetId, 'Page.enable');
      return sendToPage<Protocol.Page.NavigateResponse>(targetId, 'Page.navigate', { url });
    },
    [sendToPage],
  );

  const goBack = useCallback(
    async (targetId: string): Promise<void> => {
      await sendToPage(targetId, 'Runtime.evaluate', {
        expression: 'history.back()',
      });
    },
    [sendToPage],
  );

  const goForward = useCallback(
    async (targetId: string): Promise<void> => {
      await sendToPage(targetId, 'Runtime.evaluate', {
        expression: 'history.forward()',
      });
    },
    [sendToPage],
  );

  const reload = useCallback(
    async (targetId: string): Promise<void> => {
      await sendToPage(targetId, 'Page.enable');
      await sendToPage(targetId, 'Page.reload');
    },
    [sendToPage],
  );

  // DOM interaction - retries until element is found or max attempts reached
  const focusElement = useCallback(
    async (targetId: string, selector: string, maxAttempts = 10): Promise<boolean> => {
      const escapedSelector = selector.replace(/'/g, "\\'");

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const result = await sendToPage<{ result?: { value?: boolean } }>(
            targetId,
            'Runtime.evaluate',
            {
              expression: `
            (function() {
              const el = document.querySelector('${escapedSelector}');
              if (el) {
                el.focus();
                el.click();
                return true;
              }
              return false;
            })()
          `,
              returnByValue: true,
            },
          );

          if (result?.result?.value === true) {
            console.log('[CDP] Successfully focused element:', selector);
            return true;
          }
        } catch (e) {
          console.warn('[CDP] Focus attempt failed:', e);
        }

        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      console.warn('[CDP] Could not focus element after', maxAttempts, 'attempts:', selector);
      return false;
    },
    [sendToPage],
  );

  // Interaction handling
  const clearInteractions = useCallback(() => {
    setInteractions([]);
    typingBufferRef.current = null;
    lastRawScreenshotByPageRef.current.clear();
    pendingRawScreenshotByPageRef.current.clear();
  }, []);

  const removeInteraction = useCallback((id: string) => {
    setInteractions((prev) => prev.filter((i) => i.id !== id));
  }, []);

  const addInteraction = useCallback(
    (type: Interaction['type'], element: Interaction['element'], pageId?: string, data?: any) => {
      typingBufferRef.current = null;

      const timestamp = Date.now();
      const interactionId = `${type}-${timestamp}-${Math.random().toString(36).substring(2, 9)}`;
      const resolvedPageId = pageId ?? '';

      const isClickEvent = type === 'user_event' && data?.type === 'click';

      const interaction: Interaction = {
        id: interactionId,
        type,
        timestamp,
        pageId: resolvedPageId,
        screenshotUrl: isClickEvent
          ? undefined
          : typeof data?.screenshotUrl === 'string'
            ? data.screenshotUrl
            : undefined,
        element,
        data,
      };

      console.log('[CDP] Adding interaction:', {
        type,
        pageId,
        eventType: data?.type,
        element: element?.tagName,
      });
      setInteractions((prev) => [...prev, interaction]);

      if (isClickEvent && resolvedPageId) {
        void getClickScreenshot(resolvedPageId, data).then((capturedScreenshotUrl) => {
          if (!capturedScreenshotUrl) return;
          setInteractions((prev) => {
            const index = prev.findIndex((i) => i.id === interactionId);
            if (index === -1) return prev;
            if (prev[index].screenshotUrl === capturedScreenshotUrl) return prev;
            const next = [...prev];
            next[index] = {
              ...next[index],
              screenshotUrl: capturedScreenshotUrl,
            };
            return next;
          });
        });
      }

      if (callbacksRef.current?.onInteraction) {
        callbacksRef.current.onInteraction(interaction);
      }
    },
    [getClickScreenshot],
  );

  // Update ref so connectToPage can use it
  addInteractionRef.current = addInteraction;

  const handleKeydown = useCallback((eventData: any, pageId?: string) => {
    const { key, target, ctrlKey, altKey, metaKey } = eventData;

    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(key)) return;

    const now = Date.now();

    const selector = target?.selector || 'unknown';

    // Handle modifier key combinations (Ctrl+C, Cmd+V, etc.) as separate "pressed" interactions
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
        pageId: pageId ?? '',
        element: {
          ...target,
          tagName: 'KEYPRESS',
          text: combo,
        },
        data: { ...eventData, type: 'keypress', combo },
      };

      setInteractions((prev) => [...prev, newInteraction]);
      return;
    }

    // Handle Backspace - remove last character from buffer
    if (key === 'Backspace') {
      if (
        typingBufferRef.current &&
        typingBufferRef.current.selector === selector &&
        now - typingBufferRef.current.lastTimestamp < 3000 &&
        typingBufferRef.current.text.length > 0
      ) {
        const interactionId = typingBufferRef.current.interactionId;
        // Remove last character (handle special keys like [Enter] too)
        let currentText = typingBufferRef.current.text;
        if (currentText.endsWith(']')) {
          // Remove entire bracketed key like [Enter]
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

        setInteractions((prev) => {
          const index = prev.findIndex((i) => i.id === interactionId);
          if (index === -1) return prev;
          const updated = [...prev];
          updated[index] = {
            ...updated[index],
            timestamp: now,
            element: {
              ...updated[index].element,
              text: currentText,
            },
          };
          return updated;
        });
      }
      return;
    }

    // Regular character or special key (Enter, Tab, etc.)
    const char = key.length === 1 ? key : `[${key}]`;

    if (
      typingBufferRef.current &&
      typingBufferRef.current.selector === selector &&
      now - typingBufferRef.current.lastTimestamp < 3000
    ) {
      const newText = typingBufferRef.current.text + char;
      const interactionId = typingBufferRef.current.interactionId;

      typingBufferRef.current = {
        ...typingBufferRef.current,
        text: newText,
        lastTimestamp: now,
      };

      setInteractions((prev) => {
        const index = prev.findIndex((i) => i.id === interactionId);
        if (index === -1) return prev;
        const updated = [...prev];
        updated[index] = {
          ...updated[index],
          timestamp: now,
          element: {
            ...updated[index].element,
            text: newText,
          },
        };
        return updated;
      });
    } else {
      const interactionId = `typing-${now}-${Math.random().toString(36).substring(2, 9)}`;
      const newInteraction: Interaction = {
        id: interactionId,
        type: 'user_event',
        timestamp: now,
        pageId: pageId ?? '',
        element: {
          ...target,
          text: char,
        },
        data: { ...eventData, type: 'keydown' },
      };

      typingBufferRef.current = {
        interactionId,
        text: char,
        lastTimestamp: now,
        selector,
      };

      setInteractions((prev) => [...prev, newInteraction]);
    }
  }, []);

  // Update ref so connectToPage can use it
  handleKeydownRef.current = handleKeydown;

  // Listen for postMessage events from the ScreencastView component.
  // For local browser, ScreencastView holds the CDP connection and
  // forwards Runtime.bindingCalled events (clicks, keydown) as well
  // as Page.frameNavigated events here.
  useEffect(() => {
    if (!sessionId) return;

    const handleScreencastMessage = (event: MessageEvent) => {
      const msg = event.data;
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'screencast:cdp-event' && msg.data) {
        const eventData = msg.data;
        const pageId = msg.pageId || '';
        const now = Date.now();

        if (eventData.type === 'keydown') {
          handleKeydownRef.current?.(eventData, pageId);
        } else if (eventData.type === 'click') {
          if (now - lastClickTimestampRef.current < 100) return;
          lastClickTimestampRef.current = now;
          addInteractionRef.current?.(
            'user_event',
            eventData.target || {
              tagName: 'CLICK',
              text: 'click',
              selector: 'unknown',
            },
            pageId,
            eventData,
          );
        }
      }

      if (msg.type === 'screencast:frame-navigated' && msg.frame) {
        const frame = msg.frame;
        const pageId = msg.pageId || '';
        const now = Date.now();

        const lastNavigationAt = lastNavigationRefreshByPageRef.current.get(pageId) || 0;
        if (now - lastNavigationAt > 1000) {
          lastNavigationRefreshByPageRef.current.set(pageId, now);
          addInteractionRef.current?.(
            'frame_navigation',
            {
              tagName: 'FRAME_NAVIGATION',
              text: `Navigated to ${frame.url}`,
              selector: frame.id,
              href: frame.url,
            },
            pageId,
            {
              url: frame.url,
              frameId: frame.id,
              name: frame.name,
              pageId,
            },
          );

          if (callbacksRef.current?.onFrameNavigation) {
            callbacksRef.current.onFrameNavigation(frame.url, frame.id, pageId);
          }
        }
      }

      if (msg.type === 'screencast:url-sync' && typeof msg.url === 'string') {
        const pageId = msg.pageId || '';
        if (pageId && callbacksRef.current?.onFrameNavigation) {
          callbacksRef.current.onFrameNavigation(msg.url, pageId, pageId);
        }
      }

      if (msg.type === 'screencast:page-loaded') {
        const pageId = msg.pageId || '';
        if (pageId) {
          void queryPageMetadata(pageId);
        }
      }
    };

    window.addEventListener('message', handleScreencastMessage);
    return () => window.removeEventListener('message', handleScreencastMessage);
  }, [sessionId, queryPageMetadata]);

  // Clear interactions when session ends
  useEffect(() => {
    if (!sessionId) {
      setInteractions([]);
      typingBufferRef.current = null;
      injectedPagesRef.current.clear();
      pageTargetSessionIdsRef.current.clear();
      targetPageIdsBySessionRef.current.clear();
      pendingTargetAttachmentRef.current.clear();
      lastNavigationRefreshByPageRef.current.clear();
      lastRawScreenshotByPageRef.current.clear();
      pendingRawScreenshotByPageRef.current.clear();
    }
  }, [sessionId]);

  return {
    ...state,
    createTarget,
    closeTarget,
    getTargets,
    activateTarget,
    navigate,
    goBack,
    goForward,
    reload,
    focusElement,
    send,
    sendToPage,
    connect,
    connectToPage,
    ensurePageConnections,
    disconnect,
    interactions,
    clearInteractions,
    removeInteraction,
    addInteraction,
  };
}

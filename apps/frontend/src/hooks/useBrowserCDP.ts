'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { NoVNCViewerHandle } from '../app/components/Browser/NoVNCViewer';

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
  onFileChooserOpened?: (pageId: string, mode: string, backendNodeId: number) => void;
  onDownloadCompleted?: (filename: string) => void;
}

export interface DownloadedFile {
  filename: string;
  url: string;
  completedAt: number;
}

interface UseBrowserCDPReturn extends BrowserCDPState {
  ensurePageConnections: (pageIds: string[]) => void;
  interactions: Interaction[];
  removeInteraction: (id: string) => void;
  addInteraction: (
    type: Interaction['type'],
    element: Interaction['element'],
    pageId?: string,
    data?: any,
  ) => void;
  downloadedFiles: DownloadedFile[];
  handleFileChooser: (
    pageId: string,
    backendNodeId: number,
    action: 'accept' | 'cancel',
    files?: string[],
  ) => Promise<void>;
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
const CDP_COMMAND_TIMEOUT_MS = 10_000;
const CLICK_SNAPSHOT_CROP_RATIO = 0.4;
const CLICK_SNAPSHOT_MARKER_RATIO = 0.02;

const clampNumber = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const getFiniteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const waitForNextPaint = async () => {
  if (typeof window === 'undefined') return;
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
};

// Script injected into pages to report click coordinates through the
// __cdpEvent Runtime binding.
const EVENT_TRACKING_SCRIPT = `(function() {
  if (window.__bbEventListenerInjected) return;
  window.__bbEventListenerInjected = true;
  document.addEventListener('click', function(e) {
    if (typeof window.__cdpEvent !== 'function') return;
    try {
      window.__cdpEvent(JSON.stringify({ x: e.clientX, y: e.clientY, clickScreenX: e.screenX, clickScreenY: e.screenY, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, outerWidth: window.outerWidth, outerHeight: window.outerHeight, screenX: window.screenX, screenY: window.screenY, screenWidth: screen.width, screenHeight: screen.height }));
    } catch (_err) {}
  }, true);
})()`;

const extractClickCoordinates = (eventData: any): { x: number; y: number } | null => {
  const x = getFiniteNumber(eventData?.x);
  const y = getFiniteNumber(eventData?.y);
  if (x === null || y === null) return null;
  return { x, y };
};

export function useBrowserCDP(
  sessionId: string | null,
  initialPageId?: string,
  callbacks?: InteractionCallbacks,
  cdpWsUrlTemplate?: string | null,
  vncViewerRef?: RefObject<NoVNCViewerHandle | null>,
): UseBrowserCDPReturn {
  const usesBrowserLevelCdp = Boolean(
    cdpWsUrlTemplate && !cdpWsUrlTemplate.includes('{pageId}'),
  );
  const [state, setState] = useState<BrowserCDPState>({
    isConnected: false,
    error: null,
  });

  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [downloadedFiles, setDownloadedFiles] = useState<DownloadedFile[]>([]);
  const callbacksRef = useRef(callbacks);
  const downloadGuidToFilenameRef = useRef<Map<string, { filename: string; url: string }>>(
    new Map(),
  );

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

  const handleTrackedRuntimeBindingPayload = useCallback(
    (payload: string, pageId: string) => {
      try {
        const eventData = JSON.parse(payload || '{}');

        // Backwards compatibility for any sessions still using the old script.
        if (eventData?.type === 'keydown') {
          handleKeydownRef.current?.(eventData, pageId);
          return;
        }

        const clickCoordinates = extractClickCoordinates(eventData);
        if (!clickCoordinates) {
          return;
        }

        const now = Date.now();
        if (now - lastClickTimestampRef.current < 100) {
          return;
        }
        lastClickTimestampRef.current = now;

        addInteractionRef.current?.(
          'user_event',
          {
            tagName: 'CLICK',
            text: `(${Math.round(clickCoordinates.x)}, ${Math.round(clickCoordinates.y)})`,
            selector: 'coordinates',
          },
          pageId,
          {
            type: 'click',
            x: clickCoordinates.x,
            y: clickCoordinates.y,
            clickScreenX: getFiniteNumber(eventData?.clickScreenX) ?? undefined,
            clickScreenY: getFiniteNumber(eventData?.clickScreenY) ?? undefined,
            viewportWidth: getFiniteNumber(eventData?.viewportWidth) ?? undefined,
            viewportHeight: getFiniteNumber(eventData?.viewportHeight) ?? undefined,
            outerWidth: getFiniteNumber(eventData?.outerWidth) ?? undefined,
            outerHeight: getFiniteNumber(eventData?.outerHeight) ?? undefined,
            screenX: getFiniteNumber(eventData?.screenX) ?? undefined,
            screenY: getFiniteNumber(eventData?.screenY) ?? undefined,
            screenWidth: getFiniteNumber(eventData?.screenWidth) ?? undefined,
            screenHeight: getFiniteNumber(eventData?.screenHeight) ?? undefined,
          },
        );
      } catch (e) {
        console.warn('[CDP] Failed to parse binding event:', e);
      }
    },
    [],
  );

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
        // Intercept file chooser dialogs so we can show a custom upload modal
        ws.send(
          JSON.stringify({
            id: msgId++,
            method: 'Page.setInterceptFileChooserDialog',
            params: { enabled: true },
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
            handleTrackedRuntimeBindingPayload(
              ((message.params as Record<string, unknown>)?.payload as string) || '{}',
              pageId,
            );
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

          // Handle file chooser interception
          if (message.method === 'Page.fileChooserOpened') {
            const params = message.params as any;
            const mode = params?.mode || 'selectSingle';
            const backendNodeId = params?.backendNodeId;
            console.log(`[CDP] File chooser opened for page ${pageId}, mode: ${mode}, backendNodeId: ${backendNodeId}`);
            if (backendNodeId != null) {
              callbacksRef.current?.onFileChooserOpened?.(pageId, mode, backendNodeId);
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

        // Enable download events on this CDP session so we can track downloaded files
        ws.send(
          JSON.stringify({
            id: messageIdRef.current++,
            method: 'Browser.setDownloadBehavior',
            params: {
              behavior: 'allow',
              downloadPath: '/tmp/downloads',
              eventsEnabled: true,
            },
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
              handleTrackedRuntimeBindingPayload(
                ((message.params as Record<string, unknown>)?.payload as string) || '{}',
                targetPageId,
              );
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

            // Handle file chooser interception on attached targets
            if (message.method === 'Page.fileChooserOpened') {
              const params = message.params as any;
              const mode = params?.mode || 'selectSingle';
              const backendNodeId = params?.backendNodeId;
              console.log(
                `[CDP] File chooser opened for page ${targetPageId}, mode: ${mode}, backendNodeId: ${backendNodeId}`,
              );
              if (backendNodeId != null) {
                callbacksRef.current?.onFileChooserOpened?.(targetPageId, mode, backendNodeId);
              }
              return;
            }
          }

          // Track download events (browser-level, no sessionId)
          if (message.method === 'Browser.downloadWillBegin') {
            const params = message.params as any;
            const guid = params?.guid;
            const suggestedFilename = params?.suggestedFilename || 'download';
            const url = params?.url || '';
            if (guid) {
              downloadGuidToFilenameRef.current.set(guid, {
                filename: suggestedFilename,
                url,
              });
              console.log(`[CDP] Download started: ${suggestedFilename} (${guid})`);
            }
          }

          if (message.method === 'Browser.downloadProgress') {
            const params = message.params as any;
            const guid = params?.guid;
            const state = params?.state;
            if (guid && state === 'completed') {
              const fileInfo = downloadGuidToFilenameRef.current.get(guid);
              if (fileInfo) {
                console.log(`[CDP] Download completed: ${fileInfo.filename}`);
                setDownloadedFiles((prev) => [
                  ...prev,
                  {
                    filename: fileInfo.filename,
                    url: fileInfo.url,
                    completedAt: Date.now(),
                  },
                ]);
                callbacksRef.current?.onDownloadCompleted?.(fileInfo.filename);
                downloadGuidToFilenameRef.current.delete(guid);
              }
            } else if (guid && state === 'canceled') {
              downloadGuidToFilenameRef.current.delete(guid);
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
    [
      sessionId,
      cdpWsUrlTemplate,
      queryPageMetadata,
      usesBrowserLevelCdp,
      handleTrackedRuntimeBindingPayload,
    ],
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

      setTimeout(() => {
        if (pendingRequestsRef.current.has(id)) {
          pendingRequestsRef.current.delete(id);
          reject(new Error(`CDP command timeout: ${method}`));
        }
      }, CDP_COMMAND_TIMEOUT_MS);

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
        }, CDP_COMMAND_TIMEOUT_MS);

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

        const setupPromises: Promise<unknown>[] = [
          sendToAttachedTarget(attachedSessionId, 'Page.enable'),
          sendToAttachedTarget(attachedSessionId, 'Runtime.enable'),
          sendToAttachedTarget(attachedSessionId, 'Runtime.addBinding', {
            name: '__cdpEvent',
          }),
          sendToAttachedTarget(
            attachedSessionId,
            'Page.setInterceptFileChooserDialog',
            { enabled: true },
          ).catch((err) =>
            console.warn('[CDP] Failed to enable file chooser interception:', err),
          ),
        ];

        if (!injectedPagesRef.current.has(targetId)) {
          setupPromises.push(
            sendToAttachedTarget(attachedSessionId, 'Page.addScriptToEvaluateOnNewDocument', {
              source: EVENT_TRACKING_SCRIPT,
            }),
            sendToAttachedTarget(attachedSessionId, 'Runtime.evaluate', {
              expression: EVENT_TRACKING_SCRIPT,
            }),
          );
          injectedPagesRef.current.add(targetId);
        }

        await Promise.all(setupPromises);

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
          }, CDP_COMMAND_TIMEOUT_MS);
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

  const handleFileChooser = useCallback(
    async (
      pageId: string,
      backendNodeId: number,
      action: 'accept' | 'cancel',
      files?: string[],
    ) => {
      console.log(`[CDP] Handling file chooser for page ${pageId}: ${action}`, files);
      const filePaths = action === 'accept' && files?.length ? files : [];
      // DOM domain must be enabled for DOM.setFileInputFiles to work
      await sendToPage(pageId, 'DOM.enable').catch(() => {});
      await sendToPage(pageId, 'DOM.setFileInputFiles', {
        files: filePaths,
        backendNodeId,
      });
    },
    [sendToPage],
  );

  const getRawClickScreenshot = useCallback(
    async (pageId: string): Promise<string | null> => {
      if (!pageId) return null;

      const pendingCapture = pendingRawScreenshotByPageRef.current.get(pageId);
      if (pendingCapture) {
        return pendingCapture;
      }

      const capturePromise = (async () => {
        try {
          await waitForNextPaint();
          const screenshotUrl = vncViewerRef?.current?.captureScreenshot('image/jpeg', 0.55) ?? null;
          if (!screenshotUrl) return null;
          return screenshotUrl;
        } catch (error) {
          console.warn('[CDP] Failed to capture VNC click screenshot:', error);
          return null;
        } finally {
          pendingRawScreenshotByPageRef.current.delete(pageId);
        }
      })();

      pendingRawScreenshotByPageRef.current.set(pageId, capturePromise);
      return capturePromise;
    },
    [vncViewerRef],
  );

  const createClickSnapshot = useCallback(
    async (screenshotUrl: string, clickData: any): Promise<string | null> => {
      const clickX = getFiniteNumber(clickData?.x);
      const clickY = getFiniteNumber(clickData?.y);
      if (clickX === null || clickY === null || typeof document === 'undefined') {
        return screenshotUrl;
      }

      const liveCanvas = vncViewerRef?.current?.getCanvas() ?? null;
      let imageSource: CanvasImageSource;
      let sourceWidth = 0;
      let sourceHeight = 0;
      const loadImageFromScreenshotUrl = async (): Promise<HTMLImageElement | null> => {
        const image = new Image();
        const loaded = await new Promise<boolean>((resolve) => {
          image.onload = () => resolve(true);
          image.onerror = () => resolve(false);
          image.src = screenshotUrl;
        });
        if (!loaded) return null;
        return image;
      };

      if (liveCanvas && liveCanvas.width > 0 && liveCanvas.height > 0) {
        imageSource = liveCanvas;
        sourceWidth = liveCanvas.width;
        sourceHeight = liveCanvas.height;
      } else {
        const image = await loadImageFromScreenshotUrl();
        if (!image) return null;
        imageSource = image;
        sourceWidth = image.naturalWidth || image.width;
        sourceHeight = image.naturalHeight || image.height;
      }
      if (!sourceWidth || !sourceHeight) return null;

      const viewportWidth = getFiniteNumber(clickData?.viewportWidth);
      const viewportHeight = getFiniteNumber(clickData?.viewportHeight);
      const hasViewportMetrics =
        (viewportWidth ?? 0) > 0 && (viewportHeight ?? 0) > 0;
      const effectiveViewportWidth = hasViewportMetrics ? viewportWidth! : sourceWidth;
      const effectiveViewportHeight = hasViewportMetrics ? viewportHeight! : sourceHeight;
      const outerWidth = getFiniteNumber(clickData?.outerWidth);
      const outerHeight = getFiniteNumber(clickData?.outerHeight);
      const effectiveBrowserWidth =
        hasViewportMetrics && (outerWidth ?? 0) > 0 ? outerWidth! : effectiveViewportWidth;
      const effectiveBrowserHeight =
        hasViewportMetrics && (outerHeight ?? 0) > 0 ? outerHeight! : effectiveViewportHeight;
      const viewportOffsetXFromEvent = getFiniteNumber(clickData?.viewportOffsetX);
      const viewportOffsetYFromEvent = getFiniteNumber(clickData?.viewportOffsetY);
      const viewportOffsetX =
        viewportOffsetXFromEvent !== null
          ? clampNumber(
              viewportOffsetXFromEvent,
              0,
              Math.max(0, effectiveBrowserWidth - effectiveViewportWidth),
            )
          : hasViewportMetrics
            ? Math.max(0, (effectiveBrowserWidth - effectiveViewportWidth) / 2)
            : 0;
      const viewportOffsetY =
        viewportOffsetYFromEvent !== null
          ? clampNumber(
              viewportOffsetYFromEvent,
              0,
              Math.max(0, effectiveBrowserHeight - effectiveViewportHeight),
            )
          : hasViewportMetrics
            ? Math.max(0, effectiveBrowserHeight - effectiveViewportHeight)
            : 0;

      const scaleX = sourceWidth / Math.max(1, effectiveBrowserWidth);
      const scaleY = sourceHeight / Math.max(1, effectiveBrowserHeight);
      const clickScreenX = getFiniteNumber(clickData?.clickScreenX);
      const clickScreenY = getFiniteNumber(clickData?.clickScreenY);
      const screenX = getFiniteNumber(clickData?.screenX);
      const screenY = getFiniteNumber(clickData?.screenY);
      const screenWidth = getFiniteNumber(clickData?.screenWidth);
      const screenHeight = getFiniteNumber(clickData?.screenHeight);

      // Prefer absolute screen coordinates (e.screenX/Y) when available — they
      // map directly to VNC canvas pixels and bypass all browser-chrome offset
      // ambiguities (headless Chrome reports outerHeight == innerHeight).
      const hasScreenClickCoords =
        clickScreenX !== null &&
        clickScreenY !== null &&
        (screenWidth ?? 0) > 0 &&
        (screenHeight ?? 0) > 0;
      const canUseDesktopCoordinates =
        !hasScreenClickCoords &&
        screenX !== null &&
        screenY !== null &&
        (screenWidth ?? 0) > 0 &&
        (screenHeight ?? 0) > 0 &&
        (sourceWidth > effectiveBrowserWidth * 1.02 || sourceHeight > effectiveBrowserHeight * 1.02);
      const screenScaleX = hasScreenClickCoords ? sourceWidth / Math.max(1, screenWidth!) : 1;
      const screenScaleY = hasScreenClickCoords ? sourceHeight / Math.max(1, screenHeight!) : 1;
      const desktopScaleX = canUseDesktopCoordinates ? sourceWidth / Math.max(1, screenWidth!) : 1;
      const desktopScaleY = canUseDesktopCoordinates ? sourceHeight / Math.max(1, screenHeight!) : 1;
      const activeScaleX = hasScreenClickCoords ? screenScaleX : canUseDesktopCoordinates ? desktopScaleX : scaleX;
      const activeScaleY = hasScreenClickCoords ? screenScaleY : canUseDesktopCoordinates ? desktopScaleY : scaleY;
      // Crop a 40% region around the click. When using screen coordinates the
      // crop should be relative to the full source (VNC canvas), not just the
      // viewport, so that the zoom level stays consistent.
      const cropBaseWidth = hasScreenClickCoords ? sourceWidth : effectiveViewportWidth * activeScaleX;
      const cropBaseHeight = hasScreenClickCoords ? sourceHeight : effectiveViewportHeight * activeScaleY;
      const cropWidth = Math.max(
        1,
        Math.round(cropBaseWidth * CLICK_SNAPSHOT_CROP_RATIO),
      );
      const cropHeight = Math.max(
        1,
        Math.round(cropBaseHeight * CLICK_SNAPSHOT_CROP_RATIO),
      );
      const xInImage = hasScreenClickCoords
        ? clampNumber(clickScreenX! * screenScaleX, 0, sourceWidth - 1)
        : canUseDesktopCoordinates
          ? clampNumber(
              (
                clickScreenX ??
                (screenX! + viewportOffsetX + clickX)
              ) * desktopScaleX,
              0,
              sourceWidth - 1,
            )
          : clampNumber(
              (viewportOffsetX + clickX) * scaleX,
              0,
              sourceWidth - 1,
            );
      const yInImage = hasScreenClickCoords
        ? clampNumber(clickScreenY! * screenScaleY, 0, sourceHeight - 1)
        : canUseDesktopCoordinates
          ? clampNumber(
              (
                clickScreenY ??
                (screenY! + viewportOffsetY + clickY)
              ) * desktopScaleY,
              0,
              sourceHeight - 1,
            )
          : clampNumber(
              (viewportOffsetY + clickY) * scaleY,
              0,
              sourceHeight - 1,
            );

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
          imageSource,
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
    },
    [vncViewerRef],
  );

  const getClickScreenshot = useCallback(
    async (pageId: string, clickData?: any): Promise<string | null> => {
      const providedScreenshot =
        typeof clickData?.screenshotUrl === 'string' &&
        clickData.screenshotUrl.startsWith('data:image/')
          ? clickData.screenshotUrl
          : null;

      const clickHasCoordinates =
        getFiniteNumber(clickData?.x) !== null &&
        getFiniteNumber(clickData?.y) !== null;

      const screenshotUrl = providedScreenshot || (await getRawClickScreenshot(pageId));
      if (!screenshotUrl) return null;

      if (!clickHasCoordinates) {
        return screenshotUrl;
      }

      return (await createClickSnapshot(screenshotUrl, clickData)) || screenshotUrl;
    },
    [createClickSnapshot, getRawClickScreenshot],
  );

  // Interaction handling
  const removeInteraction = useCallback((id: string) => {
    setInteractions((prev) => prev.filter((i) => i.id !== id));
  }, []);

  const addInteraction = useCallback(
    (type: Interaction['type'], element: Interaction['element'], pageId?: string, data?: any) => {
      typingBufferRef.current = null;

      const timestamp = Date.now();
      const interactionId = `${type}-${timestamp}-${Math.random().toString(36).substring(2, 9)}`;
      const resolvedPageId = pageId ?? '';

      const isClickEvent =
        type === 'user_event' &&
        (data?.type === 'click' || extractClickCoordinates(data) !== null);

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

  // Clear interactions and downloads when session ends
  useEffect(() => {
    if (!sessionId) {
      setInteractions([]);
      setDownloadedFiles([]);
      typingBufferRef.current = null;
      injectedPagesRef.current.clear();
      pageTargetSessionIdsRef.current.clear();
      targetPageIdsBySessionRef.current.clear();
      pendingTargetAttachmentRef.current.clear();
      lastNavigationRefreshByPageRef.current.clear();
      pendingRawScreenshotByPageRef.current.clear();
      downloadGuidToFilenameRef.current.clear();
    }
  }, [sessionId]);

  return {
    ...state,
    ensurePageConnections,
    interactions,
    removeInteraction,
    addInteraction,
    downloadedFiles,
    handleFileChooser,
  };
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

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
  /** Add a complete Interaction object directly (e.g. from VNC viewer) */
  addInteractionDirect: (interaction: Interaction) => void;
  /** Update an existing interaction by id (e.g. to attach screenshot or update typing text) */
  updateInteraction: (id: string, updates: Partial<Interaction>) => void;
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

export function useBrowserCDP(
  sessionId: string | null,
  initialPageId?: string,
  callbacks?: InteractionCallbacks,
  cdpWsUrlTemplate?: string | null,
): UseBrowserCDPReturn {
  const usesBrowserLevelCdp = Boolean(cdpWsUrlTemplate && !cdpWsUrlTemplate.includes('{pageId}'));
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

  const wsRef = useRef<WebSocket | null>(null);
  const currentPageIdRef = useRef<string | null>(null);
  const messageIdRef = useRef(1);
  const pendingRequestsRef = useRef<Map<number, PendingRequest>>(new Map());
  const pageSessionsRef = useRef<Map<string, WebSocket>>(new Map());
  const pageTargetSessionIdsRef = useRef<Map<string, string>>(new Map());
  const targetPageIdsBySessionRef = useRef<Map<string, string>>(new Map());
  const pendingTargetAttachmentRef = useRef<Map<string, Promise<string>>>(new Map());
  const knownPageIdsRef = useRef<Set<string>>(new Set());

  // Throttling refs for interaction events
  const lastNavigationRefreshByPageRef = useRef<Map<string, number>>(new Map());

  // Handler ref (set later, used in connectToPage)
  const addInteractionRef = useRef<
    | ((
        type: Interaction['type'],
        element: Interaction['element'],
        pageId?: string,
        data?: any,
      ) => void)
    | null
  >(null);

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

        // Enable Page (for navigation events)
        ws.send(JSON.stringify({ id: msgId++, method: 'Page.enable' }));
        // Intercept file chooser dialogs so we can show a custom upload modal
        ws.send(
          JSON.stringify({
            id: msgId++,
            method: 'Page.setInterceptFileChooserDialog',
            params: { enabled: true },
          }),
        );

        // Ensure URL/title/favicon are populated even if Page.frameNavigated
        // fired before this WebSocket listener was attached.
        setTimeout(() => {
          void queryPageMetadata(pageId);
        }, 250);
      };

      ws.onclose = (event) => {
        console.log(`[CDP] WebSocket closed for page ${pageId}:`, event.code, event.reason);
        pageSessionsRef.current.delete(pageId);

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
            console.log(
              `[CDP] File chooser opened for page ${pageId}, mode: ${mode}, backendNodeId: ${backendNodeId}`,
            );
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
          sendToAttachedTarget(attachedSessionId, 'Page.setInterceptFileChooserDialog', {
            enabled: true,
          }).catch((err) => console.warn('[CDP] Failed to enable file chooser interception:', err)),
        ];

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

  // Interaction handling
  const removeInteraction = useCallback((id: string) => {
    setInteractions((prev) => prev.filter((i) => i.id !== id));
  }, []);

  const addInteraction = useCallback(
    (type: Interaction['type'], element: Interaction['element'], pageId?: string, data?: any) => {
      const timestamp = Date.now();
      const interactionId = `${type}-${timestamp}-${Math.random().toString(36).substring(2, 9)}`;
      const resolvedPageId = pageId ?? '';

      const interaction: Interaction = {
        id: interactionId,
        type,
        timestamp,
        pageId: resolvedPageId,
        screenshotUrl: typeof data?.screenshotUrl === 'string' ? data.screenshotUrl : undefined,
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

      if (callbacksRef.current?.onInteraction) {
        callbacksRef.current.onInteraction(interaction);
      }
    },
    [],
  );

  const addInteractionDirect = useCallback((interaction: Interaction) => {
    console.log('[CDP] Adding interaction (direct):', {
      type: interaction.type,
      eventType: interaction.data?.type,
      element: interaction.element?.tagName,
    });
    setInteractions((prev) => [...prev, interaction]);

    if (callbacksRef.current?.onInteraction) {
      callbacksRef.current.onInteraction(interaction);
    }
  }, []);

  const updateInteraction = useCallback((id: string, updates: Partial<Interaction>) => {
    setInteractions((prev) => {
      const index = prev.findIndex((i) => i.id === id);
      if (index === -1) return prev;
      const next = [...prev];
      next[index] = {
        ...next[index],
        ...updates,
        element: updates.element
          ? { ...next[index].element, ...updates.element }
          : next[index].element,
      };
      return next;
    });
  }, []);

  // Update ref so connectToPage can use it
  addInteractionRef.current = addInteraction;

  // Clear interactions and downloads when session ends
  useEffect(() => {
    if (!sessionId) {
      setInteractions([]);
      setDownloadedFiles([]);
      pageTargetSessionIdsRef.current.clear();
      targetPageIdsBySessionRef.current.clear();
      pendingTargetAttachmentRef.current.clear();
      lastNavigationRefreshByPageRef.current.clear();
      downloadGuidToFilenameRef.current.clear();
    }
  }, [sessionId]);

  return {
    ...state,
    ensurePageConnections,
    interactions,
    removeInteraction,
    addInteraction,
    addInteractionDirect,
    updateInteraction,
    downloadedFiles,
    handleFileChooser,
  };
}

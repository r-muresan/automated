'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import axios from 'axios';
import posthog from 'posthog-js';
import {
  useCreateSession,
  useDeleteSession,
  usePingSession,
  useStopSession,
} from '../hooks/api';
import {
  useBrowserCDP,
  type DownloadedFile,
  type Interaction,
  type InteractionCallbacks,
} from '../hooks/useBrowserCDP';
import type { NoVNCViewerHandle } from '../app/components/Browser/NoVNCViewer';

interface BrowserPage {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  isSkeleton?: boolean;
}

interface FileChooserState {
  pageId: string;
  mode: string;
  backendNodeId: number;
}

interface BrowserContextType {
  sessionId: string | null;
  pages: BrowserPage[];
  activePageIndex: number;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
  interactions: Interaction[];
  removeInteraction: (id: string) => void;
  handleTakeControl: (width?: number, height?: number) => Promise<void>;
  handleStopSession: () => Promise<void>;
  vncUrl: string | null;
  vncViewerRef: React.RefObject<NoVNCViewerHandle | null>;
  downloadedFiles: DownloadedFile[];
  fileChooserState: FileChooserState | null;
  handleFileChooser: (
    action: 'accept' | 'cancel',
    files?: string[],
  ) => Promise<void>;
}

const BrowserContext = createContext<BrowserContextType | undefined>(undefined);

const SESSION_RECREATION_COOLDOWN_MS = 10_000;
const SESSION_IDLE_TIMEOUT_MS = 60 * 1000;
const SESSION_PING_INTERVAL_MS = 15_000;

const normalizePages = (
  pages: Array<Partial<BrowserPage> & Pick<BrowserPage, 'id'>> | undefined,
): BrowserPage[] =>
  (pages ?? []).map((page) => ({
    ...page,
    url: page.url ?? '',
    title: page.title ?? '',
  }));

export { type DownloadedFile, type Interaction };

export function BrowserProvider({ children }: { children: ReactNode }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pages, setPages] = useState<BrowserPage[]>([]);
  const [activePageIndex, setActivePageIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [cdpWsUrlTemplate, setCdpWsUrlTemplate] = useState<string | null>(null);
  const [vncUrl, setVncUrl] = useState<string | null>(null);
  const vncViewerRef = useRef<NoVNCViewerHandle | null>(null);
  const [fileChooserState, setFileChooserState] = useState<FileChooserState | null>(null);

  const lastInteractionRef = useRef(Date.now());
  const recreateSessionRef = useRef<(() => Promise<boolean>) | null>(null);
  const addInteractionRef = useRef<
    | ((
        type: Interaction['type'],
        element: Interaction['element'],
        pageId?: string,
        data?: any,
      ) => void)
    | null
  >(null);
  const lastViewportRef = useRef<{ width?: number; height?: number }>({});
  const sessionCreatedAtRef = useRef(0);

  const createSessionMutation = useCreateSession();
  const stopSessionMutation = useStopSession();
  const deleteSessionMutation = useDeleteSession();
  const pingSessionMutation = usePingSession();

  const firstPageId = pages.find((page) => !page.isSkeleton)?.id;

  const recreateSession = useCallback(async (): Promise<boolean> => {
    const timeSinceCreation = Date.now() - sessionCreatedAtRef.current;
    if (timeSinceCreation < SESSION_RECREATION_COOLDOWN_MS) {
      console.log('[FRONTEND] Skipping session recreation during cooldown');
      return false;
    }

    setSessionId(null);
    setPages([]);
    setActivePageIndex(0);
    setVncUrl(null);

    try {
      const colorScheme = window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
      const { width, height } = lastViewportRef.current;
      const data = await createSessionMutation.mutateAsync({ colorScheme, width, height });

      setCdpWsUrlTemplate(data.cdpWsUrlTemplate || null);
      setVncUrl(data.vncUrl || null);
      setSessionId(data.sessionId);
      setPages(normalizePages(data.pages));
      setActivePageIndex(0);
      sessionCreatedAtRef.current = Date.now();

      return true;
    } catch (error) {
      console.error('[FRONTEND] Failed to recreate session:', error);
      return false;
    }
  }, [createSessionMutation]);

  useEffect(() => {
    recreateSessionRef.current = recreateSession;
  }, [recreateSession]);

  const cdpCallbacks = useMemo<InteractionCallbacks>(
    () => ({
      onFrameNavigation: (url: string, _frameId: string, pageId: string) => {
        setPages((prev) =>
          prev.map((page) =>
            page.id === pageId
              ? page.url === url
                ? page
                : { ...page, url, title: 'Loading...', favicon: undefined }
              : page,
          ),
        );
      },
      onTitleUpdate: (title: string, pageId: string) => {
        setPages((prev) =>
          prev.map((page) => (page.id === pageId ? { ...page, title } : page)),
        );
      },
      onFaviconUpdate: (faviconUrl: string, pageId: string) => {
        setPages((prev) =>
          prev.map((page) => (page.id === pageId ? { ...page, favicon: faviconUrl } : page)),
        );
      },
      onNewTabDetected: (targetId: string, url: string) => {
        addInteractionRef.current?.(
          'tab_navigation',
          {
            tagName: 'NEW_TAB',
            text: 'Open new tab',
            href: url,
          },
          targetId,
          { type: 'new_tab', url },
        );

        let nextIndex = -1;
        setPages((prev) => {
          if (prev.some((page) => page.id === targetId)) {
            return prev;
          }

          nextIndex = prev.length;
          return [
            ...prev,
            {
              id: targetId,
              url,
              title: 'Loading...',
            },
          ];
        });

        if (nextIndex !== -1) {
          setActivePageIndex(nextIndex);
        }
      },
      onWebSocketDisconnected: () => {
        // With keepAlive=true, the browser session stays alive on the server
        // even when the CDP WebSocket disconnects. The ping loop will detect
        // if the session is truly gone (404) and recreate it then.
        console.log('[FRONTEND] CDP WebSocket disconnected; session kept alive on server');
      },
      onFileChooserOpened: (pageId: string, mode: string, backendNodeId: number) => {
        console.log('[FRONTEND] File chooser opened, showing upload modal');
        setFileChooserState({ pageId, mode, backendNodeId });
      },
    }),
    [],
  );

  const {
    isConnected: isCDPConnected,
    ensurePageConnections,
    interactions,
    removeInteraction,
    addInteraction,
    downloadedFiles,
    handleFileChooser: cdpHandleFileChooser,
  } = useBrowserCDP(sessionId, firstPageId, cdpCallbacks, cdpWsUrlTemplate);

  addInteractionRef.current = addInteraction;

  const fileChooserStateRef = useRef(fileChooserState);
  fileChooserStateRef.current = fileChooserState;

  const handleFileChooser = useCallback(
    async (action: 'accept' | 'cancel', files?: string[]) => {
      const state = fileChooserStateRef.current;
      if (!state) return;
      setFileChooserState(null);
      await cdpHandleFileChooser(state.pageId, state.backendNodeId, action, files);
    },
    [cdpHandleFileChooser],
  );

  const handleTakeControl = useCallback(
    async (width?: number, height?: number) => {
      setIsLoading(true);
      lastViewportRef.current = { width, height };

      try {
        const colorScheme = window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
        const data = await createSessionMutation.mutateAsync({ colorScheme, width, height });

        setCdpWsUrlTemplate(data.cdpWsUrlTemplate || null);
        setVncUrl(data.vncUrl || null);
        setSessionId(data.sessionId);
        setPages(normalizePages(data.pages));
        setActivePageIndex(0);
        sessionCreatedAtRef.current = Date.now();

        posthog.capture('browser_opened', {
          sessionId: data.sessionId,
          colorScheme,
          viewportWidth: width,
          viewportHeight: height,
        });
      } catch (error) {
        console.error('[FRONTEND] Error creating browser session:', error);
        throw error;
      } finally {
        setIsLoading(false);
      }
    },
    [createSessionMutation],
  );

  const handleStopSession = useCallback(async () => {
    if (!sessionId) return;

    const currentSessionId = sessionId;

    try {
      await stopSessionMutation.mutateAsync(currentSessionId);
    } catch (error) {
      console.error('[FRONTEND] Error stopping session:', error);
      try {
        await deleteSessionMutation.mutateAsync(currentSessionId);
      } catch (fallbackError) {
        console.error('[FRONTEND] Error deleting session after stop failure:', fallbackError);
      }
    } finally {
      setSessionId(null);
      setPages([]);
      setActivePageIndex(0);
      setCdpWsUrlTemplate(null);
      setVncUrl(null);
    }
  }, [deleteSessionMutation, sessionId, stopSessionMutation]);

  useEffect(() => {
    if (pages.length === 0) {
      if (activePageIndex !== 0) {
        setActivePageIndex(0);
      }
      return;
    }

    if (activePageIndex >= pages.length) {
      setActivePageIndex(pages.length - 1);
    }
  }, [activePageIndex, pages.length]);

  useEffect(() => {
    const markInteraction = () => {
      lastInteractionRef.current = Date.now();
    };

    const handleWindowBlur = () => {
      window.setTimeout(() => {
        if (document.activeElement?.tagName === 'IFRAME') {
          markInteraction();
        }
      }, 100);
    };

    window.addEventListener('mousedown', markInteraction);
    window.addEventListener('keydown', markInteraction);
    window.addEventListener('blur', handleWindowBlur);

    return () => {
      window.removeEventListener('mousedown', markInteraction);
      window.removeEventListener('keydown', markInteraction);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, []);

  useEffect(() => {
    if (!sessionId) return;

    const interval = window.setInterval(async () => {
      if (Date.now() - lastInteractionRef.current > SESSION_IDLE_TIMEOUT_MS) {
        await handleStopSession();
        return;
      }

      try {
        await pingSessionMutation.mutateAsync(sessionId);
      } catch (error) {
        if (
          axios.isAxiosError(error) &&
          (error.response?.status === 404 || error.response?.status === 401)
        ) {
          await recreateSession();
        }
      }
    }, SESSION_PING_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [handleStopSession, pingSessionMutation, recreateSession, sessionId]);

  // When the user returns to the tab after the session was stopped due to
  // idle timeout, automatically create a new session.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;

      // Reset interaction timer so the new session doesn't immediately time out
      lastInteractionRef.current = Date.now();

      // Only recreate if there's no active session (it was cleaned up while away)
      if (!sessionId && sessionCreatedAtRef.current > 0) {
        recreateSessionRef.current?.();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !isCDPConnected) return;

    const pageIds = pages.filter((page) => !page.isSkeleton).map((page) => page.id);
    if (pageIds.length > 0) {
      ensurePageConnections(pageIds);
    }
  }, [ensurePageConnections, isCDPConnected, pages, sessionId]);

  return (
    <BrowserContext.Provider
      value={{
        sessionId,
        pages,
        activePageIndex,
        isLoading,
        setIsLoading,
        interactions,
        removeInteraction,
        handleTakeControl,
        handleStopSession,
        vncUrl,
        vncViewerRef,
        downloadedFiles,
        fileChooserState,
        handleFileChooser,
      }}
    >
      {children}
    </BrowserContext.Provider>
  );
}

export function useBrowser() {
  const context = useContext(BrowserContext);
  if (!context) {
    throw new Error('useBrowser must be used within a BrowserProvider');
  }
  return context;
}

export function useOptionalBrowser() {
  return useContext(BrowserContext) ?? null;
}

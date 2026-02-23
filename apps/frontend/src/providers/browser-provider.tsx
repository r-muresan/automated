'use client';

import {
  createContext,
  useContext,
  useState,
  ReactNode,
  useEffect,
  useRef,
  useCallback,
} from 'react';
import axios from 'axios';
import posthog from 'posthog-js';
import {
  useCreateSession,
  useStopSession,
  useDeleteSession,
  usePingSession,
  useRefreshPages,
} from '../hooks/api';
import { useBrowserCDP } from '../hooks/useBrowserCDP';

interface BrowserPage {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  isSkeleton?: boolean;
}

import type { Interaction, InteractionCallbacks } from '../hooks/useBrowserCDP';

export type { Interaction };

interface BrowserContextType {
  input: string;
  setInput: (value: string) => void;
  sessionId: string | null;
  pages: BrowserPage[];
  activePageIndex: number;
  setActivePageIndex: (index: number) => void;
  isLoading: boolean;
  isAddingTab: boolean;
  focusUrlBar?: number;
  interactions: Interaction[];
  removeInteraction: (id: string) => void;
  refreshPages: (sid: string) => Promise<void>;
  handleTakeControl: (width?: number, height?: number) => Promise<void>;
  handleStopSession: () => Promise<void>;
  handleAddTab: () => Promise<void>;
  handleCloseTab: (e: React.MouseEvent, tabId: string) => Promise<void>;
  handleSubmit: (e: React.FormEvent) => void;
  setIsLoading: (loading: boolean) => void;
  handleResetSession: () => Promise<void>;
  navigateCurrentTab: (url: string) => Promise<void>;
  goBackCurrentTab: () => Promise<void>;
  goForwardCurrentTab: () => Promise<void>;
  reloadCurrentTab: () => Promise<void>;
  cdpWsUrlTemplate: string | null;
}

const BrowserContext = createContext<BrowserContextType | undefined>(undefined);

export function BrowserProvider({ children }: { children: ReactNode }) {
  const [input, setInput] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pages, setPages] = useState<BrowserPage[]>([]);
  const [activePageIndex, setActivePageIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isAddingTab, setIsAddingTab] = useState(false);
  const [focusUrlBarTrigger, setFocusUrlBarTrigger] = useState(0);
  const [lastInteraction, setLastInteraction] = useState<number>(Date.now());
  const [cdpWsUrlTemplate, setCdpWsUrlTemplate] = useState<string | null>(null);

  // React Query mutations
  const createSessionMutation = useCreateSession();
  const stopSessionMutation = useStopSession();
  const deleteSessionMutation = useDeleteSession();
  const pingSessionMutation = usePingSession();
  const refreshPagesMutation = useRefreshPages();

  // Get the first non-skeleton page ID for CDP connection
  const firstPageId = pages.find((p) => !p.isSkeleton)?.id;

  // Ref to track if we're handling a disconnect
  const isHandlingDisconnectRef = useRef(false);
  // Ref to hold recreateSession function for use in callbacks
  const recreateSessionRef = useRef<(() => Promise<boolean>) | null>(null);
  // Refs to break circular dependency: onNewTabDetected needs sendToPage/activateTarget
  // which come from useBrowserCDP, but cdpCallbacks is passed into useBrowserCDP.
  const sendToPageRef = useRef<((targetId: string, method: string, params?: any) => Promise<any>) | null>(null);
  const activateTargetRef = useRef<((targetId: string) => Promise<any>) | null>(null);

  // Callbacks for useBrowserCDP
  const cdpCallbacks = useCallback((): InteractionCallbacks => ({
    onFrameNavigation: (url: string, frameId: string, pageId: string) => {
      // Update URL immediately from CDP event (no server round-trip needed)
      setPages((prev) =>
        prev.map((p) =>
          p.id === pageId
            ? p.url === url
              ? p
              : { ...p, url, title: 'Loading...', favicon: undefined }
            : p
        )
      );
    },
    onTitleUpdate: (title: string, pageId: string) => {
      // Update title when it becomes available
      setPages((prev) =>
        prev.map((p) =>
          p.id === pageId ? { ...p, title } : p
        )
      );
    },
    onFaviconUpdate: (faviconUrl: string, pageId: string) => {
      setPages((prev) =>
        prev.map((p) =>
          p.id === pageId ? { ...p, favicon: faviconUrl } : p
        )
      );
    },
    onNewTabDetected: (targetId: string, url: string) => {
      // Skip when we're internally creating tabs (handleAddTab, handleResetSession)
      if (suppressNewTabDetection.current) {
        return;
      }
      // Add the new page if we don't already have it
      setPages((prev) => {
        if (prev.some((p) => p.id === targetId)) return prev;
        const newPage: BrowserPage = {
          id: targetId,
          url,
          title: 'Loading...',
        };
        return [...prev, newPage];
      });
      // Set the new tab as active
      setPages((prev) => {
        const newIndex = prev.findIndex((p) => p.id === targetId);
        if (newIndex !== -1) {
          setActivePageIndex(newIndex);
        }
        return prev;
      });

      // Apply viewport override and activate the new tab so the screencast
      // frame dimensions match the container (prevents white gap).
      const { width, height } = lastViewportRef.current;
      if (width && height && sendToPageRef.current) {
        sendToPageRef.current(targetId, 'Emulation.setDeviceMetricsOverride', {
          width: Math.round(width),
          height: Math.round(height),
          deviceScaleFactor: 1,
          mobile: false,
        }).catch(() => {});
      }
      if (activateTargetRef.current) {
        activateTargetRef.current(targetId).catch(() => {});
      }
    },
    onWebSocketDisconnected: () => {
      // Prevent multiple simultaneous reconnect attempts
      if (isHandlingDisconnectRef.current) {
        console.log('[FRONTEND] Already handling WebSocket disconnect, skipping');
        return;
      }

      console.log('[FRONTEND] WebSocket disconnected, attempting to recreate session');
      isHandlingDisconnectRef.current = true;

      // Use setTimeout to avoid state update issues during the disconnect handler
      setTimeout(async () => {
        try {
          const success = await recreateSessionRef.current?.() ?? false;
          if (success) {
            console.log('[FRONTEND] Session recreated successfully after WebSocket disconnect');
          } else {
            console.log('[FRONTEND] Failed to recreate session after WebSocket disconnect');
          }
        } finally {
          isHandlingDisconnectRef.current = false;
        }
      }, 500);
    },
  }), []);

  const {
    isConnected: isCDPConnected,
    createTarget,
    closeTarget,
    navigate,
    goBack,
    goForward,
    reload,
    getTargets,
    activateTarget,
    focusElement,
    sendToPage,
    ensurePageConnections,
    interactions,
    clearInteractions,
    removeInteraction,
    addInteraction,
  } = useBrowserCDP(sessionId, firstPageId, cdpCallbacks(), cdpWsUrlTemplate);

  // Keep refs in sync so onNewTabDetected can access these functions
  sendToPageRef.current = sendToPage;
  activateTargetRef.current = activateTarget;

  const deletedTabIds = useRef<string[]>([]);
  const suppressNewTabDetection = useRef(false);
  const lastViewportRef = useRef<{ width?: number; height?: number }>({});
  const sessionCreatedAtRef = useRef<number>(0);

  // Cooldown period after session creation (don't recreate within this time)
  const SESSION_RECREATION_COOLDOWN_MS = 10000;

  // Helper to check if an error indicates a stopped/invalid session
  // Only return true for specific session-stopped errors, not general connection issues
  const isSessionStoppedError = useCallback((error: unknown): boolean => {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      // Be more specific - only match actual session stopped errors
      return (
        message.includes('session stopped') ||
        message.includes('session closed') ||
        message.includes('session expired') ||
        message.includes('target closed') ||
        message.includes('no such target')
      );
    }
    return false;
  }, []);

  // Helper to recreate session when it's stopped
  const recreateSession = useCallback(async (): Promise<boolean> => {
    // Don't recreate if we just created a session (cooldown period)
    const timeSinceCreation = Date.now() - sessionCreatedAtRef.current;
    if (timeSinceCreation < SESSION_RECREATION_COOLDOWN_MS) {
      console.log('[FRONTEND] Skipping session recreation - within cooldown period');
      return false;
    }

    console.log('[FRONTEND] Session stopped, recreating...');
    setSessionId(null);
    setPages([]);
    deletedTabIds.current = []; // Reset deleted tabs for recreated session

    try {
      const colorScheme = window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
      const { width, height } = lastViewportRef.current;

      const data = await createSessionMutation.mutateAsync({ colorScheme, width, height });
      const sid = data.sessionId;
      console.log('[FRONTEND] Session recreated:', sid);
      setCdpWsUrlTemplate(data.cdpWsUrlTemplate || null);
      setSessionId(sid);
      sessionCreatedAtRef.current = Date.now();

      const newPages: BrowserPage[] = (data.pages || []).map((p) => ({ ...p, url: p.url ?? '', title: p.title ?? '' }));
      setPages(newPages);
      setActivePageIndex(0);
      deletedTabIds.current = [];

      return true;
    } catch (error) {
      console.error('[FRONTEND] Failed to recreate session:', error);
      return false;
    }
  }, [createSessionMutation]);

  // Update ref when recreateSession changes
  useEffect(() => {
    recreateSessionRef.current = recreateSession;
  }, [recreateSession]);

  const refreshPages = useCallback(
    async (sid: string) => {
      try {
        const data = await refreshPagesMutation.mutateAsync(sid);
        if (data.pages) {
          setPages((prev) => {
            // Build a map of server pages for quick lookup
            const serverPageMap = new Map(
              data.pages!
                .filter((p) => !deletedTabIds.current.includes(p.id))
                .map((p) => [p.id, p]),
            );

            // Preserve favicon and ordering from existing pages
            const faviconMap = new Map(prev.map((p) => [p.id, p.favicon]));

            // Start with existing pages in their current order, updated with server data
            const updatedExisting = prev
              .filter((p) => serverPageMap.has(p.id))
              .map((p) => {
                const serverPage = serverPageMap.get(p.id)!;
                return {
                  ...serverPage,
                  url: serverPage.url ?? '',
                  title: serverPage.title ?? '',
                  favicon: faviconMap.get(p.id),
                };
              });

            // Append any new pages from server that we didn't have before
            const existingIds = new Set(prev.map((p) => p.id));
            const newPages = data.pages!
              .filter((p) => !deletedTabIds.current.includes(p.id) && !existingIds.has(p.id))
              .map((p) => ({ ...p, url: p.url ?? '', title: p.title ?? '' }));

            return [...updatedExisting, ...newPages];
          });
        }
      } catch (error) {
        console.error('Error refreshing pages:', error);
      }
    },
    [refreshPagesMutation],
  );

  const handleTakeControl = useCallback(
    async (width?: number, height?: number) => {
      setIsLoading(true);
      // Store viewport dimensions for session recreation
      lastViewportRef.current = { width, height };

      try {
        const colorScheme = window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
        console.log('[FRONTEND] Creating browser session with dimensions:', { width, height });

        const data = await createSessionMutation.mutateAsync({ colorScheme, width, height });
        const sid = data.sessionId;
        console.log('[FRONTEND] Session created:', sid);
        setCdpWsUrlTemplate(data.cdpWsUrlTemplate || null);
        setSessionId(sid);
        sessionCreatedAtRef.current = Date.now();

        let pages: BrowserPage[] = (data.pages || []).map((p) => ({ ...p, url: p.url ?? '', title: p.title ?? '' }));
        setPages(pages);
        setActivePageIndex(0);
        deletedTabIds.current = []; // Reset deleted tabs for new session

        // Track browser opened event
        posthog.capture('browser_opened', {
          sessionId: sid,
          colorScheme,
          viewportWidth: width,
          viewportHeight: height,
        });
      } catch (error) {
        console.error('Error creating browser session:', error);
        setIsLoading(false);
        throw error;
      } finally {
        setIsLoading(false);
      }
    },
    [createSessionMutation],
  );

  const handleStopSession = useCallback(async () => {
    if (!sessionId) return;

    const sid = sessionId;

    try {
      console.log('[FRONTEND] Stopping session...');

      await stopSessionMutation.mutateAsync(sid);
      console.log('[FRONTEND] Session stopped successfully');
    } catch (error) {
      console.error('Error stopping session:', error);
      try {
        await deleteSessionMutation.mutateAsync(sid);
      } catch (e) {
        console.error('Error in fallback session deletion:', e);
      }
    } finally {
      setSessionId(null);
      setPages([]);
      setActivePageIndex(0);
      setCdpWsUrlTemplate(null);
      deletedTabIds.current = []; // Reset deleted tabs when session is stopped
    }
  }, [sessionId, stopSessionMutation, deleteSessionMutation]);

  const handleResetSession = useCallback(async () => {
    if (!sessionId || !isCDPConnected) return;

    clearInteractions();
    suppressNewTabDetection.current = true;

    try {
      console.log('[FRONTEND CDP] Resetting session...');

      // Get all current targets
      const targetsResult = await getTargets();
      const pageTargets = targetsResult.targetInfos.filter(
        (t) => t.type === 'page' && !t.url.startsWith('devtools://'),
      );

      console.log('[FRONTEND CDP] Found', pageTargets.length, 'page targets');

      // Keep the first page, close others
      const primaryPage = pageTargets[0];
      const pagesToClose = pageTargets.slice(1);

      // Close extra tabs
      for (const page of pagesToClose) {
        try {
          console.log('[FRONTEND CDP] Closing tab:', page.targetId);
          await closeTarget(page.targetId);
        } catch (e) {
          console.warn('[FRONTEND CDP] Failed to close tab:', page.targetId, e);
        }
      }

      // Navigate primary page to Google
      let targetPageId: string;
      if (primaryPage) {
        console.log('[FRONTEND CDP] Navigating primary page to Google');
        await navigate(primaryPage.targetId, 'https://www.google.com');
        targetPageId = primaryPage.targetId;

        setPages([
          {
            id: primaryPage.targetId,
            url: 'https://www.google.com',
            title: 'Google',
          },
        ]);
      } else {
        // No pages exist, create one
        console.log('[FRONTEND CDP] No pages found, creating new tab');
        const result = await createTarget('https://www.google.com');
        targetPageId = result.targetId;
        setPages([
          {
            id: result.targetId,
            url: 'https://www.google.com',
            title: 'Google',
          },
        ]);
      }

      setActivePageIndex(0);
      deletedTabIds.current = [];

      // Focus on the Google search input (retries until element is found)
      // focusElement(targetPageId, '[name="q"]').catch(e => {
      //   console.warn('[FRONTEND CDP] Could not focus search input:', e);
      // });

      console.log('[FRONTEND CDP] Session reset complete');
    } catch (error) {
      console.error('[FRONTEND CDP] Error resetting session:', error);

      // If session stopped, recreate it
      if (isSessionStoppedError(error)) {
        await recreateSession();
      } else {
        await refreshPages(sessionId);
        setActivePageIndex(0);
      }
    } finally {
      setTimeout(() => { suppressNewTabDetection.current = false; }, 1000);
    }
  }, [
    sessionId,
    isCDPConnected,
    getTargets,
    closeTarget,
    navigate,
    createTarget,
    focusElement,
    refreshPages,
    isSessionStoppedError,
    recreateSession,
    clearInteractions,
  ]);

  const handleFocusUrlBar = useCallback(() => {
    setFocusUrlBarTrigger((prev) => prev + 1);
  }, []);

  const handleAddTab = useCallback(async () => {
    if (!sessionId || !isCDPConnected) return;

    const skeletonId = `skeleton-${Date.now()}`;
    const skeletonTab: BrowserPage = {
      id: skeletonId,
      url: '',
      title: 'Loading...',
      isSkeleton: true,
    };

    setPages((prev) => [...prev, skeletonTab]);
    setActivePageIndex(pages.length);
    setIsAddingTab(true);
    suppressNewTabDetection.current = true;

    try {
      // Create new tab via CDP
      console.log('[FRONTEND CDP] Creating new tab...');
      const result = await createTarget('https://www.google.com');
      const newTargetId = result.targetId;
      console.log('[FRONTEND CDP] New tab created:', newTargetId);

      // Set viewport to match the session's dimensions
      const { width, height } = lastViewportRef.current;
      if (width && height) {
        try {
          await sendToPage(newTargetId, 'Emulation.setDeviceMetricsOverride', {
            width: Math.round(width),
            height: Math.round(height),
            deviceScaleFactor: 1,
            mobile: false,
          });
        } catch (e) {
          console.warn('[FRONTEND CDP] Could not set viewport on new tab:', e);
        }
      }

      // Update pages list with the new tab
      const newPage: BrowserPage = {
        id: newTargetId,
        url: 'https://www.google.com',
        title: 'Google',
      };

      setPages((prev) => {
        const filtered = prev.filter((p) => p.id !== skeletonId);
        return [...filtered, newPage];
      });
      setActivePageIndex(pages.length);
      handleFocusUrlBar();

      // Add interaction for new tab
      addInteraction(
        'tab_navigation',
        {
          tagName: 'NEW_TAB',
          text: 'Open new tab',
        },
        newTargetId,
        { type: 'new_tab', url: 'https://www.google.com' },
      );

      // Focus on the Google search input (retries until element is found)
      // focusElement(newTargetId, '[name="q"]').catch(e => {
      //   console.warn('[FRONTEND CDP] Could not focus search input:', e);
      // });
    } catch (error) {
      console.error('[FRONTEND CDP] Error adding tab:', error);
      setPages((prev) => prev.filter((p) => p.id !== skeletonId));

      // If session stopped, recreate it
      if (isSessionStoppedError(error)) {
        await recreateSession();
      }
    } finally {
      setIsAddingTab(false);
      // Delay clearing suppression to ensure any pending Target.targetCreated events are ignored
      setTimeout(() => { suppressNewTabDetection.current = false; }, 1000);
    }
  }, [
    sessionId,
    isCDPConnected,
    pages.length,
    createTarget,
    sendToPage,
    focusElement,
    isSessionStoppedError,
    recreateSession,
    addInteraction,
  ]);

  const handleCloseTab = useCallback(
    async (e: React.MouseEvent, tabId: string) => {
      e.stopPropagation();
      if (!sessionId || !isCDPConnected) return;

      const indexToRemove = pages.findIndex((p) => p.id === tabId);
      if (indexToRemove === -1) return;

      const oldPages = [...pages];
      const newPagesOptimistic = pages.filter((p) => p.id !== tabId);
      setPages(newPagesOptimistic);

      if (activePageIndex >= newPagesOptimistic.length) {
        setActivePageIndex(Math.max(0, newPagesOptimistic.length - 1));
      } else if (activePageIndex > indexToRemove) {
        setActivePageIndex(activePageIndex - 1);
      }

      try {
        // Close tab via CDP
        console.log('[FRONTEND CDP] Closing tab:', tabId);
        await closeTarget(tabId);
        deletedTabIds.current.push(tabId);
        console.log('[FRONTEND CDP] Tab closed successfully');
      } catch (error) {
        console.error('[FRONTEND CDP] Error closing tab:', error);
        setPages(oldPages);

        // If session stopped, recreate it
        if (isSessionStoppedError(error)) {
          await recreateSession();
        }
      }
    },
    [
      sessionId,
      isCDPConnected,
      pages,
      activePageIndex,
      closeTarget,
      isSessionStoppedError,
      recreateSession,
    ],
  );

  const navigateCurrentTab = useCallback(
    async (url: string) => {
      if (!sessionId || !isCDPConnected) return;

      const currentPage = pages[activePageIndex];
      if (!currentPage || currentPage.isSkeleton) return;

      try {
        console.log('[FRONTEND CDP] Navigating to:', url);
        await navigate(currentPage.id, url);

        // Add interaction for URL bar navigation
        addInteraction(
          'tab_navigation',
          {
            tagName: 'URL_NAVIGATION',
            text: `Navigate to ${url}`,
            href: url,
          },
          currentPage.id,
          { type: 'url_navigation', url },
        );

        // Update the page URL optimistically
        setPages((prev) =>
          prev.map((p, i) => (i === activePageIndex ? { ...p, url, title: 'Loading...', favicon: undefined } : p)),
        );

        // Refresh pages after navigation to get updated titles
        setTimeout(() => {
          refreshPages(sessionId).catch((err) =>
            console.error('[FRONTEND CDP] Error refreshing pages after navigation:', err),
          );
        }, 1000);

        console.log('[FRONTEND CDP] Navigation initiated');
      } catch (error) {
        console.error('[FRONTEND CDP] Error navigating:', error);

        // If session stopped, recreate it
        if (isSessionStoppedError(error)) {
          await recreateSession();
        }
      }
    },
    [
      sessionId,
      isCDPConnected,
      pages,
      activePageIndex,
      navigate,
      refreshPages,
      isSessionStoppedError,
      recreateSession,
      addInteraction,
    ],
  );

  const goBackCurrentTab = useCallback(
    async () => {
      if (!sessionId || !isCDPConnected) return;

      const currentPage = pages[activePageIndex];
      if (!currentPage || currentPage.isSkeleton) return;

      try {
        console.log('[FRONTEND CDP] Going back');
        await goBack(currentPage.id);

        addInteraction(
          'tab_navigation',
          {
            tagName: 'NAVIGATION',
            text: 'Go back',
          },
          currentPage.id,
          { type: 'go_back' },
        );
      } catch (error) {
        console.error('[FRONTEND CDP] Error going back:', error);
        if (isSessionStoppedError(error)) {
          await recreateSession();
        }
      }
    },
    [sessionId, isCDPConnected, pages, activePageIndex, goBack, addInteraction, isSessionStoppedError, recreateSession],
  );

  const goForwardCurrentTab = useCallback(
    async () => {
      if (!sessionId || !isCDPConnected) return;

      const currentPage = pages[activePageIndex];
      if (!currentPage || currentPage.isSkeleton) return;

      try {
        console.log('[FRONTEND CDP] Going forward');
        await goForward(currentPage.id);

        addInteraction(
          'tab_navigation',
          {
            tagName: 'NAVIGATION',
            text: 'Go forward',
          },
          currentPage.id,
          { type: 'go_forward' },
        );
      } catch (error) {
        console.error('[FRONTEND CDP] Error going forward:', error);
        if (isSessionStoppedError(error)) {
          await recreateSession();
        }
      }
    },
    [sessionId, isCDPConnected, pages, activePageIndex, goForward, addInteraction, isSessionStoppedError, recreateSession],
  );

  const reloadCurrentTab = useCallback(
    async () => {
      if (!sessionId || !isCDPConnected) return;

      const currentPage = pages[activePageIndex];
      if (!currentPage || currentPage.isSkeleton) return;

      try {
        console.log('[FRONTEND CDP] Reloading page');
        await reload(currentPage.id);

        addInteraction(
          'tab_navigation',
          {
            tagName: 'NAVIGATION',
            text: 'Refresh page',
            href: currentPage.url,
          },
          currentPage.id,
          { type: 'reload', url: currentPage.url },
        );
      } catch (error) {
        console.error('[FRONTEND CDP] Error reloading:', error);
        if (isSessionStoppedError(error)) {
          await recreateSession();
        }
      }
    },
    [sessionId, isCDPConnected, pages, activePageIndex, reload, addInteraction, isSessionStoppedError, recreateSession],
  );

  const handleSetActivePageIndex = useCallback(
    (index: number) => {
      const fromPage = pages[activePageIndex];
      const toPage = pages[index];
      if (index !== activePageIndex) {
        addInteraction(
          'tab_navigation',
          {
            tagName: 'TAB_NAVIGATION',
            text: `Switched from ${fromPage?.title || 'Tab ' + activePageIndex} to ${toPage?.title || 'Tab ' + index}`,
            selector: `tab-${index}`,
            href: toPage?.url,
          },
          toPage?.id,
          {
            fromIndex: activePageIndex,
            toIndex: index,
            fromPageId: fromPage?.id,
            toPageId: toPage?.id,
            fromUrl: fromPage?.url,
            toUrl: toPage?.url,
          },
        );
      }
      setActivePageIndex(index);

      // Tell Chrome to activate this page so it gets rendered.
      // Without this, Chrome throttles background pages and the
      // screencast stops sending frames, causing tabs to appear frozen.
      const targetPage = pages[index];
      if (targetPage && !targetPage.isSkeleton && isCDPConnected) {
        activateTarget(targetPage.id).catch(() => {
          // Non-critical — screencast heartbeat will recover
        });

        // Re-apply viewport override to ensure the screencast frame
        // dimensions match the container. Without this, switching tabs
        // can cause Chrome to revert to the default window-size viewport,
        // producing frames with the wrong aspect ratio and a white bar.
        const { width, height } = lastViewportRef.current;
        if (width && height) {
          sendToPage(targetPage.id, 'Emulation.setDeviceMetricsOverride', {
            width: Math.round(width),
            height: Math.round(height),
            deviceScaleFactor: 1,
            mobile: false,
          }).catch(() => {
            // Non-critical — viewport will still work from previous settings
          });
        }
      }
    },
    [activePageIndex, pages, addInteraction, isCDPConnected, activateTarget, sendToPage],
  );

  // Effects
  useEffect(() => {
    if (!sessionId) return;

    console.log('[FRONTEND] Session active:', sessionId);
  }, [sessionId, pages, activePageIndex]);

  useEffect(() => {
    const handleInteraction = () => setLastInteraction(Date.now());
    const handleWindowBlur = () => {
      setTimeout(() => {
        if (document.activeElement?.tagName === 'IFRAME') handleInteraction();
      }, 100);
    };

    window.addEventListener('mousedown', handleInteraction);
    window.addEventListener('keydown', handleInteraction);
    window.addEventListener('blur', handleWindowBlur);

    return () => {
      window.removeEventListener('mousedown', handleInteraction);
      window.removeEventListener('keydown', handleInteraction);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, []);

  useEffect(() => {
    if (!sessionId) return;

    const interval = setInterval(async () => {
      if (Date.now() - lastInteraction > 5 * 60 * 1000) {
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
          console.log('[FRONTEND] Session no longer valid, recreating...');
          await recreateSession();
        }
      }
    }, 15000);

    return () => clearInterval(interval);
  }, [sessionId, lastInteraction, pingSessionMutation, handleStopSession, recreateSession]);

  useEffect(() => {
    if (!sessionId || !isCDPConnected) return;

    const pageIds = pages.filter((p) => !p.isSkeleton).map((p) => p.id);
    if (pageIds.length > 0) {
      ensurePageConnections(pageIds);
    }
  }, [sessionId, isCDPConnected, pages, ensurePageConnections]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    console.log('Submitted input:', input);
  };

  return (
    <BrowserContext.Provider
      value={{
        input,
        setInput,
        sessionId,
        pages,
        activePageIndex,
        setActivePageIndex: handleSetActivePageIndex,
        isLoading,
        isAddingTab,
        focusUrlBar: focusUrlBarTrigger,
        refreshPages,
        handleTakeControl,
        handleStopSession,
        handleAddTab,
        handleCloseTab,
        handleSubmit,
        setIsLoading,
        interactions,
        removeInteraction,
        handleResetSession,
        navigateCurrentTab,
        goBackCurrentTab,
        goForwardCurrentTab,
        reloadCurrentTab,
        cdpWsUrlTemplate,
      }}
    >
      {children}
    </BrowserContext.Provider>
  );
}

export function useBrowser() {
  const context = useContext(BrowserContext);
  if (context === undefined) {
    throw new Error('useBrowser must be used within a BrowserProvider');
  }
  return context;
}

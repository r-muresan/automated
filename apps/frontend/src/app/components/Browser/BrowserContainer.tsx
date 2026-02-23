import {
  RefObject,
  useCallback,
  useState,
  useRef,
  useEffect,
  useImperativeHandle,
  forwardRef,
} from 'react';
import { Box } from '@chakra-ui/react';
import html2canvas from 'html2canvas-pro';
import { BrowserOverlay } from './BrowserOverlay';
import { BrowserTabs } from './BrowserTabs';
import { BrowserToolbar } from './BrowserToolbar';
import { BrowserContent, BrowserContentRef } from './BrowserContent';

interface Page {
  id: string;
  title?: string;
  url?: string;
  favicon?: string;
  isSkeleton?: boolean;
}

export interface BrowserContainerRef {
  captureCurrentFrame: () => Promise<string | null>;
}

interface BrowserContainerProps {
  containerRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  sessionId: string | null;
  pages: Page[];
  activePageIndex: number;
  setActivePageIndex: (index: number) => void;
  isLoading: boolean;
  isAddingTab: boolean;
  refreshPages: (sessionId: string) => void;
  handleAddTab: () => void;
  focusUrlBar?: number;
  handleCloseTab: (e: React.MouseEvent, pageId: string) => void;
  onNavigate?: (url: string) => void;
  onGoBack?: () => void;
  onGoForward?: () => void;
  onReload?: () => void;
  onOverlayClick?: () => void;
  minimalOverlay?: boolean;
  emptyState?: 'google' | 'skeleton';
  showLoadSkeleton?: boolean;
  readOnly?: boolean;
  freeze?: boolean;
  cdpWsUrlTemplate?: string | null;
}

export const BrowserContainer = forwardRef<BrowserContainerRef, BrowserContainerProps>(
  (
    {
      containerRef,
      contentRef,
      sessionId,
      pages,
      activePageIndex,
      setActivePageIndex,
      isLoading,
      isAddingTab,
      refreshPages,
      handleAddTab,
      focusUrlBar,
      handleCloseTab,
      onNavigate,
      onGoBack,
      onGoForward,
      onReload,
      onOverlayClick,
      minimalOverlay,
      emptyState,
      showLoadSkeleton,
      readOnly,
      freeze = false,
      cdpWsUrlTemplate,
    },
    ref,
  ) => {
    const [isExcelMode, setIsExcelMode] = useState(false);
    const [frozenContentFrame, setFrozenContentFrame] = useState<string | null>(null);

    const activePageRef = useRef<Page | null>(null);
    const isExcelModeRef = useRef(isExcelMode);
    const browserContentRef = useRef<BrowserContentRef>(null);
    const frameCaptureInFlightRef = useRef(false);
    const lastContentFrameRef = useRef<string | null>(null);

    useEffect(() => {
      activePageRef.current = pages[activePageIndex] || null;
    }, [pages, activePageIndex]);

    useEffect(() => {
      isExcelModeRef.current = isExcelMode;
    }, [isExcelMode]);

    const handleFocus = () => {
      if (containerRef.current) {
        containerRef.current.scrollIntoView({ behavior: 'auto', block: 'start' });
      }
    };

    const handleSelectTab = useCallback(
      (index: number) => {
        setIsExcelMode(false);
        setActivePageIndex(index);
      },
      [setActivePageIndex],
    );

    const handleOpenExcel = useCallback(() => {
      setIsExcelMode(true);
    }, []);

    const captureCurrentFrame = useCallback(async (): Promise<string | null> => {
      try {
        const activePage = activePageRef.current;
        if (!activePage || activePage.isSkeleton) return null;

        const contentArea = containerRef.current?.querySelector('.browser-content-area');
        if (!contentArea) return null;

        if (isExcelModeRef.current) {
          const excelCanvas = await html2canvas(contentArea as HTMLElement, {
            useCORS: true,
            allowTaint: true,
            logging: false,
            scale: window.devicePixelRatio,
          });
          return excelCanvas.toDataURL('image/jpeg', 0.85);
        }

        const directFrame = browserContentRef.current?.getFrameDataUrl(activePage.id);
        if (directFrame) {
          return directFrame;
        }

        // Primary: capture directly from the active iframe document when possible.
        const iframe = browserContentRef.current?.getIframeForPage(activePage.id);
        if (iframe) {
          try {
            const doc = iframe.contentDocument;
            if (doc) {
              // Local screencast route exposes the current frame as an <img>.
              const screencastImg = doc.getElementById('screencast') as HTMLImageElement | null;
              if (screencastImg?.src?.startsWith('data:image/')) {
                return screencastImg.src;
              }

              // Browserbase inspector may render to a canvas in the iframe document.
              const inspectorCanvas = doc.querySelector('canvas') as HTMLCanvasElement | null;
              if (inspectorCanvas && inspectorCanvas.width > 0 && inspectorCanvas.height > 0) {
                return inspectorCanvas.toDataURL('image/jpeg', 0.9);
              }
            }
          } catch {
            // Access may fail if iframe internals are cross-origin; use fallback below.
          }
        }

        // Fallback: best-effort DOM capture of the browser content area.
        const fallbackCanvas = await html2canvas(contentArea as HTMLElement, {
          useCORS: true,
          allowTaint: true,
          logging: false,
          scale: window.devicePixelRatio,
        });
        return fallbackCanvas.toDataURL('image/jpeg', 0.85);
      } catch (error) {
        return null;
      }
    }, [containerRef]);

    // Expose methods via ref
    useImperativeHandle(ref, () => ({ captureCurrentFrame }), [captureCurrentFrame]);

    // Keep a recent content frame so freeze can be immediate when execution ends.
    useEffect(() => {
      if (!readOnly || freeze) return;

      let cancelled = false;

      const capture = async () => {
        if (cancelled || frameCaptureInFlightRef.current) return;
        frameCaptureInFlightRef.current = true;
        try {
          const frame = await captureCurrentFrame();
          if (!cancelled && frame) {
            lastContentFrameRef.current = frame;
          }
        } finally {
          frameCaptureInFlightRef.current = false;
        }
      };

      void capture();
      const interval = setInterval(() => {
        void capture();
      }, 500);

      return () => {
        cancelled = true;
        clearInterval(interval);
      };
    }, [readOnly, freeze, captureCurrentFrame]);

    useEffect(() => {
      if (!freeze) {
        setFrozenContentFrame(null);
        return;
      }

      let cancelled = false;

      if (lastContentFrameRef.current) {
        setFrozenContentFrame(lastContentFrameRef.current);
      }

      const captureForFreeze = async () => {
        if (frameCaptureInFlightRef.current) return;
        frameCaptureInFlightRef.current = true;
        try {
          const frame = await captureCurrentFrame();
          if (!cancelled && frame) {
            lastContentFrameRef.current = frame;
            setFrozenContentFrame(frame);
          }
        } finally {
          frameCaptureInFlightRef.current = false;
        }
      };

      void captureForFreeze();

      return () => {
        cancelled = true;
      };
    }, [freeze, captureCurrentFrame]);

    return (
      <Box
        as="main"
        height="full"
        display="flex"
        alignItems="stretch"
        justifyContent="center"
        overflow="hidden"
      >
        <Box
          ref={containerRef}
          onFocusCapture={handleFocus}
          height="full"
          width="full"
          alignSelf="stretch"
          borderRadius="md"
          position="relative"
          overflow="hidden"
          display="flex"
          flexDirection="column"
          shadow="2xl"
          scrollMarginTop="24"
          bg="white"
        >
          {(!sessionId || readOnly) && (
            <BrowserOverlay
              isLoading={isLoading}
              onClick={onOverlayClick}
              minimal={minimalOverlay}
            />
          )}

          <BrowserTabs
            pages={pages}
            activePageIndex={activePageIndex}
            setActivePageIndex={handleSelectTab}
            handleAddTab={handleAddTab}
            handleCloseTab={handleCloseTab}
            refreshPages={refreshPages}
            sessionId={sessionId}
            isAddingTab={isAddingTab}
            onExcelOpen={handleOpenExcel}
            isExcelMode={isExcelMode}
            readOnly={readOnly}
          />

          {!isExcelMode && (
            <BrowserToolbar
              pages={pages}
              activePageIndex={activePageIndex}
              sessionId={sessionId}
              refreshPages={refreshPages}
              onNavigate={onNavigate}
              onGoBack={onGoBack}
              onGoForward={onGoForward}
              onReload={onReload}
              focusUrlBar={focusUrlBar}
              readOnly={readOnly}
            />
          )}

          <BrowserContent
            ref={browserContentRef}
            key="browser-content"
            pages={pages}
            activePageIndex={activePageIndex}
            contentRef={contentRef}
            emptyState={emptyState}
            showLoadSkeleton={showLoadSkeleton}
            isExcelMode={isExcelMode}
            readOnly={readOnly}
            freeze={freeze}
            frozenFrame={frozenContentFrame}
            cdpWsUrlTemplate={cdpWsUrlTemplate}
          />
        </Box>
      </Box>
    );
  },
);

BrowserContainer.displayName = 'BrowserContainer';

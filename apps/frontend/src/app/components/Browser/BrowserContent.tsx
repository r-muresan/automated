'use client';

import {
  RefObject,
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
  forwardRef,
  useImperativeHandle,
} from 'react';
import { Box, VStack, Spinner, Text } from '@chakra-ui/react';
import { Workbook } from '@fortune-sheet/react';
import {
  exportToolBarItem,
  FortuneExcelHelper as ImportHelper,
  importToolBarItem,
} from '@corbe30/fortune-excel';

interface Page {
  id: string;
  title?: string;
  url?: string;
  isSkeleton?: boolean;
}

export interface BrowserContentRef {
  getIframeForPage: (pageId: string) => HTMLIFrameElement | undefined;
}

interface BrowserContentProps {
  pages: Page[];
  activePageIndex: number;
  contentRef: RefObject<HTMLDivElement | null>;
  emptyState?: 'google' | 'skeleton';
  showLoadSkeleton?: boolean;
  sessionId?: string | null;
  isExcelMode?: boolean;
  readOnly?: boolean;
  freeze?: boolean;
  frozenFrame?: string | null;
  inspectorUrlTemplate?: string | null;
}

export const BrowserContent = forwardRef<BrowserContentRef, BrowserContentProps>(
  (
    {
      pages,
      activePageIndex,
      contentRef,
      emptyState = 'google',
      showLoadSkeleton = false,
      sessionId,
      isExcelMode = false,
      readOnly = false,
      freeze = false,
      frozenFrame = null,
      inspectorUrlTemplate = null,
    },
    ref,
  ) => {
    const [loadedPageIds, setLoadedPageIds] = useState<Set<string>>(() => new Set());
    const [excelSheets, setExcelSheets] = useState<any[]>(() => [
      { name: 'Sheet1', celldata: [], zoomRatio: 1.5 },
    ]);
    const [excelWorkbookKey, setExcelWorkbookKey] = useState(0);

    const iframeRefs = useRef<Map<string, HTMLIFrameElement>>(new Map());
    const excelWorkbookRef = useRef<any>(null);

    const handleExcelChange = useCallback((workbook: any) => {
      if (workbook && typeof workbook.getData === 'function') {
        setExcelSheets(workbook.getData());
      }
    }, []);

    const excelToolbarItems = useMemo(() => [exportToolBarItem(), importToolBarItem()], []);

    useEffect(() => {
      if (!showLoadSkeleton) return;
      setLoadedPageIds((prev) => {
        const next = new Set<string>();
        pages.forEach((page) => {
          if (prev.has(page.id)) {
            next.add(page.id);
          }
        });
        return next;
      });
    }, [pages, showLoadSkeleton]);

    const getIframeSrc = (page: Page) => {
      let url: string;
      if (inspectorUrlTemplate) {
        url = inspectorUrlTemplate.replace(/{pageId}/g, page.id);
      } else {
        // Default to local screencast viewer for Browserbase
        url = `/api/local-screencast?ws=connect.browserbase.com/debug/${sessionId}/devtools/page/${page.id}&secure=1`;
      }
      // In read-only (watch) mode, disable the heartbeat so background tabs
      // don't re-request screencast frames and cause tab flickering.
      if (readOnly) {
        url += (url.includes('?') ? '&' : '?') + 'watchOnly=1';
      }
      return url;
    };

    const setIframeRef = useCallback((pageId: string, el: HTMLIFrameElement | null) => {
      if (el) {
        iframeRefs.current.set(pageId, el);
      } else {
        iframeRefs.current.delete(pageId);
      }
    }, []);

    const handleIframeLoad = useCallback(
      (pageId: string) => {
        if (showLoadSkeleton) {
          setLoadedPageIds((prev) => {
            const next = new Set(prev);
            next.add(pageId);
            return next;
          });
        }
      },
      [showLoadSkeleton],
    );

    // When the active tab changes, tell the screencast iframe to bring its
    // CDP page to the front so Chrome produces fresh frames (headless mode).
    // Skip in readOnly mode – the agent controls which tab is active and we
    // must not call Page.bringToFront which could interfere with it.
    useEffect(() => {
      if (readOnly || pages.length === 0 || isExcelMode) return;
      const activePage = pages[activePageIndex];
      if (!activePage || activePage.isSkeleton) return;
      const iframe = iframeRefs.current.get(activePage.id);
      if (iframe?.contentWindow) {
        iframe.contentWindow.postMessage('screencast:activate', '*');
      }
    }, [activePageIndex, pages, isExcelMode, readOnly]);

    // Expose methods via ref
    useImperativeHandle(
      ref,
      () => ({
        getIframeForPage: (pageId: string) => iframeRefs.current.get(pageId),
      }),
      [],
    );

    return (
      <>
        {pages.length > 0 ? (
          <Box
            ref={contentRef}
            flex={1}
            minH={0}
            bg="white"
            position="relative"
            overflow="hidden"
            className="browser-content-area"
            pointerEvents={readOnly ? 'none' : 'auto'}
          >
            {pages.map((page, index) => {
              const isLoaded = loadedPageIds.has(page.id);
              const showSkeleton = showLoadSkeleton && !isLoaded && !page.isSkeleton;

              return (
                <Box
                  key={page.id}
                  position="absolute"
                  inset={0}
                  opacity={activePageIndex === index && !isExcelMode ? 1 : 0}
                  pointerEvents={activePageIndex === index && !isExcelMode ? 'auto' : 'none'}
                >
                  {page.isSkeleton ? (
                    <VStack
                      position="absolute"
                      inset={0}
                      bg="white"
                      align="center"
                      justify="center"
                      gap={4}
                    >
                      <Spinner size="xl" color="blue.500" />
                      <Text color="gray.500" fontWeight="medium">
                        Opening new tab...
                      </Text>
                    </VStack>
                  ) : (
                    <>
                      {showSkeleton && (
                        <VStack
                          position="absolute"
                          inset={0}
                          bg="white"
                          align="center"
                          justify="center"
                          gap={4}
                          zIndex={1}
                        >
                          <Spinner size="xl" color="blue.500" />
                          <Text color="gray.500" fontWeight="medium">
                            Loading...
                          </Text>
                        </VStack>
                      )}
                      <Box
                        as="iframe"
                        ref={(el: HTMLIFrameElement | null) => setIframeRef(page.id, el)}
                        position="absolute"
                        inset={0}
                        width="full"
                        height="full"
                        border="none"
                        opacity={showSkeleton ? 0 : 1}
                        {...({
                          src: getIframeSrc(page),
                          allow: 'clipboard-read; clipboard-write',
                          onLoad: () => handleIframeLoad(page.id),
                          onError: () =>
                            console.error(`[PAGE] ❌ Iframe error for page ${page.id}`),
                        } as any)}
                      />
                    </>
                  )}
                </Box>
              );
            })}
            {isExcelMode && (
              <Box position="absolute" inset={0} bg="white" zIndex={5} width="full" height="full">
                <ImportHelper
                  setKey={setExcelWorkbookKey}
                  setSheets={setExcelSheets}
                  sheetRef={excelWorkbookRef}
                />
                <Workbook
                  key={excelWorkbookKey}
                  ref={excelWorkbookRef}
                  data={excelSheets}
                  onChange={handleExcelChange}
                  customToolbarItems={excelToolbarItems}
                />
              </Box>
            )}
            {freeze && frozenFrame && (
              <Box position="absolute" inset={0} zIndex={30} bg="white" pointerEvents="none">
                <img
                  src={frozenFrame}
                  alt="Frozen browser content"
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'contain',
                    backgroundColor: 'white',
                  }}
                />
              </Box>
            )}
          </Box>
        ) : (
          <Box
            ref={contentRef}
            flex={1}
            minH={0}
            position="relative"
            display="flex"
            alignItems="center"
            justifyContent="center"
            bg="white"
            pointerEvents={readOnly ? 'none' : 'auto'}
          >
            {isExcelMode ? (
              <Box position="absolute" inset={0} bg="white" width="full" height="full">
                <ImportHelper
                  setKey={setExcelWorkbookKey}
                  setSheets={setExcelSheets}
                  sheetRef={excelWorkbookRef}
                />
                <Workbook
                  key={excelWorkbookKey}
                  ref={excelWorkbookRef}
                  data={excelSheets}
                  onChange={handleExcelChange}
                  customToolbarItems={excelToolbarItems}
                />
              </Box>
            ) : (
              <>
                {emptyState === 'skeleton' ? (
                  <VStack align="center" justify="center" gap={4}>
                    <Spinner size="xl" color="blue.500" />
                    <Text color="gray.500" fontWeight="medium">
                      Loading...
                    </Text>
                  </VStack>
                ) : (
                  <Box
                    as="iframe"
                    position="absolute"
                    inset={0}
                    width="full"
                    height="full"
                    border="none"
                    {...({
                      src: 'https://www.google.com/search?igu=1',
                      title: 'Google Preview',
                      style: { colorScheme: 'light' },
                    } as any)}
                  />
                )}
              </>
            )}
          </Box>
        )}
      </>
    );
  },
);

BrowserContent.displayName = 'BrowserContent';

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
import { RemoteCdpPlayer, RemoteCdpPlayerRef } from './RemoteCdpPlayer';

interface Page {
  id: string;
  title?: string;
  url?: string;
  isSkeleton?: boolean;
}

export interface BrowserContentRef {
  /** Active page iframe used for direct frame capture in BrowserContainer. */
  getIframeForPage: (pageId: string) => HTMLIFrameElement | undefined;
  /** Direct frame source exposed by the React CDP player for Browserbase pages. */
  getFrameDataUrl: (pageId: string) => string | null;
}

interface BrowserContentProps {
  pages: Page[];
  activePageIndex: number;
  contentRef: RefObject<HTMLDivElement | null>;
  emptyState?: 'google' | 'skeleton';
  showLoadSkeleton?: boolean;
  cdpWsUrlTemplate?: string | null;
  isExcelMode?: boolean;
  readOnly?: boolean;
  freeze?: boolean;
  frozenFrame?: string | null;
}

export const BrowserContent = forwardRef<BrowserContentRef, BrowserContentProps>(
  (
    {
      pages,
      activePageIndex,
      contentRef,
      emptyState = 'google',
      showLoadSkeleton = false,
      cdpWsUrlTemplate = null,
      isExcelMode = false,
      readOnly = false,
      freeze = false,
      frozenFrame = null,
    },
    ref,
  ) => {
    const [loadedPageIds, setLoadedPageIds] = useState<Set<string>>(() => new Set());
    const [excelSheets, setExcelSheets] = useState<any[]>(() => [
      { name: 'Sheet1', celldata: [], zoomRatio: 1.5 },
    ]);
    const [excelWorkbookKey, setExcelWorkbookKey] = useState(0);

    const iframeRefs = useRef<Map<string, HTMLIFrameElement>>(new Map());
    const remotePlayerRefs = useRef<Map<string, RemoteCdpPlayerRef>>(new Map());

    const excelWorkbookRef = useRef<any>(null);

    const handleExcelChange = useCallback((workbook: any) => {
      if (workbook && typeof workbook.getData === 'function') {
        setExcelSheets(workbook.getData());
      }
    }, []);

    const excelToolbarItems = useMemo(() => [exportToolBarItem(), importToolBarItem()], []);
    const isBrowserbaseSession = useMemo(
      () => Boolean(cdpWsUrlTemplate?.includes('connect.browserbase.com/debug/')),
      [cdpWsUrlTemplate],
    );

    useEffect(() => {
      if (!showLoadSkeleton) return;
      setLoadedPageIds((prev) => {
        const next = new Set<string>();
        pages.forEach((page) => {
          if (prev.has(page.id)) next.add(page.id);
        });
        return next;
      });
    }, [pages, showLoadSkeleton]);

    const setIframeRef = useCallback((pageId: string, el: HTMLIFrameElement | null) => {
      if (el) iframeRefs.current.set(pageId, el);
      else iframeRefs.current.delete(pageId);
    }, []);
    const setRemotePlayerRef = useCallback((pageId: string, el: RemoteCdpPlayerRef | null) => {
      if (el) remotePlayerRefs.current.set(pageId, el);
      else remotePlayerRefs.current.delete(pageId);
    }, []);

    const handleScreencastConnected = useCallback(
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

    // Expose refs to parent
    useImperativeHandle(
      ref,
      () => ({
        getIframeForPage: (pageId) => iframeRefs.current.get(pageId),
        getFrameDataUrl: (pageId) =>
          remotePlayerRefs.current.get(pageId)?.getCurrentFrameDataUrl() || null,
      }),
      [],
    );

    useEffect(() => {
      if (isBrowserbaseSession) return;
      const activePage = pages[activePageIndex];
      if (!activePage || activePage.isSkeleton) return;

      const frame = iframeRefs.current.get(activePage.id);
      frame?.contentWindow?.postMessage('screencast:activate', '*');
    }, [activePageIndex, pages, isBrowserbaseSession]);

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
              const isPageActive = activePageIndex === index && !isExcelMode;
              const wsUrl = cdpWsUrlTemplate ? cdpWsUrlTemplate.replace('{pageId}', page.id) : null;
              const localWsParam = wsUrl ? wsUrl.replace(/^wss?:\/\//, '') : null;
              const localScreencastSrc = localWsParam
                ? `/api/local-screencast?${new URLSearchParams({
                    ws: localWsParam,
                    secure: wsUrl?.startsWith('wss://') ? '1' : '0',
                    watchOnly: readOnly ? '1' : '0',
                  }).toString()}`
                : null;
              const browserbaseWssParam = wsUrl
                ? (() => {
                    if (wsUrl.includes('debug=')) {
                      return wsUrl;
                    }
                    const separator = wsUrl.includes('?') ? '&' : '?';
                    return `${wsUrl}${separator}debug=true`;
                  })()
                : null;
              const iframeSrc = isBrowserbaseSession ? null : localScreencastSrc;

              return (
                <Box
                  key={page.id}
                  position="absolute"
                  inset={0}
                  opacity={isPageActive ? 1 : 0}
                  pointerEvents={isPageActive ? 'auto' : 'none'}
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
                  ) : isBrowserbaseSession && browserbaseWssParam ? (
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
                      <Box position="absolute" inset={0} opacity={showSkeleton ? 0 : 1}>
                        <RemoteCdpPlayer
                          ref={(el) => setRemotePlayerRef(page.id, el)}
                          wsUrl={browserbaseWssParam}
                          pageId={page.id}
                          active={isPageActive}
                          watchOnly={readOnly}
                          onFirstFrame={handleScreencastConnected}
                        />
                      </Box>
                    </>
                  ) : iframeSrc ? (
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
                      <Box position="absolute" inset={0} opacity={showSkeleton ? 0 : 1}>
                        <iframe
                          ref={(el) => setIframeRef(page.id, el)}
                          src={iframeSrc}
                          title={
                            isBrowserbaseSession
                              ? `Remote CDP Player ${page.id}`
                              : `Local Screencast ${page.id}`
                          }
                          width="100%"
                          height="100%"
                          style={{ border: 'none', outline: 'none', colorScheme: 'light' }}
                          onLoad={() => handleScreencastConnected(page.id)}
                        />
                      </Box>
                    </>
                  ) : null}
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
                      style: { outline: 'none', colorScheme: 'light' },
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

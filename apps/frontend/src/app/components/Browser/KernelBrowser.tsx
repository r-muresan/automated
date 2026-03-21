'use client';

import { Box, Spinner, Text, VStack } from '@chakra-ui/react';
import { RefObject, useCallback, useRef, useState } from 'react';
import { FileUploadModal } from './FileUploadModal';
import { useOptionalBrowser } from '../../../providers/browser-provider';
import type { Interaction } from '../../../hooks/useBrowserCDP';

interface KernelBrowserProps {
  contentRef: RefObject<HTMLDivElement | null>;
  sessionId?: string | null;
  kernelLiveViewUrl?: string | null;
  isLoading: boolean;
  readOnly?: boolean;
  freeze?: boolean;
  overlayTitle?: string | null;
  overlayDescription?: string | null;
  onInteraction?: (interaction: Interaction) => void;
  onInteractionUpdate?: (id: string, updates: Partial<Interaction>) => void;
}

export const KernelBrowser = ({
  contentRef,
  sessionId: providedSessionId = null,
  kernelLiveViewUrl,
  isLoading,
  readOnly = false,
  freeze = false,
  overlayTitle = null,
  overlayDescription = null,
}: KernelBrowserProps) => {
  const IFRAME_LOAD_TIMEOUT_MS = 15_000;
  const browser = useOptionalBrowser();
  const sessionId = providedSessionId ?? browser?.sessionId ?? null;
  const downloadedFiles = browser?.downloadedFiles ?? [];
  const fileChooserState = browser?.fileChooserState ?? null;
  const handleFileChooser = browser?.handleFileChooser;
  const loadTimeoutRef = useRef<number | null>(null);

  const onFileChooserAccept = useCallback(
    (files: string[]) => {
      void handleFileChooser?.('accept', files);
    },
    [handleFileChooser],
  );

  const onFileChooserCancel = useCallback(() => {
    void handleFileChooser?.('cancel');
  }, [handleFileChooser]);

  const interactionBlocked = readOnly || freeze;
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const showTerminalOverlay = Boolean(overlayTitle);

  const iframeUrl = kernelLiveViewUrl
    ? readOnly
      ? `${kernelLiveViewUrl}${kernelLiveViewUrl.includes('?') ? '&' : '?'}readOnly=true`
      : kernelLiveViewUrl
    : null;

  const showLoading = !showTerminalOverlay && (isLoading || !iframeUrl || !iframeLoaded);

  const handleIframeLoad = useCallback(() => {
    if (loadTimeoutRef.current !== null) {
      window.clearTimeout(loadTimeoutRef.current);
      loadTimeoutRef.current = null;
    }
    setIframeLoaded(true);
  }, []);

  return (
    <Box
      height="full"
      width="full"
      alignSelf="stretch"
      borderRadius="md"
      position="relative"
      overflow="hidden"
      display="flex"
      flexDirection="column"
      shadow="2xl"
      bg="white"
      ref={contentRef}
    >
      {iframeUrl ? (
        <Box
          key={iframeUrl}
          position="absolute"
          inset={0}
          opacity={showTerminalOverlay ? 0 : 1}
          filter={showTerminalOverlay ? 'blur(3px) saturate(0.85)' : 'none'}
          transform={showTerminalOverlay ? 'scale(1.01)' : 'scale(1)'}
          transition="opacity 0.15s ease, filter 0.3s ease, transform 0.3s ease"
          pointerEvents={interactionBlocked ? 'none' : 'auto'}
        >
          <iframe
            src={iframeUrl}
            onLoad={handleIframeLoad}
            style={{
              width: '100%',
              height: '100%',
              border: 'none',
            }}
            allow="clipboard-read; clipboard-write"
          />
        </Box>
      ) : null}
      <VStack
        position="absolute"
        inset={0}
        zIndex={2}
        px={8}
        bg="rgba(255, 255, 255, 0.88)"
        backdropFilter="blur(12px)"
        align="center"
        justify="center"
        gap={3}
        textAlign="center"
        opacity={showTerminalOverlay ? 1 : 0}
        pointerEvents={showTerminalOverlay ? 'auto' : 'none'}
        transition="opacity 0.3s ease"
      >
        <Text color="app.snow" fontSize="2xl" fontWeight="bold">
          {overlayTitle}
        </Text>
        {overlayDescription ? (
          <Text color="app.muted" fontSize="sm" maxW="sm">
            {overlayDescription}
          </Text>
        ) : null}
      </VStack>
      {showLoading && (
        <VStack
          position="absolute"
          inset={0}
          zIndex={1}
          bg="white"
          align="center"
          justify="center"
          gap={4}
        >
          <Spinner size="xl" color="blue.500" />
          <Text color="gray.500" fontWeight="medium">
            Loading browser...
          </Text>
        </VStack>
      )}
      {sessionId && fileChooserState && (
        <FileUploadModal
          isOpen={true}
          sessionId={sessionId}
          downloadedFiles={downloadedFiles}
          fileChooserMode={fileChooserState.mode}
          onAccept={onFileChooserAccept}
          onCancel={onFileChooserCancel}
        />
      )}
    </Box>
  );
};

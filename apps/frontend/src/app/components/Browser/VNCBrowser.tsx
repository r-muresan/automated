'use client';

import { Box, Spinner, Text, VStack } from '@chakra-ui/react';
import { RefObject, useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { FileUploadModal } from './FileUploadModal';
import { useOptionalBrowser } from '../../../providers/browser-provider';
import type { NoVNCViewerHandle } from './NoVNCViewer';
import type { Interaction } from '../../../hooks/useBrowserCDP';

const NoVNCViewer = dynamic(
  () => import('./NoVNCViewer').then((module) => module.NoVNCViewer),
  { ssr: false },
);

interface VNCBrowserProps {
  contentRef: RefObject<HTMLDivElement | null>;
  sessionId?: string | null;
  vncUrl?: string | null;
  isLoading: boolean;
  readOnly?: boolean;
  freeze?: boolean;
  overlayTitle?: string | null;
  overlayDescription?: string | null;
  /** Ref to access VNC canvas screenshots */
  vncViewerRef?: RefObject<NoVNCViewerHandle | null>;
  onInteraction?: (interaction: Interaction) => void;
  onInteractionUpdate?: (id: string, updates: Partial<Interaction>) => void;
}

export const VNCBrowser = ({
  contentRef,
  sessionId: providedSessionId = null,
  vncUrl,
  isLoading,
  readOnly = false,
  freeze = false,
  overlayTitle = null,
  overlayDescription = null,
  vncViewerRef,
  onInteraction,
  onInteractionUpdate,
}: VNCBrowserProps) => {
  const VNC_CONNECT_TIMEOUT_MS = 8_000;
  const browser = useOptionalBrowser();
  const sessionId = providedSessionId ?? browser?.sessionId ?? null;
  const downloadedFiles = browser?.downloadedFiles ?? [];
  const fileChooserState = browser?.fileChooserState ?? null;
  const handleFileChooser = browser?.handleFileChooser;
  const connectTimeoutRef = useRef<number | null>(null);

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
  const [vncConnected, setVncConnected] = useState(false);
  const showTerminalOverlay = Boolean(overlayTitle);

  const clearConnectTimeout = useCallback(() => {
    if (connectTimeoutRef.current !== null) {
      window.clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }
  }, []);

  const handleConnectionError = useCallback(
    () => {
      clearConnectTimeout();
      setVncConnected(false);
    },
    [clearConnectTimeout],
  );

  const showLoading = !showTerminalOverlay && (isLoading || !vncUrl || !vncConnected);

  useEffect(() => {
    clearConnectTimeout();
    setVncConnected(false);
  }, [clearConnectTimeout, vncUrl]);

  useEffect(
    () => () => {
      clearConnectTimeout();
    },
    [clearConnectTimeout],
  );

  useEffect(() => {
    clearConnectTimeout();
    if (!vncUrl || vncConnected) return;

    connectTimeoutRef.current = window.setTimeout(() => {
      handleConnectionError();
    }, VNC_CONNECT_TIMEOUT_MS);

    return () => clearConnectTimeout();
  }, [clearConnectTimeout, handleConnectionError, vncConnected, vncUrl]);

  useEffect(() => {
    if (!interactionBlocked) return;
    const activeElement = document.activeElement as HTMLElement | null;
    if (contentRef.current && activeElement && contentRef.current.contains(activeElement)) {
      activeElement.blur();
    }
  }, [interactionBlocked, contentRef, vncUrl]);

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
      {vncUrl ? (
        <Box
          key={vncUrl}
          position="absolute"
          inset={0}
          opacity={showTerminalOverlay ? 0 : 1}
          filter={showTerminalOverlay ? 'blur(3px) saturate(0.85)' : 'none'}
          transform={showTerminalOverlay ? 'scale(1.01)' : 'scale(1)'}
          transition="opacity 0.15s ease, filter 0.3s ease, transform 0.3s ease"
          pointerEvents={interactionBlocked ? 'none' : 'auto'}
        >
          <NoVNCViewer
            ref={vncViewerRef}
            vncUrl={vncUrl}
            viewOnly={interactionBlocked}
            scaleViewport={true}
            onInteraction={onInteraction}
            onInteractionUpdate={onInteractionUpdate}
            onConnect={() => {
              clearConnectTimeout();
              setVncConnected(true);
            }}
            onDisconnect={(clean) => {
              clearConnectTimeout();
              if (clean) {
                setVncConnected(false);
                return;
              }
              handleConnectionError();
            }}
            onError={() => {
              handleConnectionError();
            }}
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

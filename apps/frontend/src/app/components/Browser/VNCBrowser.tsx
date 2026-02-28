import { Box, Spinner, Text, VStack } from '@chakra-ui/react';
import { RefObject, useEffect, useState } from 'react';

interface VNCBrowserProps {
  contentRef: RefObject<HTMLDivElement | null>;
  liveViewUrl: string | null;
  isLoading: boolean;
  readOnly?: boolean;
  freeze?: boolean;
  overlayTitle?: string | null;
  overlayDescription?: string | null;
}

export const VNCBrowser = ({
  contentRef,
  liveViewUrl,
  isLoading,
  readOnly = false,
  freeze = false,
  overlayTitle = null,
  overlayDescription = null,
}: VNCBrowserProps) => {
  const interactionBlocked = readOnly || freeze;
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const showTerminalOverlay = Boolean(overlayTitle);
  const showLoading = !showTerminalOverlay && (isLoading || !liveViewUrl || !iframeLoaded);

  useEffect(() => {
    setIframeLoaded(false);
  }, [liveViewUrl]);

  useEffect(() => {
    if (!interactionBlocked) return;
    const iframe = contentRef.current as unknown as HTMLIFrameElement | null;
    if (iframe && document.activeElement === iframe) {
      iframe.blur();
    }
  }, [interactionBlocked, contentRef, liveViewUrl]);

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
      {liveViewUrl && (
        <Box
          as="iframe"
          position="absolute"
          inset={0}
          width="full"
          height="full"
          border="none"
          opacity={showLoading ? 0 : 1}
          filter={showTerminalOverlay ? 'blur(3px) saturate(0.85)' : 'none'}
          transform={showTerminalOverlay ? 'scale(1.01)' : 'scale(1)'}
          transition="opacity 0.15s ease, filter 0.3s ease, transform 0.3s ease"
          onLoad={() => setIframeLoaded(true)}
          {...({
            src: liveViewUrl,
            title: 'Live Browser Preview',
            tabIndex: interactionBlocked ? -1 : 0,
            pointerEvents: interactionBlocked ? 'none' : 'auto',
            style: { outline: 'none', colorScheme: 'light' },
          } as any)}
        />
      )}
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
    </Box>
  );
};

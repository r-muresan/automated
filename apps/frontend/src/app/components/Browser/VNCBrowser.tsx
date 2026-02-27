import { Box, Spinner, Text, VStack } from '@chakra-ui/react';
import { RefObject, useEffect, useState } from 'react';

interface VNCBrowserProps {
  contentRef: RefObject<HTMLDivElement | null>;
  liveViewUrl: string | null;
  isLoading: boolean;
  readOnly?: boolean;
  freeze?: boolean;
}

export const VNCBrowser = ({
  contentRef,
  liveViewUrl,
  isLoading,
  readOnly = false,
  freeze = false,
}: VNCBrowserProps) => {
  const interactionBlocked = readOnly || freeze;
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const showLoading = isLoading || !liveViewUrl || !iframeLoaded;

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
          transition="opacity 0.15s ease"
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

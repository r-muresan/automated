import { Box } from '@chakra-ui/react';
import { RefObject } from 'react';

interface BrowserContainerProps {
  contentRef: RefObject<HTMLDivElement | null>;
  sessionId: string | null;

  liveViewUrl: string | null;

  isLoading: boolean;
  readOnly?: boolean;
  freeze?: boolean;
}

export const VNCBrowser = ({
  contentRef,
  liveViewUrl,
  sessionId,
  isLoading,
  readOnly = false,
  freeze = false,
}: BrowserContainerProps) => {
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
      scrollMarginTop="24"
      bg="white"
    >
      <Box
        ref={contentRef}
        as="iframe"
        position="absolute"
        inset={0}
        width="full"
        height="full"
        border="none"
        {...({
          src: liveViewUrl ?? '',
          title: 'Google Preview',
          style: { outline: 'none', colorScheme: 'light' },
        } as any)}
      />
    </Box>
  );
};

'use client';

import { Dialog, Button, Text, VStack, Portal, Spinner, HStack } from '@chakra-ui/react';

export function RecordingGuideModal({ isOpen, onClose, isBrowserLoading }: { isOpen: boolean; onClose: () => void; isBrowserLoading?: boolean }) {
  return (
    <Dialog.Root lazyMount open={isOpen} closeOnInteractOutside={false}>
      <Portal>
        <Dialog.Backdrop bg="blackAlpha.700" backdropFilter="blur(4px)" />
        <Dialog.Positioner>
          <Dialog.Content
            maxWidth="520px"
            p={2}
            bg="appSurface"
            border="1px solid"
            borderColor="app.border"
            borderRadius="sm"
          >
            <Dialog.Body p={6} pb={4}>
              <VStack align="stretch" gap={5}>
                <Text fontSize="xl" fontWeight="bold" color="app.snow">
                  How to record a workflow
                </Text>

                <Text fontSize="sm" color="app.muted" lineHeight="tall">
                  Use the browser below and walk through your task while narrating each step out
                  loud. When you're done, click "Stop Recording" and we'll turn it into a reusable
                  workflow.
                </Text>
              </VStack>
            </Dialog.Body>

            <Dialog.Footer p={6} pt={2}>
              <Button
                bg="app.primary"
                color="app.onPrimary"
                onClick={onClose}
                size="sm"
                px={6}
                width="full"
                disabled={isBrowserLoading}
              >
                {isBrowserLoading ? (
                  <HStack gap={2}>
                    <Spinner size="sm" />
                    <Text>Loading Browser...</Text>
                  </HStack>
                ) : (
                  'Got it'
                )}
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

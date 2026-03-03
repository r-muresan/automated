'use client';

import { useCallback, useRef, useState } from 'react';
import { Box, Button, HStack, Spinner, Text, VStack } from '@chakra-ui/react';
import { LuFile, LuHardDriveDownload, LuMonitorUp, LuX } from 'react-icons/lu';
import { AppModal } from '../AppModal';
import { useUploadSessionFile } from '../../../hooks/api';
import type { DownloadedFile } from '../../../providers/browser-provider';

interface FileUploadModalProps {
  isOpen: boolean;
  sessionId: string;
  downloadedFiles: DownloadedFile[];
  fileChooserMode: string;
  onAccept: (files: string[]) => void;
  onCancel: () => void;
}

export function FileUploadModal({
  isOpen,
  sessionId,
  downloadedFiles,
  fileChooserMode,
  onAccept,
  onCancel,
}: FileUploadModalProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadMutation = useUploadSessionFile();

  const handleSelectFromComputer = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileSelected = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;

      setIsUploading(true);
      setUploadError(null);

      try {
        const selectedFiles: string[] = [];

        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const result = await uploadMutation.mutateAsync({ sessionId, file });
          const remotePath =
            result.filePath || `/tmp/uploads/${file.name}`;
          selectedFiles.push(remotePath);
        }

        onAccept(selectedFiles);
      } catch (err) {
        console.error('[FileUploadModal] Upload failed:', err);
        setUploadError('Failed to upload file. Please try again.');
      } finally {
        setIsUploading(false);
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
      }
    },
    [onAccept, sessionId, uploadMutation],
  );

  const handleSelectDownloadedFile = useCallback(
    (filename: string) => {
      onAccept([`/tmp/downloads/${filename}`]);
    },
    [onAccept],
  );

  const isMultiple = fileChooserMode === 'selectMultiple';

  return (
    <AppModal
      isOpen={isOpen}
      onClose={onCancel}
      title="Choose a file to upload"
      size="md"
      footer={
        <HStack gap={3} justify="flex-end" width="full">
          <Button
            variant="ghost"
            onClick={onCancel}
            color="app.muted"
            size="sm"
          >
            <LuX />
            Cancel
          </Button>
        </HStack>
      }
    >
      <VStack gap={4} align="stretch">
        {/* Select from computer */}
        <Box>
          <Button
            onClick={handleSelectFromComputer}
            disabled={isUploading}
            width="full"
            variant="outline"
            borderColor="app.border"
            color="app.snow"
            py={6}
            _hover={{ bg: 'whiteAlpha.100' }}
          >
            {isUploading ? (
              <Spinner size="sm" mr={2} />
            ) : (
              <LuMonitorUp style={{ marginRight: 8 }} />
            )}
            {isUploading ? 'Uploading...' : 'Select from your computer'}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple={isMultiple}
            style={{ display: 'none' }}
            onChange={handleFileSelected}
          />
        </Box>

        {uploadError && (
          <Text color="red.400" fontSize="sm">
            {uploadError}
          </Text>
        )}

        {/* Downloaded files section */}
        {downloadedFiles.length > 0 && (
          <Box>
            <HStack gap={2} mb={3}>
              <LuHardDriveDownload size={14} color="var(--chakra-colors-app-muted)" />
              <Text fontSize="sm" color="app.muted" fontWeight="medium">
                Session downloads
              </Text>
            </HStack>
            <VStack gap={1} align="stretch">
              {downloadedFiles.map((file, index) => (
                <Button
                  key={`${file.filename}-${index}`}
                  onClick={() => handleSelectDownloadedFile(file.filename)}
                  disabled={isUploading}
                  variant="ghost"
                  justifyContent="flex-start"
                  py={3}
                  px={3}
                  height="auto"
                  color="app.snow"
                  _hover={{ bg: 'whiteAlpha.100' }}
                  borderRadius="md"
                >
                  <HStack gap={3} width="full">
                    <LuFile size={16} />
                    <Text fontSize="sm" truncate>
                      {file.filename}
                    </Text>
                  </HStack>
                </Button>
              ))}
            </VStack>
          </Box>
        )}

        {downloadedFiles.length === 0 && (
          <Box py={2}>
            <HStack gap={2} mb={1}>
              <LuHardDriveDownload size={14} color="var(--chakra-colors-app-muted)" />
              <Text fontSize="sm" color="app.muted" fontWeight="medium">
                Session downloads
              </Text>
            </HStack>
            <Text fontSize="xs" color="app.muted" pl={6}>
              No files downloaded yet in this session.
            </Text>
          </Box>
        )}
      </VStack>
    </AppModal>
  );
}

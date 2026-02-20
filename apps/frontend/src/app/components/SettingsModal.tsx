'use client';

import { useState, useEffect } from 'react';
import { Box, Button, Flex, Input, Text } from '@chakra-ui/react';
import { AppModal } from './AppModal';
import { useGetSettings, useUpdateSettings } from '../../hooks/api';
import { FiEye, FiEyeOff } from 'react-icons/fi';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const { data: settings, refetch } = useGetSettings();
  const updateSettings = useUpdateSettings();

  useEffect(() => {
    if (isOpen) {
      setApiKey('');
      setShowKey(false);
      setSaveStatus('idle');
    }
  }, [isOpen]);

  const handleSave = async () => {
    if (!apiKey.trim()) return;
    setSaveStatus('saving');
    try {
      await updateSettings.mutateAsync({ openrouterApiKey: apiKey.trim() });
      setSaveStatus('saved');
      refetch();
      setApiKey('');
    } catch {
      setSaveStatus('error');
    }
  };

  const isConfigured = settings?.openrouterApiKey != null;

  return (
    <AppModal
      isOpen={isOpen}
      onClose={onClose}
      title="Settings"
      size="md"
      footer={
        <Flex gap={3} w="100%">
          <Button variant="outline" borderColor="app.border" onClick={onClose}>
            Close
          </Button>
          <Button
            bg="app.primary"
            color="app.onPrimary"
            _hover={{ bg: 'app.primaryAlt' }}
            onClick={handleSave}
            disabled={!apiKey.trim() || saveStatus === 'saving'}
          >
            {saveStatus === 'saving' ? 'Saving...' : 'Save'}
          </Button>
        </Flex>
      }
    >
      <Box>
        <Text fontWeight="medium" mb={2}>
          OpenRouter API Key
        </Text>

        {isConfigured && (
          <Text fontSize="sm" color="green.400" mb={2}>
            Configured: {settings.openrouterApiKey}
          </Text>
        )}
        {!isConfigured && (
          <Text fontSize="sm" color="orange.400" mb={2}>
            Not configured — enter your API key below
          </Text>
        )}

        <Flex gap={2}>
          <Input
            type={showKey ? 'text' : 'password'}
            placeholder="sk-or-v1-..."
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              setSaveStatus('idle');
            }}
            bg="app.bg"
            borderColor="app.border"
            flex={1}
          />
          <Button
            variant="outline"
            borderColor="app.border"
            onClick={() => setShowKey(!showKey)}
            px={3}
          >
            {showKey ? <FiEyeOff /> : <FiEye />}
          </Button>
        </Flex>

        {saveStatus === 'saved' && (
          <Text fontSize="sm" color="green.400" mt={2}>
            API key saved successfully.
          </Text>
        )}
        {saveStatus === 'error' && (
          <Text fontSize="sm" color="red.400" mt={2}>
            Failed to save. Please try again.
          </Text>
        )}

        <Text fontSize="xs" color="app.muted" mt={3}>
          Your API key is stored locally and never sent to any external service besides OpenRouter.
        </Text>
      </Box>
    </AppModal>
  );
}

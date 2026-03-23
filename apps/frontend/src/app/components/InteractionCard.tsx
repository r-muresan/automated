import { Box, Text, Flex, IconButton, Image } from '@chakra-ui/react';
import type { Interaction } from '../../hooks/useBrowserCDP';
import { TranscriptCard } from './TranscriptCard';

interface InteractionCardProps {
  interaction: Interaction;
  stepNumber: number;
  onDelete?: (id: string) => void;
  transcript?: string;
}

// Generate a title for the interaction
function getInteractionTitle(interaction: Interaction): string {
  // Handle new tab creation
  if (interaction.data?.type === 'new_tab') {
    const tabIdx = interaction.data?.tabIndex;
    return tabIdx != null ? `New Tab (tab index ${tabIdx})` : 'New Tab';
  }

  // Handle tab switch
  if (interaction.data?.type === 'switch_tab') {
    const tabIdx = interaction.data?.tabIndex;
    return tabIdx != null ? `Switch to tab ${tabIdx}` : 'Switch tab';
  }

  // Handle URL bar navigation
  if (interaction.data?.type === 'url_navigation') {
    return `Navigate to ${interaction.data?.url || interaction.element?.href || 'page'}`;
  }

  // Handle starting URL
  if (interaction.data?.type === 'starting_url') {
    return `Navigate to ${interaction.element?.href || 'page'}`;
  }

  // Handle tab navigation (fallback)
  if (interaction.type === 'tab_navigation') {
    const toUrl = interaction.data?.toUrl || interaction.element?.href;
    if (toUrl) {
      return `Switch to ${toUrl}`;
    }
    return interaction.element?.text || 'Switch tab';
  }

  if (interaction.type === 'frame_navigation') {
    const url = interaction.element?.href || interaction.data?.url;
    return `Navigate to ${url || 'page'}`;
  }

  // Handle click interactions
  if (interaction.data?.type === 'click') {
    const element = interaction.element;
    let text = element?.text?.trim() || '';
    if (text.length > 30) {
      text = text.substring(0, 30) + '...';
    }
    if (text) {
      return `Click on "${text}"`;
    }
    const tagName = element?.tagName?.toLowerCase() || 'element';
    const tagLabels: Record<string, string> = {
      button: 'button',
      a: 'link',
      input: 'input field',
      select: 'dropdown',
      img: 'image',
      svg: 'icon',
    };
    return `Click on ${tagLabels[tagName] || tagName}`;
  }

  // Handle key press interactions (modifier combos like Ctrl+C)
  if (interaction.data?.type === 'keypress') {
    const combo = interaction.data?.combo || interaction.element?.text || '';
    return `Press ${combo}`;
  }

  // Handle typing interactions
  if (interaction.data?.type === 'keydown') {
    let typedText = interaction.element?.text || '';
    if (typedText.length > 30) {
      typedText = typedText.substring(0, 30) + '...';
    }
    return `Type "${typedText}"`;
  }

  return interaction.element?.text || 'Interaction';
}

// Trash icon SVG
const TrashIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14zM10 11v6M14 11v6" />
  </svg>
);

export const InteractionCard = ({
  interaction,
  stepNumber,
  onDelete,
  transcript,
}: InteractionCardProps) => {
  const isClick = interaction.data?.type === 'click';
  const screenshotUrl = interaction.screenshotUrl;

  const title = getInteractionTitle(interaction);

  return (
    <Box
      bg="app.bgAlt"
      border="1px solid"
      borderColor="app.border"
      borderRadius="sm"
      overflow="hidden"
      _hover={{ borderColor: 'app.primaryAlt' }}
      transition="all 0.2s"
    >
      <Flex px={3} py={3} align="center" gap={3}>
        <Flex
          w="28px"
          h="28px"
          color="app.snow"
          align="center"
          justify="center"
          flexShrink={0}
          fontSize="sm"
          fontWeight="semibold"
        >
          {stepNumber}
        </Flex>

        {/* Title and subtitle */}
        <Box flex={1} minW={0}>
          <Text fontSize="sm" fontWeight="medium" color="app.snow" lineClamp={2}>
            {title}
          </Text>
          {/* {pageId && (
            <Text fontSize="xs" color="gray.500" mt={0.5}>
              Tab {pageId.substring(0, 10)}
            </Text>
          )} */}
        </Box>

        {/* Delete button */}
        {onDelete && (
          <IconButton
            aria-label="Delete step"
            size="sm"
            variant="ghost"
            color="app.muted"
            _hover={{ color: 'red.300', bg: 'red.900' }}
            onClick={(e) => {
              e.stopPropagation();
              onDelete(interaction.id);
            }}
          >
            <TrashIcon />
          </IconButton>
        )}
      </Flex>

      {/* Screenshot for click interactions only */}
      {isClick && screenshotUrl && (
        <Box bg="app.bg" borderTop="1px solid" borderColor="app.border">
          <Image src={screenshotUrl} alt="Click location" w="100%" display="block" />
        </Box>
      )}

      {/* Transcript section */}
      {transcript && (
        <Box px={3} pb={3} pt={isClick && screenshotUrl ? 3 : 0}>
          <TranscriptCard transcript={transcript} />
        </Box>
      )}
    </Box>
  );
};

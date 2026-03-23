'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Box,
  VStack,
  HStack,
  Input,
  Textarea,
  Button,
  IconButton,
  Circle,
  Icon,
  Text,
  Separator,
} from '@chakra-ui/react';
import { LuPlus, LuChevronDown, LuX } from 'react-icons/lu';
import { useOptionalAuth } from '../../providers/auth-provider';
import type { WorkflowStep } from '@automated/api-dtos';
import type { IconType } from 'react-icons';
import {
  FiExternalLink,
  FiGitBranch,
  FiMousePointer,
  FiNavigation,
  FiRepeat,
  FiSave,
  FiSearch,
  FiLayers,
} from 'react-icons/fi';

type StepType = 'step' | 'extract' | 'loop' | 'conditional' | 'navigate' | 'tab_navigate' | 'switch_tab' | 'save';

type EditorStep =
  | { id: string; type: 'step'; description: string }
  | { id: string; type: 'extract'; description: string; dataSchema?: string }
  | { id: string; type: 'navigate'; url: string }
  | { id: string; type: 'tab_navigate'; url: string }
  | { id: string; type: 'switch_tab'; tabIndex: number }
  | { id: string; type: 'save'; description: string }
  | { id: string; type: 'loop'; description: string; steps: EditorStep[] }
  | {
      id: string;
      type: 'conditional';
      condition: string;
      trueSteps: EditorStep[];
      falseSteps: EditorStep[];
    };

type ApiStep = WorkflowStep;

interface WorkflowStepsEditorProps {
  initialTitle: string;
  initialSteps?: ApiStep[];
  onSave?: (title: string, steps: ApiStep[]) => Promise<void>;
  onDelete?: () => Promise<void>;
}

type Branch = 'loop' | 'true' | 'false';
type StepPath = Array<{ index: number; branch: Branch }>;

const STEP_TYPE_OPTIONS: Array<{ type: StepType; label: string; hint: string; icon: IconType }> = [
  { type: 'step', label: 'Step', hint: 'Single action', icon: FiMousePointer },
  { type: 'extract', label: 'Extract', hint: 'Capture data', icon: FiSearch },
  { type: 'loop', label: 'Loop', hint: 'Repeat steps', icon: FiRepeat },
  { type: 'conditional', label: 'Conditional', hint: 'If/else logic', icon: FiGitBranch },
  { type: 'navigate', label: 'Navigate', hint: 'Open URL', icon: FiNavigation },
  { type: 'tab_navigate', label: 'Tab Navigate', hint: 'New tab', icon: FiExternalLink },
  { type: 'switch_tab', label: 'Switch Tab', hint: 'Switch tab', icon: FiLayers },
  { type: 'save', label: 'Save', hint: 'Persist data', icon: FiSave },
];

const STEP_TYPE_META = STEP_TYPE_OPTIONS.reduce(
  (acc, option) => {
    acc[option.type] = option;
    return acc;
  },
  {} as Record<StepType, (typeof STEP_TYPE_OPTIONS)[number]>,
);

const TYPE_COLORS: Record<StepType, { bg: string; border: string }> = {
  step: { bg: 'white', border: 'gray.200' },
  extract: { bg: 'blue.50', border: 'blue.200' },
  loop: { bg: 'orange.50', border: 'orange.200' },
  conditional: { bg: 'purple.50', border: 'purple.200' },
  navigate: { bg: 'green.50', border: 'green.200' },
  tab_navigate: { bg: 'green.50', border: 'green.200' },
  switch_tab: { bg: 'teal.50', border: 'teal.200' },
  save: { bg: 'gray.50', border: 'gray.200' },
};

function createId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `step-${Math.random().toString(36).slice(2, 10)}`;
}

function toEditorStep(step: ApiStep): EditorStep {
  const id = createId();
  switch (step.type) {
    case 'loop':
      return {
        id,
        type: 'loop',
        description: step.description ?? '',
        steps: (step.steps ?? []).map(toEditorStep),
      };
    case 'conditional':
      return {
        id,
        type: 'conditional',
        condition: step.condition ?? '',
        trueSteps: (step.trueSteps ?? []).map(toEditorStep),
        falseSteps: (step.falseSteps ?? []).map(toEditorStep),
      };
    case 'extract':
      return {
        id,
        type: 'extract',
        description: step.description ?? '',
        dataSchema: step.dataSchema ?? '',
      };
    case 'navigate':
      return {
        id,
        type: 'navigate',
        url: step.url ?? '',
      };
    case 'tab_navigate':
      return {
        id,
        type: 'tab_navigate',
        url: step.url ?? '',
      };
    case 'save':
      return {
        id,
        type: 'save',
        description: step.description ?? '',
      };
    case 'switch_tab':
      return {
        id,
        type: 'switch_tab',
        tabIndex: step.tabIndex ?? 0,
      };
    case 'step':
    default:
      return {
        id,
        type: 'step',
        description: step.description ?? '',
      };
  }
}

function toApiStep(step: EditorStep): ApiStep {
  switch (step.type) {
    case 'loop':
      return {
        type: 'loop',
        description: step.description,
        steps: step.steps.map(toApiStep),
      };
    case 'conditional':
      return {
        type: 'conditional',
        condition: step.condition,
        trueSteps: step.trueSteps.map(toApiStep),
        falseSteps: step.falseSteps.length > 0 ? step.falseSteps.map(toApiStep) : [],
      };
    case 'extract':
      return {
        type: 'extract',
        description: step.description,
        dataSchema: step.dataSchema || undefined,
      };
    case 'navigate':
      return {
        type: 'navigate',
        url: step.url,
      };
    case 'tab_navigate':
      return {
        type: 'tab_navigate',
        url: step.url,
      };
    case 'switch_tab':
      return {
        type: 'switch_tab',
        tabIndex: step.tabIndex,
      };
    case 'save':
      return {
        type: 'save',
        description: step.description,
      };
    case 'step':
    default:
      return {
        type: 'step',
        description: step.description,
      };
  }
}

function createNewStep(type: StepType): EditorStep {
  switch (type) {
    case 'loop':
      return { id: createId(), type: 'loop', description: '', steps: [] };
    case 'conditional':
      return {
        id: createId(),
        type: 'conditional',
        condition: '',
        trueSteps: [],
        falseSteps: [],
      };
    case 'extract':
      return { id: createId(), type: 'extract', description: '', dataSchema: '' };
    case 'navigate':
      return { id: createId(), type: 'navigate', url: '' };
    case 'tab_navigate':
      return { id: createId(), type: 'tab_navigate', url: '' };
    case 'switch_tab':
      return { id: createId(), type: 'switch_tab', tabIndex: 0 };
    case 'save':
      return { id: createId(), type: 'save', description: '' };
    case 'step':
    default:
      return { id: createId(), type: 'step', description: '' };
  }
}

function createStepWithId(type: StepType, id: string): EditorStep {
  switch (type) {
    case 'loop':
      return { id, type: 'loop', description: '', steps: [] };
    case 'conditional':
      return { id, type: 'conditional', condition: '', trueSteps: [], falseSteps: [] };
    case 'extract':
      return { id, type: 'extract', description: '', dataSchema: '' };
    case 'navigate':
      return { id, type: 'navigate', url: '' };
    case 'tab_navigate':
      return { id, type: 'tab_navigate', url: '' };
    case 'switch_tab':
      return { id, type: 'switch_tab', tabIndex: 0 };
    case 'save':
      return { id, type: 'save', description: '' };
    case 'step':
    default:
      return { id, type: 'step', description: '' };
  }
}

function changeStepType(step: EditorStep, nextType: StepType): EditorStep {
  if (step.type === nextType) return step;

  const description =
    'description' in step ? step.description : step.type === 'conditional' ? step.condition : '';
  const url = step.type === 'navigate' || step.type === 'tab_navigate' ? step.url : '';
  const next = createStepWithId(nextType, step.id);

  if ('description' in next && description) {
    next.description = description;
  }

  if ('url' in next && url) {
    next.url = url;
  }

  if (next.type === 'conditional') {
    next.condition = step.type === 'conditional' ? step.condition : description;
  }

  if (next.type === 'extract' && step.type === 'extract') {
    next.dataSchema = step.dataSchema ?? '';
  }

  return next;
}

function updateListAtPath(
  steps: EditorStep[],
  path: StepPath,
  updater: (list: EditorStep[]) => EditorStep[],
): EditorStep[] {
  if (path.length === 0) {
    return updater(steps);
  }

  const [head, ...rest] = path;
  return steps.map((step, index) => {
    if (index !== head.index) return step;

    if (step.type === 'loop' && head.branch === 'loop') {
      return {
        ...step,
        steps: updateListAtPath(step.steps, rest, updater),
      };
    }

    if (step.type === 'conditional') {
      if (head.branch === 'true') {
        return {
          ...step,
          trueSteps: updateListAtPath(step.trueSteps, rest, updater),
        };
      }
      if (head.branch === 'false') {
        return {
          ...step,
          falseSteps: updateListAtPath(step.falseSteps, rest, updater),
        };
      }
    }

    return step;
  });
}

function buildPath(parentPath: StepPath, index: number, branch: Branch): StepPath {
  return [...parentPath, { index, branch }];
}

function InsertStepControl({
  onInsert,
  forceVisible = false,
}: {
  onInsert: (type: StepType) => void;
  forceVisible?: boolean;
}) {
  const [isAreaHovered, setIsAreaHovered] = useState(false);
  const [isButtonHovered, setIsButtonHovered] = useState(false);

  const showButton = forceVisible || isAreaHovered;
  const showDropdown = isButtonHovered;

  return (
    <Box
      position="relative"
      py={2}
      onMouseEnter={() => setIsAreaHovered(true)}
      onMouseLeave={() => {
        setIsAreaHovered(false);
        setIsButtonHovered(false);
      }}
    >
      <Box
        position="relative"
        display="flex"
        justifyContent="center"
        alignItems="center"
        minH="30px"
      >
        {/* Button wrapper for dropdown hover */}
        <Box
          position="relative"
          onMouseEnter={() => setIsButtonHovered(true)}
          onMouseLeave={() => setIsButtonHovered(false)}
        >
          <IconButton
            aria-label="Add step"
            size="xs"
            borderRadius="full"
            bg="white"
            border="1px solid"
            borderColor="gray.200"
            color="gray.500"
            shadow="sm"
            opacity={showButton ? 1 : 0}
            _hover={{ transform: 'scale(1.05)', bg: 'gray.50' }}
            transition="all 0.2s"
            mt={-2}
          >
            <LuPlus fontSize="xs" />
          </IconButton>

          {/* Dropdown menu - appears on button hover */}
          <Box
            position="absolute"
            top="100%"
            left="50%"
            transform="translateX(-50%)"
            pt={2}
            opacity={showDropdown ? 1 : 0}
            pointerEvents={showDropdown ? 'auto' : 'none'}
            transition="opacity 0.2s"
            zIndex={10}
          >
            <VStack
              align="stretch"
              bg="white"
              border="1px solid"
              borderColor="gray.200"
              borderRadius="md"
              p={2}
              shadow="md"
              minW="180px"
            >
              {STEP_TYPE_OPTIONS.map((option) => (
                <Button
                  key={option.type}
                  size="sm"
                  variant="ghost"
                  justifyContent="space-between"
                  onClick={() => onInsert(option.type)}
                >
                  <HStack gap={2}>
                    <Icon as={option.icon} boxSize={3.5} color="gray.600" />
                    <Text fontSize="sm" fontWeight="semibold">
                      {option.label}
                    </Text>
                  </HStack>
                  <Text fontSize="xs" color="gray.500">
                    {option.hint}
                  </Text>
                </Button>
              ))}
            </VStack>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

function StepTypeDropdown({
  value,
  onChange,
}: {
  value: StepType;
  onChange: (type: StepType) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const current = STEP_TYPE_META[value];

  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (event: MouseEvent) => {
      if (!containerRef.current) return;
      if (containerRef.current.contains(event.target as Node)) return;
      setIsOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen]);

  return (
    <Box position="relative" ref={containerRef}>
      <Button
        size="sm"
        variant="subtle"
        borderRadius="full"
        bg="white"
        border="1px solid"
        borderColor="gray.200"
        px={3}
        onClick={() => setIsOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <HStack gap={2}>
          <Icon as={current.icon} boxSize={3.5} color="gray.600" />
          <Text fontSize="sm" fontWeight="semibold">
            {current.label}
          </Text>
          <Icon as={LuChevronDown} boxSize="12px" color="gray.500" />
        </HStack>
      </Button>
      <Box
        position="absolute"
        top="calc(100% + 8px)"
        left={0}
        zIndex={20}
        opacity={isOpen ? 1 : 0}
        pointerEvents={isOpen ? 'auto' : 'none'}
        transition="opacity 0.2s"
      >
        <VStack
          align="stretch"
          bg="white"
          border="1px solid"
          borderColor="gray.200"
          borderRadius="md"
          p={2}
          shadow="md"
          minW="220px"
        >
          {STEP_TYPE_OPTIONS.map((option) => (
            <Button
              key={option.type}
              size="sm"
              variant={option.type === value ? 'subtle' : 'ghost'}
              justifyContent="space-between"
              onClick={() => {
                onChange(option.type);
                setIsOpen(false);
              }}
            >
              <HStack gap={2}>
                <Icon as={option.icon} boxSize={3.5} color="gray.600" />
                <Text fontSize="sm" fontWeight="semibold">
                  {option.label}
                </Text>
              </HStack>
              <Text fontSize="xs" color="gray.500">
                {option.hint}
              </Text>
            </Button>
          ))}
        </VStack>
      </Box>
    </Box>
  );
}

export function WorkflowStepsEditor({
  initialTitle,
  initialSteps,
  onSave,
  onDelete,
}: WorkflowStepsEditorProps) {
  const [title, setTitle] = useState(initialTitle);
  const [steps, setSteps] = useState<EditorStep[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const { isLoaded } = useOptionalAuth();

  useEffect(() => {
    if (initialSteps && initialSteps.length > 0) {
      setSteps(initialSteps.map(toEditorStep));
      return;
    }
    setSteps([]);
  }, [initialSteps]);

  const handleSave = async () => {
    if (!isLoaded) return;
    if (!onSave) return;

    setIsSaving(true);
    try {
      const payload = steps.map(toApiStep);
      await onSave(title, payload);
    } catch (error) {
      console.error('Failed to save workflow:', error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!onDelete) return;

    setIsDeleting(true);
    try {
      await onDelete();
    } catch (error) {
      console.error('Failed to delete workflow:', error);
    } finally {
      setIsDeleting(false);
    }
  };

  const insertStep = (path: StepPath, index: number, type: StepType) => {
    const newStep = createNewStep(type);
    setSteps((prev) =>
      updateListAtPath(prev, path, (list) => {
        const next = [...list];
        next.splice(index, 0, newStep);
        return next;
      }),
    );
  };

  const deleteStep = (path: StepPath, index: number) => {
    setSteps((prev) =>
      updateListAtPath(prev, path, (list) => list.filter((_, idx) => idx !== index)),
    );
  };

  const updateStepAt = (
    path: StepPath,
    index: number,
    updater: (step: EditorStep) => EditorStep,
  ) => {
    setSteps((prev) =>
      updateListAtPath(prev, path, (list) =>
        list.map((step, idx) => (idx === index ? updater(step) : step)),
      ),
    );
  };

  const renderStepList = (list: EditorStep[], path: StepPath) => {
    if (list.length === 0) {
      return <InsertStepControl forceVisible onInsert={(type) => insertStep(path, 0, type)} />;
    }

    return (
      <VStack align="stretch" gap={2}>
        {list.map((step, index) => (
          <Box key={step.id}>
            <InsertStepControl onInsert={(type) => insertStep(path, index, type)} />
            {renderStepCard(step, index, path)}
          </Box>
        ))}
        <InsertStepControl onInsert={(type) => insertStep(path, list.length, type)} />
      </VStack>
    );
  };

  const renderStepCard = (step: EditorStep, index: number, path: StepPath) => {
    const colors = TYPE_COLORS[step.type];

    return (
      <Box
        border="1px solid"
        borderColor={colors.border}
        bg={colors.bg}
        borderRadius="lg"
        p={4}
        shadow="xs"
      >
        <HStack justify="space-between" align="flex-start">
          <HStack gap={3} align="center">
            <Circle size="28px" bg="gray.100" color="gray.600" fontSize="sm" fontWeight="semibold">
              {index + 1}
            </Circle>
            <StepTypeDropdown
              value={step.type}
              onChange={(nextType) =>
                updateStepAt(path, index, (current) => changeStepType(current, nextType))
              }
            />
          </HStack>
          <IconButton
            aria-label="Delete step"
            size="sm"
            variant="ghost"
            color="gray.400"
            _hover={{ bg: 'red.50', color: 'red.500' }}
            onClick={() => deleteStep(path, index)}
          >
            <LuX fontSize="xs" />
          </IconButton>
        </HStack>

        <Box mt={3}>
          {step.type === 'step' && (
            <Textarea
              value={step.description}
              onChange={(e) =>
                updateStepAt(path, index, (current) => ({
                  ...current,
                  description: e.target.value,
                }))
              }
              rows={2}
              bg="white"
              placeholder="Describe the action"
            />
          )}

          {step.type === 'save' && (
            <Textarea
              value={step.description}
              onChange={(e) =>
                updateStepAt(path, index, (current) => ({
                  ...current,
                  description: e.target.value,
                }))
              }
              rows={2}
              bg="white"
              placeholder="What should be saved?"
            />
          )}

          {step.type === 'extract' && (
            <VStack align="stretch" gap={3}>
              <Textarea
                value={step.description}
                onChange={(e) =>
                  updateStepAt(path, index, (current) => ({
                    ...current,
                    description: e.target.value,
                  }))
                }
                rows={2}
                bg="white"
                placeholder="What data should be extracted?"
              />
              <Input
                value={step.dataSchema ?? ''}
                onChange={(e) =>
                  updateStepAt(path, index, (current) => ({
                    ...current,
                    dataSchema: e.target.value,
                  }))
                }
                bg="white"
                placeholder="Data schema (e.g. { name: string, email: string })"
              />
            </VStack>
          )}

          {step.type === 'navigate' && (
            <Input
              value={step.url}
              onChange={(e) =>
                updateStepAt(path, index, (current) => ({
                  ...current,
                  url: e.target.value,
                }))
              }
              bg="white"
              placeholder="https://example.com"
            />
          )}

          {step.type === 'tab_navigate' && (
            <Input
              value={step.url}
              onChange={(e) =>
                updateStepAt(path, index, (current) => ({
                  ...current,
                  url: e.target.value,
                }))
              }
              bg="white"
              placeholder="https://example.com"
            />
          )}

          {step.type === 'switch_tab' && (
            <Input
              type="number"
              value={step.tabIndex}
              onChange={(e) =>
                updateStepAt(path, index, (current) => ({
                  ...current,
                  tabIndex: parseInt(e.target.value, 10) || 0,
                }))
              }
              bg="white"
              placeholder="Tab index"
            />
          )}

          {step.type === 'loop' && (
            <VStack align="stretch" gap={4}>
              <Textarea
                value={step.description}
                onChange={(e) =>
                  updateStepAt(path, index, (current) => ({
                    ...current,
                    description: e.target.value,
                  }))
                }
                rows={2}
                bg="white"
                placeholder="What are we looping over?"
              />
              <Box
                borderLeft="3px solid"
                borderColor="orange.200"
                pl={4}
                py={2}
                bg="whiteAlpha.700"
                borderRadius="md"
              >
                <Text fontSize="sm" color="orange.700" mb={2} fontWeight="semibold">
                  Loop steps
                </Text>
                {renderStepList(step.steps, buildPath(path, index, 'loop'))}
              </Box>
            </VStack>
          )}

          {step.type === 'conditional' && (
            <VStack align="stretch" gap={4}>
              <Input
                value={step.condition}
                onChange={(e) =>
                  updateStepAt(path, index, (current) => ({
                    ...current,
                    condition: e.target.value,
                  }))
                }
                bg="white"
                placeholder="Condition (e.g. if logged in)"
              />
              <Box
                borderLeft="3px solid"
                borderColor="purple.200"
                pl={4}
                py={2}
                bg="whiteAlpha.700"
                borderRadius="md"
              >
                <Text fontSize="sm" color="purple.700" mb={2} fontWeight="semibold">
                  If true
                </Text>
                {renderStepList(step.trueSteps, buildPath(path, index, 'true'))}
              </Box>
              <Box
                borderLeft="3px solid"
                borderColor="purple.200"
                pl={4}
                py={2}
                bg="whiteAlpha.700"
                borderRadius="md"
              >
                <Text fontSize="sm" color="purple.700" mb={2} fontWeight="semibold">
                  If false
                </Text>
                {renderStepList(step.falseSteps, buildPath(path, index, 'false'))}
              </Box>
            </VStack>
          )}
        </Box>
      </Box>
    );
  };

  const stepsContent = renderStepList(steps, []);

  return (
    <VStack gap={4} align="stretch" mt={6}>
      <Box>
        <Input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          variant="flushed"
          borderBottom="2px solid"
          borderColor="gray.200"
          color="black"
          fontSize="3xl"
          fontWeight="bold"
          px={0}
          pb={4}
          pt={2}
          placeholder="Workflow title"
          _focus={{ outline: 'none', borderColor: 'black' }}
          transition="all 0.2s"
        />
      </Box>

      <Box>
        {stepsContent}

        <Separator my={6} />

        <Box display="flex" justifyContent="flex-end" alignItems="center" gap={3}>
          <Button onClick={handleSave} loading={isSaving} variant="solid" size="lg">
            Save Workflow
          </Button>

          <Button
            onClick={handleDelete}
            loading={isDeleting}
            variant="outline"
            size="lg"
            colorScheme="red"
            borderColor="red.200"
            color="red.500"
            _hover={{ bg: 'red.50' }}
          >
            Delete Workflow
          </Button>
        </Box>
      </Box>
    </VStack>
  );
}

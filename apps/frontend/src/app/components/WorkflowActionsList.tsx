import { useState } from 'react';
import { Box, VStack, Text, Code, Flex, Spinner, Icon, Button } from '@chakra-ui/react';
import { LuCheck, LuTriangleAlert, LuRepeat } from 'react-icons/lu';
import { keyframes } from '@emotion/react';
import type { WorkflowAction, ApiDate } from '@automated/api-dtos';
import { downloadWorkflowOutput, sanitizeFileName } from '../utils/workflowOutputDownload';

interface WorkflowActionsListProps {
  actions: WorkflowAction[];
  workflowTitle?: string;
  onContinueExecution?: (request: PendingCredentialRequestView) => void;
  continuingRequestId?: string | null;
}

type StepStatus = 'running' | 'success' | 'failed';

interface SaveOutputView {
  output: string;
  outputExtension: string;
  savedFileIndex?: number;
  fallback?: boolean;
}

export interface PendingCredentialRequestView {
  requestId: string;
  reason: string;
  buttonLabel: string;
}

interface SubStepView {
  key: string;
  stepType?: string;
  instruction?: string;
  message?: string;
  status: StepStatus;
  error?: string;
  startedAt?: ApiDate;
  finishedAt?: ApiDate;
}

interface IterationView {
  iteration: number;
  totalItems: number;
  status: StepStatus;
  subSteps: SubStepView[];
}

interface StepActionView {
  key: string;
  stepIndex?: number;
  stepType?: string;
  instruction?: string;
  message?: string;
  startedAt?: ApiDate;
  finishedAt?: ApiDate;
  status: StepStatus;
  error?: string;
  isLoop?: boolean;
  loopDescription?: string;
  iterations?: IterationView[];
  saveOutput?: SaveOutputView;
  pendingCredentialRequest?: PendingCredentialRequestView;
}

const buildActionViews = (actions: WorkflowAction[]): StepActionView[] => {
  // Sort by timestamp with array index as tiebreaker to preserve insertion order
  // for events that share the same millisecond timestamp
  const sorted = actions
    .map((a, i) => ({ ...a, _order: i }))
    .sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime() || a._order - b._order,
    );
  const byIndex = new Map<number, StepActionView>();
  const fallback: StepActionView[] = [];

  // Track which step indices are loops and their current iteration
  const loopStepIndices = new Set<number>();
  for (const action of sorted) {
    if (action.eventType === 'loop:iteration:start' || action.eventType === 'loop:iteration:end') {
      const stepIndex = action.data?.stepIndex;
      if (typeof stepIndex === 'number') loopStepIndices.add(stepIndex);
    }
  }

  // Track which iteration we're in for each loop step
  const currentIteration = new Map<number, number>();
  // Track nesting depth of step events within each loop iteration.
  // Only depth-0 events become visible sub-steps; deeper events (e.g. steps inside a conditional's
  // true branch) are hidden and their completion updates the parent sub-step.
  const loopNestingDepth = new Map<number, number>();
  const findStepSlotKey = (targetStepIndex: number, preferRunning = false): number | undefined => {
    let selected: number | undefined;
    for (const [key, view] of byIndex.entries()) {
      if (view.stepIndex !== targetStepIndex) continue;
      if (preferRunning && view.status !== 'running') continue;
      if (selected === undefined || key > selected) selected = key;
    }
    return selected;
  };

  for (const action of sorted) {
    const stepIndex = action.data?.stepIndex;
    const stepType = action.data?.stepType;
    const instruction = action.data?.instruction;
    const error = action.data?.error;
    const success = action.data?.success;
    const output = action.data?.output;
    const outputExtension = action.data?.outputExtension;
    const savedFileIndex = action.data?.savedFileIndex;
    const isFallbackOutput = action.data?.fallback;

    // Handle loop iteration events
    if (action.eventType === 'loop:iteration:start' && typeof stepIndex === 'number') {
      const iteration = action.data?.iteration ?? 1;
      const totalItems = action.data?.totalItems ?? 0;
      currentIteration.set(stepIndex, iteration);
      loopNestingDepth.set(stepIndex, 0);

      const existing = byIndex.get(stepIndex) ?? {
        key: `step-${stepIndex}`,
        stepIndex,
        status: 'running' as StepStatus,
        isLoop: true,
        iterations: [],
      };
      existing.isLoop = true;
      if (!existing.iterations) existing.iterations = [];

      existing.iterations.push({
        iteration,
        totalItems,
        status: 'running',
        subSteps: [],
      });

      byIndex.set(stepIndex, existing);
      continue;
    }

    if (action.eventType === 'loop:iteration:end' && typeof stepIndex === 'number') {
      const iteration = action.data?.iteration ?? 1;
      const existing = byIndex.get(stepIndex);
      if (existing?.iterations) {
        const iterView = existing.iterations.find((it) => it.iteration === iteration);
        if (iterView) {
          iterView.status = success === false ? 'failed' : 'success';
        }
      }
      currentIteration.delete(stepIndex);
      loopNestingDepth.delete(stepIndex);
      continue;
    }

    if (action.eventType === 'credential:request' && typeof stepIndex === 'number') {
      const slotKey =
        findStepSlotKey(stepIndex, true) ?? findStepSlotKey(stepIndex) ?? stepIndex;
      const existing =
        byIndex.get(slotKey) ??
        ({
          key: `step-${slotKey}`,
          stepIndex,
          status: 'running',
        } satisfies StepActionView);

      existing.stepType = existing.stepType ?? stepType;
      existing.instruction = existing.instruction ?? instruction;
      existing.message = existing.message ?? action.message;
      existing.pendingCredentialRequest = {
        requestId: String(action.data?.requestId ?? action.id),
        reason:
          typeof action.data?.reason === 'string'
            ? action.data.reason
            : 'Complete the required credential step in the browser, then continue execution.',
        buttonLabel:
          typeof action.data?.buttonLabel === 'string'
            ? action.data.buttonLabel
            : 'Continue Execution',
      };
      byIndex.set(slotKey, existing);
      continue;
    }

    if (action.eventType === 'credential:continue' && typeof stepIndex === 'number') {
      const targetRequestId =
        typeof action.data?.requestId === 'string' ? action.data.requestId : undefined;
      const slotKey =
        findStepSlotKey(stepIndex, true) ?? findStepSlotKey(stepIndex);
      if (slotKey !== undefined) {
        const existing = byIndex.get(slotKey);
        if (
          existing?.pendingCredentialRequest &&
          (!targetRequestId || existing.pendingCredentialRequest.requestId === targetRequestId)
        ) {
          existing.pendingCredentialRequest = undefined;
          byIndex.set(slotKey, existing);
        }
      }
      continue;
    }

    // Check if this step:start/step:end belongs inside a loop iteration
    if (typeof stepIndex === 'number') {
      let parentLoopIndex: number | undefined;
      for (const loopIdx of loopStepIndices) {
        const iter = currentIteration.get(loopIdx);
        if (iter !== undefined) {
          parentLoopIndex = loopIdx;
          break;
        }
      }

      if (parentLoopIndex !== undefined) {
        const depth = loopNestingDepth.get(parentLoopIndex) ?? 0;
        const loopView = byIndex.get(parentLoopIndex);
        const iter = currentIteration.get(parentLoopIndex);

        if (action.eventType === 'step:start') {
          if (depth === 0 && loopView?.iterations && iter !== undefined) {
            // Top-level sub-step: create a visible entry
            const iterView = loopView.iterations.find((it) => it.iteration === iter);
            if (iterView) {
              iterView.subSteps.push({
                key: `loop-${parentLoopIndex}-iter-${iter}-sub-${iterView.subSteps.length}`,
                stepType,
                instruction,
                message: action.message,
                status: 'running',
                startedAt: action.timestamp,
              });
            }
          }
          // Increase nesting depth (nested steps like conditional true-branch children are hidden)
          loopNestingDepth.set(parentLoopIndex, depth + 1);
        } else if (action.eventType === 'step:end') {
          const newDepth = Math.max(0, depth - 1);
          loopNestingDepth.set(parentLoopIndex, newDepth);

          if (newDepth === 0 && loopView?.iterations && iter !== undefined) {
            // Top-level sub-step completed: update the last running sub-step
            const iterView = loopView.iterations.find((it) => it.iteration === iter);
            if (iterView) {
              const lastRunning = [...iterView.subSteps]
                .reverse()
                .find((s) => s.status === 'running');
              if (lastRunning) {
                lastRunning.status = success === false ? 'failed' : 'success';
                lastRunning.finishedAt = action.timestamp;
                lastRunning.error = error;
              }
            }
          }
        }
        continue;
      }
    }

    // Normal step handling (non-loop sub-steps)
    if (typeof stepIndex === 'number') {
      // Use a unique key per step. When a step:start arrives for an index that already
      // has a finished entry (from the navigate pre-step sharing index 0), allocate a
      // new slot so both steps are visible.
      let slotKey = stepIndex;
      const prev = byIndex.get(slotKey);
      if (
        action.eventType === 'step:start' &&
        prev &&
        (prev.status === 'success' || prev.status === 'failed')
      ) {
        // Find a free slot key above all existing keys
        let nextKey = slotKey + 0.5;
        while (byIndex.has(nextKey)) nextKey += 0.5;
        slotKey = nextKey;
      } else if (action.eventType === 'step:end') {
        // step:end — find the slot that has a running entry with matching stepIndex.
        // When the pre-step navigate and the first sliced step share stepIndex 0,
        // the navigate slot is already completed, so we need to find the running one.
        if (!prev || prev.status === 'success' || prev.status === 'failed') {
          for (const [key, view] of byIndex) {
            if (view.stepIndex === stepIndex && view.status === 'running') {
              slotKey = key;
              break;
            }
          }
        }
      }

      const existing =
        byIndex.get(slotKey) ??
        ({
          key: `step-${slotKey}`,
          stepIndex,
          status: 'running',
        } satisfies StepActionView);

      existing.stepType = existing.stepType ?? stepType;
      existing.instruction = existing.instruction ?? instruction;
      existing.message = existing.message ?? action.message;

      if (action.eventType === 'step:start') {
        existing.status = 'running';
        existing.startedAt = action.timestamp;
        // Detect loop step from instruction
        if (instruction?.startsWith('Loop: ')) {
          existing.isLoop = true;
          existing.loopDescription = instruction.replace('Loop: ', '');
        }
      } else if (action.eventType === 'step:end') {
        existing.status = success === false ? 'failed' : 'success';
        existing.finishedAt = action.timestamp;
        existing.error = error;
        existing.pendingCredentialRequest = undefined;
        if (typeof output === 'string' && typeof outputExtension === 'string') {
          existing.saveOutput = {
            output,
            outputExtension,
            ...(typeof savedFileIndex === 'number' ? { savedFileIndex } : {}),
            ...(isFallbackOutput ? { fallback: true } : {}),
          };
        }
      }

      byIndex.set(slotKey, existing);
    } else {
      fallback.push({
        key: action.id,
        status: action.eventType === 'step:end' && success === false ? 'failed' : 'running',
        stepType,
        instruction,
        message: action.message,
        startedAt: action.timestamp,
        finishedAt: action.eventType === 'step:end' ? action.timestamp : undefined,
        error,
      });
    }
  }

  const ordered = Array.from(byIndex.entries())
    .sort(([keyA], [keyB]) => keyA - keyB)
    .map(([, view]) => view);

  return [...ordered, ...fallback];
};

const slideIn = keyframes`
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
`;

const statusAccent: Record<StepStatus, string> = {
  running: 'blue.400',
  success: 'green.400',
  failed: 'red.400',
};

const StatusIcon = ({ status }: { status: StepStatus }) => {
  if (status === 'running') {
    return <Spinner size="xs" color="blue.400" />;
  }
  if (status === 'failed') {
    return <Icon as={LuTriangleAlert} color="red.400" boxSize={3} />;
  }
  return <Icon as={LuCheck} color="green.400" boxSize={3} />;
};

export const WorkflowActionsList = ({
  actions,
  workflowTitle,
  onContinueExecution,
  continuingRequestId,
}: WorkflowActionsListProps) => {
  const views = buildActionViews(actions);
  const [downloadingStepKey, setDownloadingStepKey] = useState<string | null>(null);

  const handleDownloadOutput = async (
    viewKey: string,
    output: SaveOutputView,
    stepNumber: number | null,
  ) => {
    if (!output.output?.trim()) return;
    setDownloadingStepKey(viewKey);
    try {
      const safeTitle = sanitizeFileName(workflowTitle || 'workflow-output');
      const stepSuffix = stepNumber !== null ? `-save-step-${stepNumber}` : '-save-step';
      await downloadWorkflowOutput({
        content: output.output,
        outputExtension: output.outputExtension,
        fileNameBase: `${safeTitle || 'workflow-output'}${stepSuffix}`,
      });
    } catch (error) {
      console.error('[WORKFLOW ACTIONS] Failed to download step output', error);
    } finally {
      setDownloadingStepKey((current) => (current === viewKey ? null : current));
    }
  };

  return (
    <VStack gap={2} align="stretch">
      {views.length === 0 ? (
        <Box textAlign="center" py={10}>
          <Spinner size="sm" color="gray.300" mb={3} />
          <Text color="gray.400" fontSize="sm">
            Waiting for actions...
          </Text>
        </Box>
      ) : (
        views.map((view, viewIndex) => {
          const stepNumber = typeof view.stepIndex === 'number' ? viewIndex + 1 : null;
          const saveOutput = view.saveOutput;
          const pendingCredentialRequest = view.pendingCredentialRequest;
          const isContinuing =
            !!pendingCredentialRequest &&
            !!continuingRequestId &&
            continuingRequestId === pendingCredentialRequest.requestId;

          // Loop step with iterations
          if (view.isLoop && view.iterations && view.iterations.length > 0) {
            return (
              <Box
                key={view.key}
                px={3}
                py={2.5}
                borderRadius="sm"
                borderLeft="2px solid"
                borderLeftColor={statusAccent[view.status]}
                animation={`${slideIn} 0.25s ease-out`}
                transition="all 0.15s ease"
              >
                {/* Loop header */}
                <Flex justify="space-between" align="center" mb={1}>
                  <Flex align="center" gap={2}>
                    <StatusIcon status={view.status} />
                    <Text fontSize="13px" fontWeight="600" color="gray.800">
                      {stepNumber !== null ? `Step ${stepNumber}` : 'Step'} · Loop
                    </Text>
                  </Flex>
                  <Text fontSize="10px" color="gray.400" fontFamily="mono">
                    {new Date(view.finishedAt ?? view.startedAt ?? Date.now()).toLocaleTimeString()}
                  </Text>
                </Flex>

                {view.loopDescription && (
                  <Text fontSize="12px" color="gray.600" ml={5} mb={2}>
                    {view.loopDescription}
                  </Text>
                )}

                {/* Iterations */}
                <VStack gap={1} align="stretch" ml={5}>
                  {view.iterations.map((iter) => (
                    <Box
                      key={`iter-${iter.iteration}`}
                      borderRadius="3px"
                      px={2.5}
                      py={2}
                      borderLeft="2px solid"
                      borderLeftColor={statusAccent[iter.status]}
                    >
                      <Flex align="center" gap={2} mb={iter.subSteps.length > 0 ? 1.5 : 0}>
                        <Icon as={LuRepeat} color="orange.500" boxSize={3} />
                        <Text fontSize="12px" fontWeight="600" color="gray.700">
                          Iteration {iter.iteration}
                        </Text>
                        <StatusIcon status={iter.status} />
                      </Flex>

                      {/* Sub-steps within iteration */}
                      {iter.subSteps.length > 0 && (
                        <VStack gap={0.5} align="stretch" ml={4}>
                          {iter.subSteps.map((sub) => (
                            <Flex
                              key={sub.key}
                              align="flex-start"
                              gap={2}
                              py={1}
                              borderBottom="1px solid"
                              borderBottomColor="orange.100"
                              _last={{ borderBottom: 'none' }}
                            >
                              <Box mt="2px">
                                <StatusIcon status={sub.status} />
                              </Box>
                              <Box flex={1}>
                                {sub.instruction && (
                                  <Code
                                    display="block"
                                    px={1.5}
                                    py={1}
                                    borderRadius="2px"
                                    fontSize="11px"
                                    color="gray.600"
                                    wordBreak="break-word"
                                  >
                                    {sub.instruction}
                                  </Code>
                                )}
                                {sub.error && (
                                  <Text fontSize="11px" color="red.500" mt={0.5}>
                                    {sub.error}
                                  </Text>
                                )}
                                {!sub.instruction && sub.message && (
                                  <Text fontSize="11px" color="gray.500">
                                    {sub.message}
                                  </Text>
                                )}
                              </Box>
                            </Flex>
                          ))}
                        </VStack>
                      )}
                    </Box>
                  ))}
                </VStack>

                {view.error && (
                  <Text fontSize="11px" color="red.500" mt={1} ml={5}>
                    {view.error}
                  </Text>
                )}
              </Box>
            );
          }

          // Regular step (non-loop)
          return (
            <Box
              key={view.key}
              px={3}
              py={2.5}
              borderRadius="sm"
              borderLeft="2px solid"
              borderLeftColor={statusAccent[view.status]}
              animation={`${slideIn} 0.25s ease-out`}
              transition="all 0.15s ease"
            >
              <Flex justify="space-between" align="center" mb={1}>
                <Flex align="center" gap={2}>
                  <StatusIcon status={view.status} />
                  <Text fontSize="13px" fontWeight="600" color="gray.800">
                    {stepNumber !== null ? `Step ${stepNumber}` : 'Step'}
                    {view.stepType ? ` · ${view.stepType}` : ''}
                  </Text>
                </Flex>
                <Text fontSize="10px" color="gray.400" fontFamily="mono">
                  {new Date(view.finishedAt ?? view.startedAt ?? Date.now()).toLocaleTimeString()}
                </Text>
              </Flex>
              {view.instruction && (
                <Code
                  display="block"
                  px={2}
                  py={1.5}
                  borderRadius="3px"
                  fontSize="11px"
                  color="gray.600"
                  wordBreak="break-word"
                  ml={5}
                >
                  {view.instruction}
                </Code>
              )}
              {view.error && (
                <Text fontSize="11px" color="red.500" mt={1} ml={5}>
                  {view.error}
                </Text>
              )}
              {!view.instruction && !view.error && view.message && (
                <Text fontSize="11px" color="gray.500" ml={5}>
                  {view.message}
                </Text>
              )}
              {pendingCredentialRequest && (
                <Box ml={5} mt={2}>
                  <Text fontSize="11px" color="orange.700">
                    {pendingCredentialRequest.reason}
                  </Text>
                  {onContinueExecution && (
                    <Button
                      size="xs"
                      mt={1.5}
                      onClick={() => onContinueExecution(pendingCredentialRequest)}
                      loading={isContinuing}
                      bg="orange.500"
                      color="white"
                      _hover={{ bg: 'orange.600' }}
                    >
                      {pendingCredentialRequest.buttonLabel}
                    </Button>
                  )}
                </Box>
              )}
              {view.stepType === 'save' && view.status === 'success' && saveOutput && (
                <Button
                  size="xs"
                  mt={2}
                  ml={5}
                  onClick={() => handleDownloadOutput(view.key, saveOutput, stepNumber)}
                  loading={downloadingStepKey === view.key}
                  bg="purple.500"
                  color="white"
                  _hover={{ bg: 'purple.600' }}
                >
                  Download Output
                </Button>
              )}
            </Box>
          );
        })
      )}
    </VStack>
  );
};

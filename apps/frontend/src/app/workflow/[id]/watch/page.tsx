'use client';

import { useParams, useRouter } from 'next/navigation';
import { useOptionalAuth, clerkEnabled } from '../../../../providers/auth-provider';
import { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  API_BASE,
  useWorkflowExecutionStatus,
  useWorkflowExecutionActions,
  useSessionDebug,
  useStopWorkflowExecution,
  useContinueWorkflowExecution,
  useRefreshPages,
  useWorkflow,
} from '../../../../hooks/api';
import { Navbar } from '../../../components/Navbar';
import { VNCBrowser } from '../../../components/Browser/VNCBrowser';
import {
  WorkflowActionsList,
  type PendingCredentialRequestView,
} from '../../../components/WorkflowActionsList';
import { Box, VStack, HStack, Heading, Text, Spinner, Button } from '@chakra-ui/react';
import type { WorkflowAction } from '@automated/api-dtos';

interface PendingCredentialRequestState {
  requestId: string;
  stepIndex?: number;
}

const getPendingCredentialRequest = (
  actions: WorkflowAction[],
): PendingCredentialRequestState | null => {
  const sortedActions = actions
    .map((action, index) => ({ action, index }))
    .sort(
      (left, right) =>
        new Date(left.action.timestamp).getTime() - new Date(right.action.timestamp).getTime() ||
        left.index - right.index,
    )
    .map(({ action }) => action);

  let pending: PendingCredentialRequestState | null = null;

  for (const action of sortedActions) {
    const stepIndex =
      typeof action.data?.stepIndex === 'number' ? action.data.stepIndex : undefined;

    if (action.eventType === 'credential:request') {
      pending = {
        requestId: String(action.data?.requestId ?? action.id),
        stepIndex,
      };
      continue;
    }

    if (action.eventType === 'credential:continue') {
      if (!pending) continue;
      const requestId =
        typeof action.data?.requestId === 'string' ? action.data.requestId : undefined;
      if (!requestId || requestId === pending.requestId) {
        pending = null;
      }
      continue;
    }

    if (
      action.eventType === 'step:end' &&
      pending &&
      typeof stepIndex === 'number' &&
      pending.stepIndex === stepIndex
    ) {
      pending = null;
    }
  }

  return pending;
};

export default function WatchWorkflowPage() {
  const params = useParams();
  const router = useRouter();
  const { isLoaded, isSignedIn, getToken } = useOptionalAuth();
  const workflowId = params.id as string;

  const queryClient = useQueryClient();
  const { data: executionStatus, isLoading: statusLoading } =
    useWorkflowExecutionStatus(workflowId);
  const runId = executionStatus?.runId ?? null;
  const { data: executionActions = [], isLoading: actionsLoading } = useWorkflowExecutionActions(
    workflowId,
    runId,
  );
  const actionsReady = !actionsLoading;
  const { data: debugInfo } = useSessionDebug(executionStatus?.sessionId || null);
  const stopExecution = useStopWorkflowExecution();
  const continueExecution = useContinueWorkflowExecution();
  const refreshPagesMutation = useRefreshPages();
  const { data: workflow } = useWorkflow(workflowId);

  const contentRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef(executionActions);
  const [stableLiveViewUrl, setStableLiveViewUrl] = useState<string | null>(null);

  const sessionId = executionStatus?.sessionId || null;
  const isRunning = executionStatus?.status === 'running';
  const pendingCredentialRequest = useMemo(
    () => getPendingCredentialRequest(executionActions),
    [executionActions],
  );
  const canUserControlBrowser = isRunning && !!pendingCredentialRequest;
  const isFinished =
    executionStatus?.status === 'completed' ||
    executionStatus?.status === 'failed' ||
    executionStatus?.status === 'stopped';

  useEffect(() => {
    actionsRef.current = executionActions;
  }, [executionActions]);

  useEffect(() => {
    setStableLiveViewUrl(null);
  }, [sessionId]);

  // Hyperbrowser may rotate signed liveView URLs on each debug poll.
  // Keep iframe src stable unless the underlying stream endpoint changes.
  useEffect(() => {
    const next = (debugInfo?.liveViewUrl as string | undefined) ?? null;
    if (!next) return;

    setStableLiveViewUrl((prev) => {
      if (!prev) return next;
      try {
        const previousUrl = new URL(prev);
        const nextUrl = new URL(next);
        const sameStream =
          previousUrl.origin === nextUrl.origin && previousUrl.pathname === nextUrl.pathname;
        return sameStream ? prev : next;
      } catch {
        return prev === next ? prev : next;
      }
    });
  }, [debugInfo?.liveViewUrl]);

  // Poll for page updates
  useEffect(() => {
    if (!sessionId || !isRunning) return;

    const interval = setInterval(() => {
      refreshPagesMutation.mutate(sessionId);
    }, 2000);

    return () => clearInterval(interval);
  }, [sessionId, isRunning, refreshPagesMutation]);

  const handleStopClick = () => {
    stopExecution.mutate(workflowId);
  };

  const handleContinueExecution = useCallback(
    (request: PendingCredentialRequestView) => {
      if (!runId) return;
      continueExecution.mutate({
        workflowId,
        runId,
        requestId: request.requestId,
      });
    },
    [continueExecution, runId, workflowId],
  );

  useEffect(() => {
    if (!workflowId || !runId || !isRunning || !actionsReady) return;

    let cancelled = false;
    let eventSource: EventSource | null = null;

    const connect = async () => {
      const token = await getToken();
      if (cancelled) return;

      const url = new URL(`${API_BASE}/workflows/${workflowId}/execution/actions/stream`);
      url.searchParams.set('runId', runId);
      if (token) {
        url.searchParams.set('token', token);
      }

      const lastTimestamp = actionsRef.current.at(-1)?.timestamp;
      if (lastTimestamp) {
        url.searchParams.set(
          'since',
          lastTimestamp instanceof Date ? lastTimestamp.toISOString() : String(lastTimestamp),
        );
      }

      eventSource = new EventSource(url.toString());
      eventSource.onmessage = (event) => {
        try {
          const action = JSON.parse(event.data);
          queryClient.setQueryData(
            ['workflow-execution-actions', workflowId, runId],
            (prev: any) => {
              const list = Array.isArray(prev) ? prev : [];
              if (list.some((item) => item.id === action.id)) {
                return list;
              }
              return [...list, action];
            },
          );
        } catch (error) {
          console.warn('[WATCH] Failed to parse action event', error);
        }
      };
      eventSource.onerror = () => {
        eventSource?.close();
      };
    };

    connect();

    return () => {
      cancelled = true;
      eventSource?.close();
    };
  }, [workflowId, runId, isRunning, actionsReady, getToken, queryClient]);

  if (!isLoaded || statusLoading) {
    return (
      <VStack minH="100vh" bg="app.bg" color="app.snow" align="center" justify="center">
        <Spinner size="lg" color="app.primary" />
      </VStack>
    );
  }

  if (!isSignedIn && clerkEnabled) {
    return (
      <VStack minH="100vh" bg="app.bg" color="app.snow" align="stretch" gap={0}>
        <Navbar />
        <VStack pt={20} align="center" justify="center">
          <Heading size="xl" fontWeight="semibold" mb={4} color="app.snow">
            Please sign in to watch workflows
          </Heading>
        </VStack>
      </VStack>
    );
  }

  if (!isRunning && !isFinished) {
    return (
      <VStack minH="100vh" bg="app.bg" color="app.snow" align="stretch" gap={0}>
        <Navbar />
        <VStack pt={20} align="center" justify="center" gap={4}>
          <Heading size="xl" fontWeight="semibold" color="app.snow">
            Workflow is not running
          </Heading>
          <Text color="app.muted">
            Start the workflow to watch it live.
          </Text>
          <Button
            onClick={() => router.push('/')}
            bg="app.primary"
            color="app.onPrimary"
            _hover={{ bg: 'app.primaryAlt' }}
          >
            Back to Workflows
          </Button>
        </VStack>
      </VStack>
    );
  }

  return (
    <VStack height="100vh" bg="app.bg" color="app.snow" align="stretch" gap={0}>
      <Navbar />

      <Box flex={1} display="flex" flexDir="column" p={4} minH={0} w="full" mx="auto" maxW="1400px">
        <HStack justify="space-between" mb={4}>
          <Text fontSize="3xl" fontWeight="bold">
            {isFinished
              ? executionStatus?.status === 'completed'
                ? 'Workflow Completed'
                : executionStatus?.status === 'failed'
                  ? 'Workflow Failed'
                  : 'Workflow Stopped'
              : 'Watching Workflow'}
          </Text>

          <HStack gap={3}>
            <Button size="sm" variant="outline" onClick={() => router.push('/')}>
              Back
            </Button>
            {isRunning && (
              <Button
                size="sm"
                colorPalette="red"
                onClick={handleStopClick}
                loading={stopExecution.isPending}
              >
                Stop Workflow
              </Button>
            )}
          </HStack>
        </HStack>

        <HStack align="stretch" gap={6} flex={1} minH={0}>
          <Box flex={1} minH={0}>
            <VNCBrowser
              contentRef={contentRef}
              sessionId={sessionId}
              liveViewUrl={stableLiveViewUrl}
              isLoading={!stableLiveViewUrl}
              readOnly={!canUserControlBrowser}
              freeze={isFinished}
            />
          </Box>
          <Box w="360px" p={4} overflowY="auto">
            {actionsLoading && executionActions.length === 0 ? (
              <Text color="app.muted" fontSize="sm">
                Loading actions...
              </Text>
            ) : (
              <WorkflowActionsList
                actions={executionActions}
                workflowTitle={workflow?.title}
                onContinueExecution={handleContinueExecution}
                continuingRequestId={
                  continueExecution.variables?.requestId && continueExecution.isPending
                    ? continueExecution.variables.requestId
                    : null
                }
              />
            )}
          </Box>
        </HStack>
      </Box>
    </VStack>
  );
}

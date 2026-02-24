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
import { BrowserContainer } from '../../../components/Browser/BrowserContainer';
import {
  WorkflowActionsList,
  type PendingCredentialRequestView,
} from '../../../components/WorkflowActionsList';
import { Box, VStack, HStack, Heading, Text, Spinner, Button } from '@chakra-ui/react';
import type { BrowserbasePage, WorkflowAction } from '@automated/api-dtos';

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

  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [activePageIndex, setActivePageIndex] = useState(0);
  const actionsRef = useRef(executionActions);
  const pagesRef = useRef<BrowserbasePage[]>([]);
  const activePageIndexRef = useRef(activePageIndex);
  const frameCountsRef = useRef<Map<string, number>>(new Map());
  const explicitActiveSignalRef = useRef(false);
  const lastExplicitActiveAtRef = useRef(0);

  const sessionId = executionStatus?.sessionId || null;
  const pages: BrowserbasePage[] = debugInfo?.pages || [];
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
    pagesRef.current = pages;
  }, [pages]);

  useEffect(() => {
    activePageIndexRef.current = activePageIndex;
  }, [activePageIndex]);

  // Reset active page index when pages change
  useEffect(() => {
    if (pages.length > 0 && activePageIndex >= pages.length) {
      setActivePageIndex(0);
    }
  }, [pages.length, activePageIndex]);

  useEffect(() => {
    actionsRef.current = executionActions;
  }, [executionActions]);

  // Poll for page updates
  useEffect(() => {
    if (!sessionId || !isRunning) return;

    const interval = setInterval(() => {
      refreshPagesMutation.mutate(sessionId);
    }, 2000);

    return () => clearInterval(interval);
  }, [sessionId, isRunning, refreshPagesMutation]);

  // Follow the active browser tab signaled by the screencast player.
  // Fallback to frame cadence if no explicit active-tab signal is available.
  useEffect(() => {
    if (!isRunning) {
      explicitActiveSignalRef.current = false;
      lastExplicitActiveAtRef.current = 0;
      frameCountsRef.current.clear();
      return;
    }

    const handleMessage = (event: MessageEvent) => {
      const payload = event.data as { type?: string; pageId?: string } | null;
      if (!payload || typeof payload !== 'object') return;

      const pageId = payload.pageId;
      if (!pageId) return;

      if (payload.type === 'screencast:active-page') {
        explicitActiveSignalRef.current = true;
        lastExplicitActiveAtRef.current = Date.now();
        const idx = pagesRef.current.findIndex((p) => p.id === pageId);
        if (idx !== -1) {
          setActivePageIndex((prev) => (prev === idx ? prev : idx));
        }
        return;
      }

      if (payload.type === 'screencast:frame-received' && !explicitActiveSignalRef.current) {
        const counts = frameCountsRef.current;
        counts.set(pageId, (counts.get(pageId) ?? 0) + 1);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [isRunning]);

  useEffect(() => {
    if (!isRunning) return;

    const interval = window.setInterval(() => {
      const explicitSignalFresh =
        explicitActiveSignalRef.current && Date.now() - lastExplicitActiveAtRef.current < 5000;
      if (explicitSignalFresh) return;

      explicitActiveSignalRef.current = false;

      const counts = frameCountsRef.current;
      if (counts.size === 0) return;

      const currentPageId = pagesRef.current[activePageIndexRef.current]?.id;
      let selectedPageId = currentPageId ?? '';
      let highestCount = currentPageId ? counts.get(currentPageId) ?? 0 : 0;

      counts.forEach((count, pageId) => {
        if (count > highestCount) {
          highestCount = count;
          selectedPageId = pageId;
        }
      });
      counts.clear();

      if (!selectedPageId) return;
      const idx = pagesRef.current.findIndex((p) => p.id === selectedPageId);
      if (idx !== -1) {
        setActivePageIndex((prev) => (prev === idx ? prev : idx));
      }
    }, 1200);

    return () => window.clearInterval(interval);
  }, [isRunning]);

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

  const handleRefreshPages = useCallback(
    (sid: string) => {
      refreshPagesMutation.mutate(sid);
    },
    [refreshPagesMutation],
  );

  // No-op handlers for read-only mode
  const handleAddTab = useCallback(() => {}, []);
  const handleCloseTab = useCallback(() => {}, []);

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
            <BrowserContainer
              containerRef={containerRef}
              contentRef={contentRef}
              sessionId={sessionId}
              pages={pages}
              activePageIndex={activePageIndex}
              setActivePageIndex={setActivePageIndex}
              isLoading={false}
              isAddingTab={false}
              refreshPages={handleRefreshPages}
              handleAddTab={handleAddTab}
              handleCloseTab={handleCloseTab}
              emptyState="skeleton"
              showLoadSkeleton={false}
              readOnly={!canUserControlBrowser}
              freeze={isFinished}
              cdpWsUrlTemplate={debugInfo?.cdpWsUrlTemplate as string | undefined}
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

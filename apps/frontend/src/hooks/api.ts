'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useOptionalAuth } from '../providers/auth-provider';
import axios from 'axios';
import { useImpersonation } from '../providers/impersonation-provider';
import type {
  BrowserSessionCreateRequest,
  BrowserSessionCreateResponse,
  BrowserSessionDebugResponse,
  BrowserSessionPingResponse,
  BrowserSessionRecordingResponse,
  BrowserSessionStopResponse,
  CreateWorkflowRequest,
  DeepgramTokenResponse,
  GenerateWorkflowFromInteractionsRequest,
  GenerateWorkflowFromInteractionsResponse,
  GenerateWorkflowResponse,
  UpsertWorkflowScheduleRequest,
  UpdateWorkflowRequest,
  WorkflowAction,
  WorkflowDetail,
  WorkflowExecutionCommandResponse,
  WorkflowExecutionState,
  WorkflowExecutionStatusesResponse,
  WorkflowEntity,
  WorkflowRecordWithSteps,
  WorkflowRunOutputResponse,
  WorkflowScheduleResponse,
  WorkflowRunsResponse,
  WorkflowTriggerEmailResponse,
} from '@automated/api-dtos';

export const API_BASE = `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080'}/api`;

type Headers = Record<string, string>;

// Helper hook to get headers with auth token
function useGetHeaders() {
  const { getToken } = useOptionalAuth();
  const { impersonatedEmail } = useImpersonation();

  return async (): Promise<Headers> => {
    const token = await getToken();
    const headers: Headers = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    if (impersonatedEmail) {
      headers['x-admin-impersonation'] = impersonatedEmail;
    }
    return headers;
  };
}

// Browser Session Hooks

export function useCreateSession() {
  const getHeaders = useGetHeaders();

  return useMutation({
    mutationFn: async ({
      colorScheme,
      width,
      height,
      reuseExisting = true,
      timezone,
    }: BrowserSessionCreateRequest) => {
      const resolvedTimezone =
        timezone ||
        (typeof Intl !== 'undefined'
          ? Intl.DateTimeFormat().resolvedOptions().timeZone
          : undefined);
      const headers = await getHeaders();
      const response = await axios.post<BrowserSessionCreateResponse>(
        `${API_BASE}/browser-session`,
        { colorScheme, width, height, reuseExisting, timezone: resolvedTimezone },
        { headers },
      );
      return response.data;
    },
  });
}

export function useSessionDebug(sessionId: string | null) {
  const getHeaders = useGetHeaders();

  return useQuery({
    queryKey: ['session-debug', sessionId],
    queryFn: async () => {
      if (!sessionId) return null;
      const headers = await getHeaders();
      const response = await axios.get<BrowserSessionDebugResponse>(
        `${API_BASE}/browser-session/${sessionId}/debug`,
        {
          headers,
        },
      );
      return response.data;
    },
    enabled: !!sessionId,
  });
}

export function useRefreshPages() {
  const queryClient = useQueryClient();
  const getHeaders = useGetHeaders();

  return useMutation({
    mutationFn: async (sessionId: string) => {
      const headers = await getHeaders();
      const response = await axios.get<BrowserSessionDebugResponse>(
        `${API_BASE}/browser-session/${sessionId}/debug`,
        {
          headers,
        },
      );
      return response.data;
    },
    onSuccess: (data, sessionId) => {
      queryClient.setQueryData(['session-debug', sessionId], data);
    },
  });
}

export function useStopSession() {
  const getHeaders = useGetHeaders();

  return useMutation({
    mutationFn: async (sessionId: string) => {
      const headers = await getHeaders();
      const response = await axios.post<BrowserSessionStopResponse>(
        `${API_BASE}/browser-session/${sessionId}/stop`,
        {},
        { headers },
      );
      return response.data;
    },
  });
}

export function useDeleteSession() {
  const getHeaders = useGetHeaders();

  return useMutation({
    mutationFn: async (sessionId: string) => {
      const headers = await getHeaders();
      const response = await axios.delete<BrowserSessionStopResponse>(
        `${API_BASE}/browser-session/${sessionId}`,
        { headers },
      );
      return response.data;
    },
  });
}

// Note: useResetSession, useAddTab, and useCloseTab have been migrated to direct CDP WebSocket
// connections in the browser-provider using the useBrowserCDP hook.

export function usePingSession() {
  const getHeaders = useGetHeaders();

  return useMutation({
    mutationFn: async (sessionId: string) => {
      const headers = await getHeaders();
      const response = await axios.post<BrowserSessionPingResponse>(
        `${API_BASE}/browser-session/${sessionId}/ping`,
        {},
        { headers },
      );
      return response.data;
    },
  });
}

export function useStartRecordingKeepalive() {
  const getHeaders = useGetHeaders();

  return useMutation({
    mutationFn: async (sessionId: string) => {
      const headers = await getHeaders();
      const response = await axios.post<BrowserSessionRecordingResponse>(
        `${API_BASE}/browser-session/${sessionId}/recording/start`,
        {},
        { headers },
      );
      return response.data;
    },
  });
}

export function useStopRecordingKeepalive() {
  const getHeaders = useGetHeaders();

  return useMutation({
    mutationFn: async (sessionId: string) => {
      const headers = await getHeaders();
      const response = await axios.post<BrowserSessionRecordingResponse>(
        `${API_BASE}/browser-session/${sessionId}/recording/stop`,
        {},
        { headers },
      );
      return response.data;
    },
  });
}

// Workflow Hooks

export function useGenerateWorkflow() {
  const getHeaders = useGetHeaders();

  return useMutation({
    mutationFn: async (formData: FormData) => {
      const headers = await getHeaders();
      const response = await axios.post<GenerateWorkflowResponse>(
        `${API_BASE}/workflows/generate`,
        formData,
        { headers },
      );
      return response.data;
    },
  });
}

export function useGenerateWorkflowFromInteractions() {
  const getHeaders = useGetHeaders();

  return useMutation({
    mutationFn: async (data: GenerateWorkflowFromInteractionsRequest) => {
      const headers = await getHeaders();
      const response = await axios.post<GenerateWorkflowFromInteractionsResponse>(
        `${API_BASE}/workflows/generate-from-interactions`,
        data,
        { headers },
      );
      return response.data;
    },
  });
}

export function useCreateWorkflow() {
  const queryClient = useQueryClient();
  const getHeaders = useGetHeaders();

  return useMutation({
    mutationFn: async ({ title, steps }: CreateWorkflowRequest) => {
      const headers = await getHeaders();
      const response = await axios.post<WorkflowRecordWithSteps>(
        `${API_BASE}/workflows`,
        { title, steps },
        { headers },
      );
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-workflows'] });
    },
  });
}

export function useWorkflow(id: string | null) {
  const getHeaders = useGetHeaders();

  return useQuery({
    queryKey: ['workflow', id],
    queryFn: async () => {
      if (!id) return null;
      const headers = await getHeaders();
      const response = await axios.get<WorkflowDetail>(`${API_BASE}/workflows/${id}`, {
        headers,
      });
      return response.data;
    },
    enabled: !!id,
  });
}

export function useUpdateWorkflow() {
  const queryClient = useQueryClient();
  const getHeaders = useGetHeaders();

  return useMutation({
    mutationFn: async ({ id, title, steps }: UpdateWorkflowRequest & { id: string }) => {
      const headers = await getHeaders();
      const response = await axios.put<WorkflowRecordWithSteps>(
        `${API_BASE}/workflows/${id}`,
        { title, steps },
        { headers },
      );
      return response.data;
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['workflow', variables.id] });
      queryClient.invalidateQueries({ queryKey: ['user-workflows'] });
    },
  });
}

export function useDeleteWorkflow() {
  const queryClient = useQueryClient();
  const getHeaders = useGetHeaders();

  return useMutation({
    mutationFn: async (id: string) => {
      const headers = await getHeaders();
      const response = await axios.delete<WorkflowEntity>(`${API_BASE}/workflows/${id}`, {
        headers,
      });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-workflows'] });
    },
  });
}

export function useUserWorkflows() {
  const getHeaders = useGetHeaders();

  return useQuery({
    queryKey: ['user-workflows'],
    queryFn: async () => {
      const headers = await getHeaders();
      const response = await axios.get<WorkflowRecordWithSteps[]>(`${API_BASE}/workflows`, {
        headers,
      });
      return response.data;
    },
  });
}

export function useWorkflowTriggerEmail() {
  const getHeaders = useGetHeaders();

  return useMutation({
    mutationFn: async (workflowId: string) => {
      const headers = await getHeaders();
      const response = await axios.get<WorkflowTriggerEmailResponse>(
        `${API_BASE}/workflows/${workflowId}/trigger-email`,
        { headers },
      );
      return response.data;
    },
  });
}

export function useWorkflowSchedule(workflowId: string | null) {
  const getHeaders = useGetHeaders();

  return useQuery({
    queryKey: ['workflow-schedule', workflowId],
    queryFn: async () => {
      if (!workflowId) return null;
      const headers = await getHeaders();
      const response = await axios.get<WorkflowScheduleResponse | null>(
        `${API_BASE}/workflows/${workflowId}/schedule`,
        { headers },
      );
      return response.data;
    },
    enabled: !!workflowId,
  });
}

export function useUpsertWorkflowSchedule() {
  const queryClient = useQueryClient();
  const getHeaders = useGetHeaders();

  return useMutation({
    mutationFn: async ({
      workflowId,
      payload,
    }: {
      workflowId: string;
      payload: UpsertWorkflowScheduleRequest;
    }) => {
      const headers = await getHeaders();
      const response = await axios.put<WorkflowScheduleResponse>(
        `${API_BASE}/workflows/${workflowId}/schedule`,
        payload,
        { headers },
      );
      return response.data;
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['workflow-schedule', variables.workflowId] });
      queryClient.invalidateQueries({ queryKey: ['user-workflows'] });
    },
  });
}

export function useDeleteWorkflowSchedule() {
  const queryClient = useQueryClient();
  const getHeaders = useGetHeaders();

  return useMutation({
    mutationFn: async (workflowId: string) => {
      const headers = await getHeaders();
      const response = await axios.delete<WorkflowExecutionCommandResponse>(
        `${API_BASE}/workflows/${workflowId}/schedule`,
        { headers },
      );
      return response.data;
    },
    onSuccess: (_, workflowId) => {
      queryClient.invalidateQueries({ queryKey: ['workflow-schedule', workflowId] });
      queryClient.invalidateQueries({ queryKey: ['user-workflows'] });
    },
  });
}

export function useDeepgramToken() {
  const getHeaders = useGetHeaders();

  return useMutation({
    mutationFn: async () => {
      const headers = await getHeaders();
      const response = await axios.post<DeepgramTokenResponse>(
        `${API_BASE}/workflows/speech/deepgram-token`,
        {},
        { headers },
      );
      return response.data;
    },
  });
}

// Workflow Execution Hooks

export function useWorkflowExecutionStatuses() {
  const getHeaders = useGetHeaders();

  return useQuery({
    queryKey: ['workflow-execution-statuses'],
    queryFn: async () => {
      const headers = await getHeaders();
      const response = await axios.get<WorkflowExecutionStatusesResponse>(
        `${API_BASE}/workflows/execution/statuses`,
        { headers },
      );
      return response.data;
    },
    refetchInterval: 2000, // Poll every 2 seconds
  });
}

export function useWorkflowRuns() {
  const getHeaders = useGetHeaders();

  return useQuery({
    queryKey: ['workflow-runs'],
    queryFn: async () => {
      const headers = await getHeaders();
      const response = await axios.get<WorkflowRunsResponse>(`${API_BASE}/workflows/runs`, {
        headers,
      });
      return response.data;
    },
    refetchInterval: 2000,
  });
}

export function useWorkflowRunOutput() {
  const getHeaders = useGetHeaders();

  return useMutation({
    mutationFn: async ({ workflowId, runId }: { workflowId: string; runId: string }) => {
      const headers = await getHeaders();
      const response = await axios.get<WorkflowRunOutputResponse>(
        `${API_BASE}/workflows/${workflowId}/runs/${runId}/output`,
        { headers },
      );
      return response.data;
    },
  });
}

export function useWorkflowExecutionStatus(workflowId: string | null) {
  const getHeaders = useGetHeaders();

  return useQuery({
    queryKey: ['workflow-execution-status', workflowId],
    queryFn: async () => {
      if (!workflowId) return null;
      const headers = await getHeaders();
      const response = await axios.get<WorkflowExecutionState>(
        `${API_BASE}/workflows/${workflowId}/execution/status`,
        { headers },
      );
      return response.data;
    },
    enabled: !!workflowId,
    refetchInterval: 2000, // Poll every 2 seconds when running
  });
}

export function useWorkflowExecutionActions(workflowId: string | null, runId: string | null) {
  const getHeaders = useGetHeaders();

  return useQuery({
    queryKey: ['workflow-execution-actions', workflowId, runId],
    queryFn: async () => {
      if (!workflowId || !runId) return [];
      const headers = await getHeaders();
      const response = await axios.get<WorkflowAction[]>(
        `${API_BASE}/workflows/${workflowId}/execution/actions`,
        { headers, params: { runId } },
      );
      return response.data;
    },
    enabled: !!workflowId && !!runId,
  });
}

export function useStartWorkflowExecution() {
  const queryClient = useQueryClient();
  const getHeaders = useGetHeaders();

  return useMutation({
    mutationFn: async ({
      workflowId,
      inputValues,
    }: {
      workflowId: string;
      inputValues?: Record<string, string>;
    }) => {
      const headers = await getHeaders();
      const response = await axios.post<WorkflowExecutionCommandResponse>(
        `${API_BASE}/workflows/${workflowId}/execution/start`,
        { inputValues },
        { headers },
      );
      return response.data;
    },
    onSuccess: (_, { workflowId }) => {
      queryClient.invalidateQueries({ queryKey: ['workflow-execution-status', workflowId] });
      queryClient.invalidateQueries({ queryKey: ['workflow-execution-statuses'] });
    },
  });
}

export function useStopWorkflowExecution() {
  const queryClient = useQueryClient();
  const getHeaders = useGetHeaders();

  return useMutation({
    mutationFn: async (workflowId: string) => {
      const headers = await getHeaders();
      const response = await axios.post<WorkflowExecutionCommandResponse>(
        `${API_BASE}/workflows/${workflowId}/execution/stop`,
        {},
        { headers },
      );
      return response.data;
    },
    onSuccess: (_, workflowId) => {
      queryClient.invalidateQueries({ queryKey: ['workflow-execution-status', workflowId] });
      queryClient.invalidateQueries({ queryKey: ['workflow-execution-statuses'] });
    },
  });
}

// Settings Hooks

export function useGetSettings() {
  const getHeaders = useGetHeaders();

  return useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const headers = await getHeaders();
      const response = await axios.get<{ openrouterApiKey: string | null }>(
        `${API_BASE}/settings`,
        { headers },
      );
      return response.data;
    },
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  const getHeaders = useGetHeaders();

  return useMutation({
    mutationFn: async (payload: { openrouterApiKey: string }) => {
      const headers = await getHeaders();
      const response = await axios.put<{ success: boolean }>(
        `${API_BASE}/settings`,
        payload,
        { headers },
      );
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });
}

export type {
  WorkflowAction,
  WorkflowExecutionState,
  WorkflowRunSummary,
  WorkflowStatus,
} from '@automated/api-dtos';

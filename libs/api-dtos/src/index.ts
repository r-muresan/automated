import type { Step, Workflow } from '@automated/cua-agent';

export type ApiDate = string | Date;

export type ColorScheme = 'light' | 'dark';

export interface BrowserbasePage {
  id: string;
  title?: string;
  url?: string;
  isSkeleton?: boolean;
  [key: string]: unknown;
}

export interface BrowserSessionCreateRequest {
  colorScheme?: ColorScheme;
  width?: number;
  height?: number;
  reuseExisting?: boolean;
  timezone?: string;
}

export interface BrowserSessionCreateResponse {
  sessionId: string;
  pages: BrowserbasePage[];
  cdpWsUrlTemplate?: string;
}

export interface BrowserSessionDebugResponse extends Record<string, unknown> {
  pages: BrowserbasePage[];
  cdpWsUrlTemplate?: string;
}

export interface BrowserSessionPingResponse {
  success: boolean;
}

export interface BrowserSessionStopResponse {
  success: boolean;
}

export interface BrowserSessionRecordingResponse {
  success: boolean;
  message: string;
  error?: string;
}

export interface BrowserSessionUploadResponse {
  success: boolean;
  message: string;
}

export interface InteractionPayload {
  id: string;
  type: string;
  timestamp: number;
  pageId: string;
  screenshotUrl?: string;
  element?: {
    tagName?: string;
    text?: string;
    href?: string;
    [key: string]: any;
  };
  data?: {
    type?: string;
    x?: number;
    y?: number;
    url?: string;
    combo?: string;
    [key: string]: any;
  };
  transcript?: string;
}

export interface GenerateWorkflowFromInteractionsRequest {
  sessionId?: string;
  interactions: InteractionPayload[];
}

export interface GenerateWorkflowFromInteractionsResponse {
  workflowId: string;
  workflowData: Workflow;
  rawResponse: string;
}

export interface GenerateWorkflowResponse {
  workflowId: string;
  workflowData?: Workflow;
  rawResponse?: string;
}

export type WorkflowStep = Step;

export interface CreateWorkflowRequest {
  title: string;
  steps?: WorkflowStep[];
}

export interface UpdateWorkflowRequest {
  title?: string;
  steps?: WorkflowStep[];
}

export interface WorkflowEntity {
  id: string;
  humanId: string;
  title: string;
  userId: number;
  sessionId?: string | null;
  startingUrl?: string | null;
  inputs?: string[];
  hasSchedule?: boolean;
  createdAt: ApiDate;
  updatedAt: ApiDate;
}

export interface WorkflowStepRecord {
  id: string;
  workflowId: string;
  parentStepId: string | null;
  branch: 'main' | 'loop' | 'true' | 'false';
  stepNumber: number;
  type: string;
  description: string | null;
  url: string | null;
  dataSchema: string | null;
  condition: string | null;
  createdAt: ApiDate;
  updatedAt: ApiDate;
}

export interface WorkflowRecordWithSteps extends WorkflowEntity {
  steps: WorkflowStepRecord[];
}

export interface WorkflowDetail extends WorkflowEntity {
  steps: WorkflowStep[];
}

export interface WorkflowTriggerEmailResponse {
  workflowId: string;
  humanId: string;
  email: string;
}

export type WorkflowScheduleType = 'daily' | 'interval';

export interface WorkflowScheduleDailyConfig {
  time: string; // HH:mm (24-hour)
  days: number[]; // 0-6 where 0=Sunday
}

export interface WorkflowScheduleIntervalConfig {
  everyMinutes: number;
}

export interface UpsertWorkflowScheduleRequest {
  type: WorkflowScheduleType;
  timezone: string;
  enabled?: boolean;
  daily?: WorkflowScheduleDailyConfig;
  interval?: WorkflowScheduleIntervalConfig;
}

export interface WorkflowScheduleResponse {
  id: string;
  workflowId: string;
  enabled: boolean;
  type: WorkflowScheduleType;
  timezone: string;
  dailyTime: string | null;
  dailyDays: number[];
  intervalMinutes: number | null;
  nextRunAt: ApiDate | null;
  lastRunAt: ApiDate | null;
  createdAt: ApiDate;
  updatedAt: ApiDate;
}

export type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'stopped';

export type WorkflowStatus = WorkflowRunStatus | 'idle';

export interface WorkflowExecutionState {
  status: WorkflowStatus;
  currentStep: number;
  totalSteps: number;
  error?: string;
  startedAt?: ApiDate;
  completedAt?: ApiDate;
  sessionId?: string;
  runId?: string;
}

export interface WorkflowRunSummary {
  id: string;
  workflowId: string;
  status: WorkflowRunStatus;
  startedAt: ApiDate;
  completedAt?: ApiDate | null;
  error?: string | null;
  sessionId?: string | null;
  hasOutput: boolean;
}

export interface WorkflowRunOutputResponse {
  workflowId: string;
  runId: string;
  output: string | null;
  outputExtension: string | null;
}

export type WorkflowExecutionStatusesResponse = Record<string, WorkflowExecutionState>;

export type WorkflowRunsResponse = Record<string, WorkflowRunSummary | null>;

export type WorkflowActionEventType =
  | 'step:start'
  | 'step:end'
  | 'loop:iteration:start'
  | 'loop:iteration:end'
  | 'credential:request'
  | 'credential:continue';

export interface WorkflowActionData {
  stepIndex?: number;
  stepType?: string;
  instruction?: string;
  success?: boolean;
  error?: string;
  iteration?: number;
  totalItems?: number;
  item?: unknown;
  output?: string;
  outputExtension?: string;
  savedFileIndex?: number;
  fallback?: boolean;
  requestId?: string;
  reason?: string;
  buttonLabel?: string;
  continued?: boolean;
  [key: string]: any;
}

export interface WorkflowAction {
  id: string;
  runId: string;
  eventType: WorkflowActionEventType | string | null;
  message: string;
  timestamp: ApiDate;
  data?: WorkflowActionData | null;
  level?: 'info' | 'warn' | 'error';
}

export interface WorkflowLogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  eventType?: WorkflowActionEventType | string;
  data?: any;
}

export interface WorkflowExecutionCommandResponse {
  success: boolean;
  message: string;
}

export interface DeepgramTokenResponse {
  key: string;
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Prisma, WorkflowRunLog } from '@automated/prisma';
import {
  OrchestratorAgent,
  type OrchestratorEvent,
  type CredentialRequest,
  type CredentialRequestResult,
  type Workflow,
  type Step,
} from 'apps/cua-agent';
import { Observable, Subject } from 'rxjs';
import { PrismaService } from '../prisma.service';
import { BrowserSessionService } from '../browser-session/browser-session.service';
import { BrowserProvider } from '../browser/browser-provider.interface';
import type {
  WorkflowAction,
  WorkflowExecutionCommandResponse,
  WorkflowExecutionState,
  WorkflowLogEntry,
  WorkflowRunSummary,
  WorkflowRunOutputResponse,
} from '@automated/api-dtos';

const LOG_LIMIT = 500;
const ACTION_EVENT_TYPES = [
  'step:start',
  'step:end',
  'step:reasoning',
  'loop:iteration:start',
  'loop:iteration:end',
  'credential:request',
  'credential:continue',
] as const;

interface PendingCredentialRequest {
  requestId: string;
  workflowId: string;
  runId: string;
  resolve: (result: CredentialRequestResult) => void;
}

@Injectable()
export class WorkflowExecutionService {
  // In-memory store for workflow execution states
  private executionStates: Map<string, WorkflowExecutionState> = new Map();
  private executionLogs: Map<string, WorkflowLogEntry[]> = new Map();
  private orchestrators: Map<string, OrchestratorAgent> = new Map();
  private actionStreams: Map<string, Subject<WorkflowAction>> = new Map();
  /** Track local browser sessions created for workflows so we can clean them up */
  private workflowLocalSessions: Map<string, string> = new Map();
  /** Pending credential requests by workflow run. */
  private pendingCredentialRequests: Map<string, PendingCredentialRequest> = new Map();

  constructor(
    private prisma: PrismaService,
    private browserSessionService: BrowserSessionService,
    private browserProvider: BrowserProvider,
  ) {}

  getStatus(workflowId: string): WorkflowExecutionState {
    return (
      this.executionStates.get(workflowId) || {
        status: 'idle',
        currentStep: 0,
        totalSteps: 0,
      }
    );
  }

  getAllStatuses(): Record<string, WorkflowExecutionState> {
    const statuses: Record<string, WorkflowExecutionState> = {};
    this.executionStates.forEach((state, id) => {
      statuses[id] = state;
    });
    return statuses;
  }

  async getLatestRunsForUser(email: string): Promise<Record<string, WorkflowRunSummary | null>> {
    const workflows = await this.prisma.workflow.findMany({
      where: { user: { email } },
      select: {
        id: true,
        runs: {
          orderBy: { startedAt: 'desc' },
          take: 1,
          select: {
            id: true,
            workflowId: true,
            status: true,
            startedAt: true,
            completedAt: true,
            error: true,
            sessionId: true,
            output: true,
          },
        },
      },
    });

    const runsByWorkflow: Record<string, WorkflowRunSummary | null> = {};
    for (const workflow of workflows) {
      const latestRun = workflow.runs[0];
      runsByWorkflow[workflow.id] = latestRun
        ? {
            id: latestRun.id,
            workflowId: latestRun.workflowId,
            status: latestRun.status,
            startedAt: latestRun.startedAt,
            completedAt: latestRun.completedAt,
            error: latestRun.error,
            sessionId: latestRun.sessionId,
            hasOutput: Boolean(latestRun.output?.trim()),
          }
        : null;
    }
    return runsByWorkflow;
  }

  getLogs(workflowId: string): WorkflowLogEntry[] {
    return this.executionLogs.get(workflowId) ?? [];
  }

  async getActionLogs(workflowId: string, runId: string): Promise<WorkflowAction[]> {
    await this.assertRunExists(workflowId, runId);
    const logs = await this.prisma.workflowRunLog.findMany({
      where: {
        runId,
        eventType: { in: [...ACTION_EVENT_TYPES] },
      },
      orderBy: { timestamp: 'asc' },
    });
    return logs.map((log) => this.toWorkflowAction(log));
  }

  async getActionLogsSince(
    workflowId: string,
    runId: string,
    since: Date,
  ): Promise<WorkflowAction[]> {
    await this.assertRunExists(workflowId, runId);
    const logs = await this.prisma.workflowRunLog.findMany({
      where: {
        runId,
        eventType: { in: [...ACTION_EVENT_TYPES] },
        timestamp: { gt: since },
      },
      orderBy: { timestamp: 'asc' },
    });
    return logs.map((log) => this.toWorkflowAction(log));
  }

  async getActionStream(
    workflowId: string,
    runId: string,
    since?: Date,
  ): Promise<Observable<WorkflowAction>> {
    await this.assertRunExists(workflowId, runId);
    const subject = this.getActionSubject(runId);

    return new Observable<WorkflowAction>((subscriber) => {
      let cancelled = false;
      if (since) {
        void this.getActionLogsSince(workflowId, runId, since)
          .then((logs) => {
            if (cancelled) return;
            for (const log of logs) {
              subscriber.next(log);
            }
          })
          .catch((error) => {
            if (!cancelled) subscriber.error(error);
          });
      }

      const subscription = subject.subscribe({
        next: (log) => subscriber.next(log),
        error: (error) => subscriber.error(error),
        complete: () => subscriber.complete(),
      });

      return () => {
        cancelled = true;
        subscription.unsubscribe();
      };
    });
  }

  async getRunOutput(workflowId: string, runId: string): Promise<WorkflowRunOutputResponse> {
    await this.assertRunExists(workflowId, runId);
    const run = await this.prisma.workflowRun.findFirst({
      where: { id: runId, workflowId },
      select: { output: true, outputExtension: true },
    });

    return {
      workflowId,
      runId,
      output: run?.output ?? null,
      outputExtension: run?.outputExtension ?? null,
    };
  }

  async startWorkflow(
    workflowId: string,
    email?: string,
    inputValues?: Record<string, string>,
    requireBrowserbase = false,
  ): Promise<WorkflowExecutionCommandResponse> {
    // Check if already running
    const currentState = this.executionStates.get(workflowId);
    if (currentState?.status === 'running') {
      return { success: false, message: 'Workflow is already running' };
    }

    // Get workflow from database
    const workflow = await this.prisma.workflow.findUnique({
      where: { id: workflowId },
      include: {
        steps: {
          orderBy: { stepNumber: 'asc' },
        },
      },
    });

    if (!workflow) {
      throw new NotFoundException('Workflow not found');
    }

    if (workflow.steps.length === 0) {
      return { success: false, message: 'Workflow has no steps to execute' };
    }

    if (requireBrowserbase && !process.env.HYPERBROWSER_API_KEY) {
      return {
        success: false,
        message:
          'Managed browser is required for this run, but HYPERBROWSER_API_KEY is not configured.',
      };
    }

    // Check browser minutes cap before starting
    if (email) {
      await this.browserSessionService.assertBrowserMinutesRemaining(email);
    }

    // Get user context if email is provided
    let browserbaseContextId: string | undefined;
    let hyperbrowserProfileId: string | undefined;
    if (email) {
      const user = await this.prisma.user.findUnique({ where: { email } });
      if (user) {
        const userContext = await this.prisma.userContext.findUnique({
          where: { userId: user.id },
        });
        browserbaseContextId = userContext?.browserbaseContextId;
        hyperbrowserProfileId = userContext?.hyperbrowserProfileId ?? undefined;
      }
    }

    let agentSteps = this.buildStepTree(workflow.steps);
    if (agentSteps.length === 0) {
      return { success: false, message: 'Workflow has no executable steps' };
    }

    // Substitute input values into step descriptions using {{InputName}} syntax
    if (inputValues && Object.keys(inputValues).length > 0) {
      agentSteps = this.substituteInputValues(agentSteps, inputValues);
    }

    const agentWorkflow: Workflow = {
      name: workflow.title,
      startingUrl: workflow.startingUrl ?? undefined,
      steps: agentSteps,
    };

    const startedAt = new Date();
    const run = await this.prisma.workflowRun.create({
      data: {
        workflowId,
        status: 'running',
        startedAt,
      },
    });
    this.getActionSubject(run.id);

    // Set initial state
    this.executionStates.set(workflowId, {
      status: 'running',
      currentStep: 0,
      totalSteps: agentSteps.length,
      startedAt,
      runId: run.id,
    });
    this.executionLogs.set(workflowId, []);
    this.addLog(workflowId, {
      timestamp: startedAt.toISOString(),
      level: 'info',
      message: 'Workflow started',
    });

    // Create local browser session only when managed browser is not configured
    let localCdpUrl: string | undefined;
    if (!process.env.HYPERBROWSER_API_KEY) {
      const session = await this.browserProvider.createSession({
        contextId: browserbaseContextId,
      });
      const debugInfo = await this.browserProvider.getDebugInfo(session.id);
      localCdpUrl = debugInfo.browserWsUrl;
      if (!localCdpUrl) {
        throw new Error('Failed to get browser CDP URL for local session');
      }
      this.workflowLocalSessions.set(workflowId, session.id);
      console.log(
        `[WORKFLOW] Created local browser session ${session.id} for workflow ${workflowId}`,
      );
    }

    const localSessionId = this.workflowLocalSessions.get(workflowId);
    const orchestrator = new OrchestratorAgent({
      browserbaseContextId,
      hyperbrowserProfileId,
      localCdpUrl,
      localSessionId: localSessionId ?? undefined,
      onEvent: (event) => this.handleOrchestratorEvent(workflowId, event),
      onCredentialRequest: (request) => this.handleCredentialRequest(workflowId, request),
    });
    this.orchestrators.set(workflowId, orchestrator);

    // Execute in background
    orchestrator
      .runWorkflow(agentWorkflow)
      .then(async (result) => {
        const state = this.executionStates.get(workflowId);
        if (state?.status === 'running') {
          this.persistRunUpdate(state.runId, {
            status: result.success ? 'completed' : 'failed',
            completedAt: new Date(),
            error: result.success ? null : 'Workflow failed',
          });
          this.executionStates.set(workflowId, {
            ...state,
            status: result.success ? 'completed' : 'failed',
            completedAt: new Date(),
            error: result.success ? undefined : 'Workflow failed',
          });
        }

        if (result.savedFiles.length > 0 && state?.runId) {
          // Use the last saved file as the run output
          const lastFile = result.savedFiles[result.savedFiles.length - 1];
          this.persistRunUpdate(state.runId, {
            output: lastFile.output,
            outputExtension: lastFile.outputExtension,
          });
          this.addLog(workflowId, {
            timestamp: new Date().toISOString(),
            level: 'info',
            message: `Workflow produced ${result.savedFiles.length} saved file(s)`,
          });
        }
      })
      .catch((error) => {
        this.addLog(workflowId, {
          timestamp: new Date().toISOString(),
          level: 'error',
          message: 'Workflow execution failed',
          data: error?.message ?? error,
        });
        this.persistRunUpdate(this.executionStates.get(workflowId)?.runId, {
          status: 'failed',
          completedAt: new Date(),
          error: error?.message ?? 'Unknown error',
        });
        this.executionStates.set(workflowId, {
          ...this.executionStates.get(workflowId)!,
          status: 'failed',
          error: error.message || 'Unknown error',
          completedAt: new Date(),
        });
      })
      .finally(() => {
        this.resolvePendingCredentialRequest(workflowId, {
          continued: false,
          message: 'Workflow execution ended before credential handoff was continued.',
        });
        this.orchestrators.delete(workflowId);
        // Clean up local browser session
        const localSessionId = this.workflowLocalSessions.get(workflowId);
        if (localSessionId) {
          this.workflowLocalSessions.delete(workflowId);
          this.browserProvider
            .stopSession(localSessionId)
            .catch((err) =>
              console.error(`[WORKFLOW] Failed to stop local session ${localSessionId}:`, err),
            );
        }
      });

    return { success: true, message: 'Workflow started' };
  }

  async stopWorkflow(workflowId: string): Promise<WorkflowExecutionCommandResponse> {
    const currentState = this.executionStates.get(workflowId);
    if (!currentState || currentState.status !== 'running') {
      return { success: false, message: 'Workflow is not running' };
    }

    const stoppedAt = new Date();
    this.persistRunUpdate(currentState.runId, {
      status: 'stopped',
      completedAt: stoppedAt,
    });

    // Mark as stopped - the execution loop will check this
    this.executionStates.set(workflowId, {
      ...currentState,
      status: 'stopped',
      completedAt: stoppedAt,
    });

    this.addLog(workflowId, {
      timestamp: stoppedAt.toISOString(),
      level: 'warn',
      message: 'Workflow stopped',
    });
    this.resolvePendingCredentialRequest(workflowId, {
      continued: false,
      message: 'Workflow stopped while waiting for user credentials.',
    });

    const orchestrator = this.orchestrators.get(workflowId);
    const sessionId = currentState.sessionId ?? orchestrator?.getSessionId() ?? undefined;

    if (orchestrator) {
      await orchestrator.abort();
      this.orchestrators.delete(workflowId);
    }

    if (sessionId) {
      await this.browserSessionService.stopSession(sessionId);
    }

    // Clean up local browser session
    const localSessionId = this.workflowLocalSessions.get(workflowId);
    if (localSessionId) {
      this.workflowLocalSessions.delete(workflowId);
      await this.browserProvider
        .stopSession(localSessionId)
        .catch((err) =>
          console.error(`[WORKFLOW] Failed to stop local session ${localSessionId}:`, err),
        );
    }

    this.closeActionStream(currentState.runId);
    return { success: true, message: 'Workflow stopped' };
  }

  async continueWorkflow(
    workflowId: string,
    runId: string,
    requestId?: string,
  ): Promise<WorkflowExecutionCommandResponse> {
    await this.assertRunExists(workflowId, runId);

    const pending = this.pendingCredentialRequests.get(runId);
    if (!pending || pending.workflowId !== workflowId) {
      return { success: false, message: 'No pending credential request for this run' };
    }
    if (requestId && pending.requestId !== requestId) {
      return { success: false, message: 'Credential request mismatch' };
    }

    pending.resolve({
      continued: true,
      message: 'Execution resumed after user credential input.',
      requestId: pending.requestId,
    });
    this.pendingCredentialRequests.delete(runId);

    return { success: true, message: 'Workflow execution resumed' };
  }

  private substituteInputValues(steps: Step[], inputValues: Record<string, string>): Step[] {
    const substitute = (text: string): string => {
      return text.replace(/\{\{(.+?)\}\}/g, (match, key) => {
        const trimmedKey = key.trim();
        return inputValues[trimmedKey] ?? match;
      });
    };

    const processStep = (step: Step): Step => {
      switch (step.type) {
        case 'step':
          return { ...step, description: substitute(step.description) };
        case 'extract':
          return { ...step, description: substitute(step.description) };
        case 'save':
          return { ...step, description: substitute(step.description) };
        case 'navigate':
          return { ...step, url: substitute(step.url) };
        case 'tab_navigate':
          return { ...step, url: substitute(step.url) };
        case 'loop':
          return {
            ...step,
            description: substitute(step.description),
            steps: this.substituteInputValues(step.steps, inputValues),
          };
        case 'conditional':
          return {
            ...step,
            condition: substitute(step.condition),
            trueSteps: this.substituteInputValues(step.trueSteps, inputValues),
            falseSteps: step.falseSteps
              ? this.substituteInputValues(step.falseSteps, inputValues)
              : undefined,
          };
        default:
          return step;
      }
    };

    return steps.map(processStep);
  }

  private buildStepTree(
    steps: Array<{
      id: string;
      parentStepId: string | null;
      branch: 'main' | 'loop' | 'true' | 'false';
      stepNumber: number;
      type: string;
      description: string | null;
      url: string | null;
      dataSchema: string | null;
      condition: string | null;
    }>,
  ): Step[] {
    const grouped = new Map<string | null, Array<(typeof steps)[number]>>();

    for (const step of steps) {
      const key = step.parentStepId ?? null;
      const list = grouped.get(key) ?? [];
      list.push(step);
      grouped.set(key, list);
    }

    const buildBranch = (
      parentStepId: string | null,
      branch: 'main' | 'loop' | 'true' | 'false',
    ): Step[] => {
      const branchSteps =
        grouped.get(parentStepId ?? null)?.filter((step) => step.branch === branch) ?? [];

      branchSteps.sort((a, b) => a.stepNumber - b.stepNumber);

      return branchSteps.map((step) => this.mapDbStepToAgentStep(step, buildBranch));
    };

    return buildBranch(null, 'main');
  }

  private mapDbStepToAgentStep(
    step: {
      id: string;
      type: string;
      description: string | null;
      url: string | null;
      dataSchema: string | null;
      condition: string | null;
    },
    buildBranch: (parentStepId: string, branch: 'main' | 'loop' | 'true' | 'false') => Step[],
  ): Step {
    switch (step.type) {
      case 'navigate':
        return { type: 'navigate', url: step.url ?? 'about:blank' };
      case 'tab_navigate':
        return { type: 'tab_navigate', url: step.url ?? 'about:blank' };
      case 'save':
        return { type: 'save', description: step.description ?? '' };
      case 'extract':
        return {
          type: 'extract',
          description: step.description ?? '',
          dataSchema: step.dataSchema ?? undefined,
        };
      case 'loop':
        return {
          type: 'loop',
          description: step.description ?? '',
          steps: buildBranch(step.id, 'loop'),
        };
      case 'conditional': {
        const trueSteps = buildBranch(step.id, 'true');
        const falseSteps = buildBranch(step.id, 'false');
        return {
          type: 'conditional',
          condition: step.condition ?? '',
          trueSteps,
          falseSteps: falseSteps.length > 0 ? falseSteps : undefined,
        };
      }
      case 'step':
      default:
        return { type: 'step', description: step.description ?? '' };
    }
  }

  private async handleCredentialRequest(
    workflowId: string,
    request: CredentialRequest,
  ): Promise<CredentialRequestResult> {
    const state = this.executionStates.get(workflowId);
    const runId = state?.runId;
    if (!state || state.status !== 'running' || !runId) {
      throw new Error('Workflow is not currently running.');
    }

    const existingPending = this.pendingCredentialRequests.get(runId);
    if (existingPending) {
      throw new Error('A credential request is already pending for this workflow run.');
    }

    const requestId = randomUUID();
    const createdAt = new Date();
    this.addLog(workflowId, {
      timestamp: createdAt.toISOString(),
      level: 'warn',
      message: 'User action required: credentials needed',
      eventType: 'credential:request',
      data: {
        requestId,
        reason: request.reason,
        stepIndex: request.stepIndex,
        stepType: request.stepType,
        instruction: request.instruction,
        buttonLabel: 'Continue Execution',
      },
    });

    const result = await new Promise<CredentialRequestResult>((resolve) => {
      this.pendingCredentialRequests.set(runId, {
        requestId,
        workflowId,
        runId,
        resolve,
      });
    });

    this.pendingCredentialRequests.delete(runId);
    this.addLog(workflowId, {
      timestamp: new Date().toISOString(),
      level: result.continued ? 'info' : 'warn',
      message: result.continued
        ? 'User resumed execution'
        : (result.message ?? 'Credential handoff ended without continuation'),
      eventType: 'credential:continue',
      data: {
        requestId,
        stepIndex: request.stepIndex,
        stepType: request.stepType,
        instruction: request.instruction,
        continued: result.continued,
      },
    });

    return {
      ...result,
      requestId: result.requestId ?? requestId,
    };
  }

  private resolvePendingCredentialRequest(
    workflowId: string,
    result: CredentialRequestResult,
    runId?: string,
  ): void {
    if (runId) {
      const pending = this.pendingCredentialRequests.get(runId);
      if (pending && pending.workflowId === workflowId) {
        pending.resolve({
          ...result,
          requestId: result.requestId ?? pending.requestId,
        });
        this.pendingCredentialRequests.delete(runId);
      }
      return;
    }

    for (const [pendingRunId, pending] of this.pendingCredentialRequests.entries()) {
      if (pending.workflowId !== workflowId) continue;
      pending.resolve({
        ...result,
        requestId: result.requestId ?? pending.requestId,
      });
      this.pendingCredentialRequests.delete(pendingRunId);
    }
  }

  private handleOrchestratorEvent(workflowId: string, event: OrchestratorEvent) {
    const stoppedState = this.executionStates.get(workflowId);
    if (stoppedState?.status === 'stopped') {
      if (event.type === 'session:ready') {
        void this.browserSessionService.stopSession(event.sessionId);
      }
      return;
    }

    switch (event.type) {
      case 'workflow:start': {
        this.addLog(workflowId, {
          timestamp: new Date().toISOString(),
          level: 'info',
          message: `Agent started workflow "${event.workflow.name}"`,
        });
        break;
      }
      case 'session:ready': {
        const state = this.executionStates.get(workflowId);
        if (state) {
          this.executionStates.set(workflowId, {
            ...state,
            sessionId: event.sessionId,
          });
          this.persistRunUpdate(state.runId, { sessionId: event.sessionId });
        }
        this.addLog(workflowId, {
          timestamp: new Date().toISOString(),
          level: 'info',
          message: 'Browser session ready',
          data: {
            sessionId: event.sessionId,
            liveViewUrl: event.liveViewUrl,
          },
        });
        break;
      }
      case 'step:start': {
        this.addLog(workflowId, {
          timestamp: new Date().toISOString(),
          level: 'info',
          message: `Step ${event.index + 1} started`,
          eventType: 'step:start',
          data: {
            stepIndex: event.index,
            stepType: event.step.type,
            instruction: event.instruction,
          },
        });
        break;
      }
      case 'step:end': {
        const state = this.executionStates.get(workflowId);
        if (state) {
          const nextStep = Math.min(state.totalSteps, state.currentStep + 1);
          this.executionStates.set(workflowId, {
            ...state,
            currentStep: nextStep,
            error: event.success ? state.error : (event.error ?? 'Step failed'),
          });
        }
        if (!event.success) {
          console.error(
            `[WORKFLOW] Step ${event.index + 1} failed (${event.step.type}): ${event.error ?? 'Unknown reason'}`,
          );
        }
        this.addLog(workflowId, {
          timestamp: new Date().toISOString(),
          level: event.success ? 'info' : 'error',
          message: `Step ${event.index + 1} ${event.success ? 'completed' : 'failed'}`,
          eventType: 'step:end',
          data: {
            stepIndex: event.index,
            stepType: event.step.type,
            success: event.success,
            ...(event.savedFile
              ? {
                  output: event.savedFile.output,
                  outputExtension: event.savedFile.outputExtension,
                  savedFileIndex: event.savedFile.savedFileIndex,
                  ...(event.savedFile.fallback ? { fallback: true } : {}),
                }
              : {}),
            ...(event.error ? { error: event.error } : {}),
          },
        });
        break;
      }
      case 'step:reasoning': {
        this.addLog(
          workflowId,
          {
            timestamp: new Date().toISOString(),
            level: 'info',
            message: 'Step reasoning update',
            eventType: 'step:reasoning',
            data: {
              stepIndex: event.index,
              stepType: event.step.type,
              reasoningDelta: event.delta,
            },
          },
          { persist: false },
        );
        break;
      }
      case 'loop:iteration:start': {
        this.addLog(workflowId, {
          timestamp: new Date().toISOString(),
          level: 'info',
          message: `Loop iteration ${event.iteration}`,
          eventType: 'loop:iteration:start',
          data: {
            stepIndex: event.index,
            stepType: 'loop',
            iteration: event.iteration,
            totalItems: event.totalItems,
            item: event.item,
          },
        });
        break;
      }
      case 'loop:iteration:end': {
        this.addLog(workflowId, {
          timestamp: new Date().toISOString(),
          level: event.success ? 'info' : 'error',
          message: `Loop iteration ${event.iteration} ${event.success ? 'completed' : 'failed'}`,
          eventType: 'loop:iteration:end',
          data: {
            stepIndex: event.index,
            stepType: 'loop',
            iteration: event.iteration,
            totalItems: event.totalItems,
            success: event.success,
            ...(event.error ? { error: event.error } : {}),
          },
        });
        break;
      }
      case 'workflow:error': {
        const state = this.executionStates.get(workflowId);
        if (state) {
          this.executionStates.set(workflowId, {
            ...state,
            status: 'failed',
            error: event.error,
            completedAt: new Date(),
          });
        }
        this.addLog(workflowId, {
          timestamp: new Date().toISOString(),
          level: 'error',
          message: 'Workflow error',
          data: { error: event.error },
        });
        this.resolvePendingCredentialRequest(workflowId, {
          continued: false,
          message: event.error || 'Workflow failed while waiting for credentials.',
        });
        this.closeActionStream(state?.runId);
        break;
      }
      case 'workflow:complete': {
        const state = this.executionStates.get(workflowId);
        if (state) {
          this.executionStates.set(workflowId, {
            ...state,
            status: event.result.success ? 'completed' : 'failed',
            completedAt: new Date(),
            currentStep: state.totalSteps,
            error: event.result.success ? undefined : 'Workflow failed',
          });
        }
        this.addLog(workflowId, {
          timestamp: new Date().toISOString(),
          level: event.result.success ? 'info' : 'error',
          message: event.result.success ? 'Workflow completed' : 'Workflow failed',
        });
        this.resolvePendingCredentialRequest(workflowId, {
          continued: false,
          message: 'Workflow completed before credential handoff resumed.',
        });
        this.closeActionStream(state?.runId);
        break;
      }
      case 'log': {
        this.addLog(workflowId, {
          timestamp: new Date().toISOString(),
          level: event.level,
          message: event.message,
          data: event.data,
        });
        break;
      }
      default:
        break;
    }
  }

  private addLog(
    workflowId: string,
    entry: WorkflowLogEntry,
    options?: { persist?: boolean },
  ) {
    const logs = this.executionLogs.get(workflowId) ?? [];
    logs.push(entry);
    if (logs.length > LOG_LIMIT) {
      logs.splice(0, logs.length - LOG_LIMIT);
    }
    this.executionLogs.set(workflowId, logs);

    const runId = this.executionStates.get(workflowId)?.runId;

    // Emit to SSE stream immediately (before DB write) to preserve event ordering.
    // DB writes are async and can complete out of order, which breaks loop iteration tracking.
    if (entry.eventType && runId) {
      this.emitAction(runId, {
        id: randomUUID(),
        runId,
        eventType: entry.eventType,
        message: entry.message,
        timestamp: new Date(entry.timestamp),
        data: entry.data as WorkflowAction['data'],
        level: entry.level,
      });
    }

    if (options?.persist !== false) {
      void this.persistRunLog(runId, entry);
    }
  }

  private persistRunUpdate(runId: string | undefined, data: Prisma.WorkflowRunUpdateInput) {
    if (!runId) return;
    void this.prisma.workflowRun
      .update({
        where: { id: runId },
        data,
      })
      .catch((error) => {
        console.error('[WORKFLOW] Failed to update workflow run:', error);
      });
  }

  private persistRunLog(
    runId: string | undefined,
    entry: WorkflowLogEntry,
  ): Promise<WorkflowRunLog | null> {
    if (!runId) return Promise.resolve(null);
    const data: Prisma.WorkflowRunLogUncheckedCreateInput = {
      runId,
      level: entry.level,
      message: entry.message,
      timestamp: new Date(entry.timestamp),
      ...(entry.eventType ? { eventType: entry.eventType } : {}),
      ...(entry.data === undefined ? {} : { data: entry.data }),
    };

    return this.prisma.workflowRunLog.create({ data }).catch((error) => {
      console.error('[WORKFLOW] Failed to persist workflow log:', error);
      return null;
    });
  }

  private getActionSubject(runId: string): Subject<WorkflowAction> {
    const existing = this.actionStreams.get(runId);
    if (existing && !existing.closed) {
      return existing;
    }
    const subject = new Subject<WorkflowAction>();
    this.actionStreams.set(runId, subject);
    return subject;
  }

  private emitAction(runId: string, log: WorkflowAction) {
    const subject = this.actionStreams.get(runId);
    if (subject && !subject.closed) {
      subject.next(log);
    }
  }

  private toWorkflowAction(log: WorkflowRunLog): WorkflowAction {
    return {
      id: log.id,
      runId: log.runId,
      eventType: log.eventType,
      message: log.message,
      timestamp: log.timestamp,
      data: log.data as WorkflowAction['data'],
      level: log.level,
    };
  }

  private closeActionStream(runId?: string) {
    if (!runId) return;
    const subject = this.actionStreams.get(runId);
    if (subject && !subject.closed) {
      subject.complete();
    }
    this.actionStreams.delete(runId);
  }

  private async assertRunExists(workflowId: string, runId: string): Promise<void> {
    const run = await this.prisma.workflowRun.findFirst({
      where: { id: runId, workflowId },
      select: { id: true },
    });
    if (!run) {
      throw new NotFoundException('Workflow run not found');
    }
  }
}

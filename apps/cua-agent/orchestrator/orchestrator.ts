import * as dotenv from 'dotenv';
import OpenAI from 'openai';
import type { Stagehand } from '../stagehand/v3';
import type {
  Workflow,
  Step,
  StepResult,
  SavedFile,
  WorkflowResult,
  LoopStep,
  NavigateStep,
  LoopContext,
  OrchestratorOptions,
  OrchestratorEvent,
  CredentialRequestResult,
} from '../types';

import {
  OPENROUTER_BASE_URL,
  DEFAULT_MODELS,
  type OrchestratorContext,
} from './orchestrator-context';
import { initSession, closeSession, type SessionState } from './session';
import {
  executeNavigateStep,
  executeTabNavigateStep,
  executeExtractStep,
  executeSaveStep,
  executeSingleStep,
  executeConditionalStep,
} from './steps';
import { SessionFileManager } from './session-file-manager';
import {
  buildHybridActiveToolsForUrl,
  getSpreadsheetProvider,
  type CredentialHandoffRequest,
} from './agent-tools';
import { executeLoopStep, type LoopDeps } from './steps/loop';

dotenv.config();

export class OrchestratorAgent {
  private openai: OpenAI | null = null;
  private stagehand: Stagehand | null = null;
  private session: SessionState = {
    hyperbrowserClient: null,
    hyperbrowserSessionId: null,
    activeSessionId: null,
  };
  private aborted = false;
  private aborting = false;
  private extractedVariables: Record<string, string> = {};
  private globalState: any[] = [];
  private savedFiles: SavedFile[] = [];
  private sessionFiles: SessionFileManager;
  private stepResults: StepResult[] = [];
  private workflowName: string = '';
  private options: OrchestratorOptions;

  constructor(options?: OrchestratorOptions) {
    this.options = options ?? {};
    this.sessionFiles = new SessionFileManager({
      emit: this.emit.bind(this),
      getActivePageUrl: this.getActivePageUrl.bind(this),
      getAgentModel: () => this.resolveModels().agent,
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private resolveModels() {
    return {
      extract: this.options.models?.extract ?? DEFAULT_MODELS.extract,
      agent: this.options.models?.agent ?? DEFAULT_MODELS.agent,
      conditional: this.options.models?.conditional ?? DEFAULT_MODELS.conditional,
      save: this.options.models?.save ?? DEFAULT_MODELS.save,
    };
  }

  private getActivePageUrl(): string {
    if (!this.stagehand) return '';
    try {
      const page = this.stagehand.context.activePage() ?? this.stagehand.context.pages()[0];
      return page?.url?.() ?? '';
    } catch {
      return '';
    }
  }

  private buildPrepareStepForActiveTools(scope: string) {
    return async ({ stepNumber }: { stepNumber?: number } = {}) => {
      const activeUrl = this.getActivePageUrl();
      const activeTools = buildHybridActiveToolsForUrl(activeUrl);
      return { activeTools };
    };
  }

  private emit(event: OrchestratorEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch (error) {
      console.warn('[ORCHESTRATOR] Failed to emit event:', error);
    }
  }

  private assertNotAborted(): void {
    if (this.aborted) {
      throw new Error('Workflow aborted');
    }
  }

  private async requestCredentialHandoff(
    request: CredentialHandoffRequest,
    step: Step,
    index: number,
    instruction: string,
  ): Promise<CredentialRequestResult> {
    const handler = this.options.onCredentialRequest;
    if (!handler) {
      throw new Error('Credential handoff is unavailable in this environment.');
    }

    this.assertNotAborted();
    const result = await handler({
      reason: request.reason,
      stepIndex: index,
      stepType: step.type,
      instruction,
    });
    this.assertNotAborted();

    if (!result?.continued) {
      throw new Error(result?.message ?? 'Credential handoff was not continued.');
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Build the shared context object for extracted step functions
  // ---------------------------------------------------------------------------

  private buildContext(): OrchestratorContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      get stagehand() {
        return self.stagehand;
      },
      set stagehand(v) {
        self.stagehand = v;
      },
      get openai() {
        return self.openai;
      },
      set openai(v) {
        self.openai = v;
      },
      extractedVariables: this.extractedVariables,
      globalState: this.globalState,
      savedFiles: this.savedFiles,
      stepResults: this.stepResults,
      workflowName: this.workflowName,
      sessionFiles: this.sessionFiles,
      options: this.options,
      emit: this.emit.bind(this),
      assertNotAborted: this.assertNotAborted.bind(this),
      resolveModels: this.resolveModels.bind(this),
      getActivePageUrl: this.getActivePageUrl.bind(this),
      executeSteps: this.executeSteps.bind(this),
      requestCredentialHandoff: this.requestCredentialHandoff.bind(this),
      buildPrepareStepForActiveTools: this.buildPrepareStepForActiveTools.bind(this),
    };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async abort(): Promise<void> {
    if (this.aborting) return;
    this.aborting = true;
    this.aborted = true;
    this.emit({
      type: 'log',
      level: 'warn',
      message: 'Workflow abort requested',
    });
    await this.close();
  }

  getSessionId(): string | null {
    return this.session.activeSessionId ?? this.stagehand?.browserbaseSessionID ?? null;
  }

  async runWorkflow(workflow: Workflow): Promise<WorkflowResult> {
    console.log(`[ORCHESTRATOR] Starting workflow: ${workflow.name}`);
    this.workflowName = workflow.name;
    this.emit({ type: 'workflow:start', workflow });

    let startingUrl = workflow.startingUrl;
    let skipFirstStep = false;

    const step = workflow.steps[0] as NavigateStep;

    if (workflow.steps.length > 0 && workflow.steps[0].type === 'navigate') {
      startingUrl = workflow.steps[0].url;
      skipFirstStep = true;
    }

    try {
      if (startingUrl) {
        const index = 0;
        const instruction = 'Navigate to ' + step.url;
        this.emit({ type: 'step:start', step, index, instruction });
      }

      await this.init(startingUrl);

      if (startingUrl) {
        this.emit({ type: 'step:end', step, index: 0, success: true });
      }

      const steps = skipFirstStep ? workflow.steps.slice(1) : workflow.steps;
      await this.executeSteps(steps, undefined, skipFirstStep ? 1 : 0);
    } catch (error: any) {
      if (this.aborted) {
        console.warn('[ORCHESTRATOR] Workflow aborted');
        this.emit({
          type: 'log',
          level: 'warn',
          message: 'Workflow aborted',
          data: error?.message ?? error,
        });
      } else {
        const message = error?.message ?? String(error);
        const stack = error?.stack;
        const cause = error?.cause;
        console.error(`[ORCHESTRATOR] Workflow error: ${message}`);
        if (stack) {
          console.error(`[ORCHESTRATOR] Workflow error stack:\n${stack}`);
        }
        if (cause) {
          console.error(`[ORCHESTRATOR] Workflow error cause:`, cause);
        }
        this.emit({
          type: 'log',
          level: 'error',
          message: 'Workflow error details',
          data: {
            error: message,
            ...(stack ? { stack } : {}),
            ...(cause ? { cause: String(cause) } : {}),
          },
        });
        this.emit({
          type: 'workflow:error',
          workflow,
          error: message,
        });
      }
    } finally {
      await this.close();
    }

    const success = !this.aborted && this.stepResults.every((r) => r.success);
    const result = {
      workflowName: workflow.name,
      stepResults: this.stepResults,
      extractedVariables: { ...this.extractedVariables },
      globalState: [...this.globalState],
      savedFiles: [...this.savedFiles],
      success,
    };
    this.emit({ type: 'workflow:complete', workflow, result });
    return result;
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle (delegates to session.ts)
  // ---------------------------------------------------------------------------

  private async init(startingUrl?: string): Promise<void> {
    const ctx = this.buildContext();
    await initSession(ctx, this.session, startingUrl);
  }

  private async close(): Promise<void> {
    const ctx = this.buildContext();
    await closeSession(ctx, this.session);
  }

  // ---------------------------------------------------------------------------
  // Step dispatch
  // ---------------------------------------------------------------------------

  private describeStepInstruction(step: Step): string {
    switch (step.type) {
      case 'step':
        return step.description;
      case 'navigate':
        return `Navigate to ${step.url}`;
      case 'tab_navigate':
        return `Tab navigate to ${step.url}`;
      case 'extract':
        return step.description;
      case 'save':
        return step.description;
      case 'loop':
        return `Loop: ${step.description}`;
      case 'conditional':
        return `Conditional: ${step.condition}`;
      default:
        return 'Step';
    }
  }

  private async executeSteps(steps: Step[], context?: LoopContext, indexOffset = 0): Promise<void> {
    const ctx = this.buildContext();

    for (let i = 0; i < steps.length; i++) {
      const index = i + indexOffset;
      this.assertNotAborted();
      const step = steps[i];
      const instruction = this.describeStepInstruction(step);
      const stepContext = this.sessionFiles.beginStep(step, index, instruction, context);
      this.emit({ type: 'step:start', step, index, instruction });

      try {
        if (step.type === 'step') {
          await executeSingleStep(ctx, step.description, context, index, step);
        } else if (step.type === 'loop') {
          await executeLoopStep(this.buildLoopDeps(step, index), step, index);
        } else if (step.type === 'conditional') {
          await executeConditionalStep(ctx, step, context, index);
        } else if (step.type === 'extract') {
          await executeExtractStep(ctx, step, context, index);
        } else if (step.type === 'save') {
          await executeSaveStep(ctx, step, context, index);
        } else if (step.type === 'navigate') {
          await executeNavigateStep(ctx, step, index);
        } else if (step.type === 'tab_navigate') {
          await executeTabNavigateStep(ctx, step, index);
        }
      } finally {
        this.sessionFiles.endStep(stepContext);
      }

      this.assertNotAborted();
    }
  }

  private buildLoopDeps(loopStep: LoopStep, loopIndex: number): LoopDeps {
    return {
      stagehand: this.stagehand!,
      openai: this.openai!,
      models: this.resolveModels(),
      openrouterApiKey: process.env.OPENROUTER_API_KEY ?? '',
      openrouterBaseUrl: OPENROUTER_BASE_URL,
      emit: this.emit.bind(this),
      assertNotAborted: this.assertNotAborted.bind(this),
      executeSteps: this.executeSteps.bind(this),
      getDownloadedFiles: () => this.sessionFiles.getDownloadedFiles(),
      getUploadedFiles: () => this.sessionFiles.getUploadedFiles(),
      getAgentInteractionSync: () => this.sessionFiles.createAgentInteractionSync(),
      requestCredentialHandoff: (request) =>
        this.requestCredentialHandoff(
          request,
          loopStep,
          loopIndex,
          this.describeStepInstruction(loopStep),
        ),
    };
  }
}

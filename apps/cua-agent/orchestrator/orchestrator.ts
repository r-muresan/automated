import * as dotenv from 'dotenv';
import OpenAI from 'openai';
import { Stagehand } from '../stagehand/v3';
import { z } from 'zod';
import type {
  Workflow,
  Step,
  StepResult,
  SavedFile,
  WorkflowResult,
  LoopStep,
  ExtractStep,
  SaveStep,
  ConditionalStep,
  NavigateStep,
  TabNavigateStep,
  LoopContext,
  BrowserState,
  TabState,
  OrchestratorOptions,
  OrchestratorEvent,
  CredentialRequestResult,
} from '../types';

import { AGENT_TIMEOUT_MS } from './constants';
import { withTimeout } from './utils';
import { waitForPageReady } from './page-ready';
import { buildSystemPrompt } from './system-prompt';
import {
  buildHybridActiveToolsForUrl,
  createBrowserTabTools,
  getSpreadsheetProvider,
  type CredentialHandoffRequest,
} from './agent-tools';
import { extractWithSharedStrategy, parseSchemaMap } from './extraction';
import { executeLoopStep, type LoopDeps } from './loop';
import {
  acquireBrowserbaseSessionCreateLease,
  releaseBrowserbaseSession,
} from '../browserbase-session-limiter';

dotenv.config();

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

const DEFAULT_MODELS = {
  extract: 'google/gemini-2.5-flash',
  agent: 'moonshotai/kimi-k2.5',
  conditional: 'google/gemini-3-flash-preview',
  save: 'google/gemini-3-flash-preview',
};

export class OrchestratorAgent {
  private openai: OpenAI | null = null;
  private stagehand: Stagehand | null = null;
  private activeSessionId: string | null = null;
  private aborted = false;
  private aborting = false;
  private extractedVariables: Record<string, string> = {};
  private globalState: any[] = [];
  private savedFiles: SavedFile[] = [];
  private stepResults: StepResult[] = [];
  private workflowName: string = '';
  private options: OrchestratorOptions;

  constructor(options?: OrchestratorOptions) {
    this.options = options ?? {};
  }

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
      const provider = getSpreadsheetProvider(activeUrl);
      const activeTools = buildHybridActiveToolsForUrl(activeUrl);
      console.log(
        `[ORCHESTRATOR] Active tools scope=${scope} step=${typeof stepNumber === 'number' ? stepNumber : 'unknown'} provider=${provider ?? 'none'} tools=${JSON.stringify(activeTools)}`,
      );
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
    return this.stagehand?.browserbaseSessionID ?? null;
  }

  async runWorkflow(workflow: Workflow): Promise<WorkflowResult> {
    console.log(`[ORCHESTRATOR] Starting workflow: ${workflow.name}`);
    this.workflowName = workflow.name;
    this.emit({ type: 'workflow:start', workflow });

    // Determine starting URL: use explicit startingUrl if provided, otherwise derive from first navigate step
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

  private assertNotAborted(): void {
    if (this.aborted) {
      throw new Error('Workflow aborted');
    }
  }

  private isInvalidJsonResponseError(message?: string): boolean {
    return typeof message === 'string' && message.toLowerCase().includes('invalid json response');
  }

  private logUsageAfterToolCall(
    toolName: string,
    totals: { inputTokens: number; cachedInputTokens: number; outputTokens: number },
    deltas?: { inputTokens: number; cachedInputTokens: number; outputTokens: number },
  ): void {
    const tokens = deltas ?? totals;
    console.log(
      `[ORCHESTRATOR] Usage after tool call "${toolName}": input_tokens=${tokens.inputTokens}, cached_input_tokens=${tokens.cachedInputTokens}, output_tokens=${tokens.outputTokens}`,
    );
    this.emit({
      type: 'log',
      level: 'info',
      message: `Usage after tool call: ${toolName}`,
      data: {
        input_tokens: tokens.inputTokens,
        cached_input_tokens: tokens.cachedInputTokens,
        output_tokens: tokens.outputTokens,
      },
    });
  }

  private summarizeToolResultForLog(toolResult: unknown): string {
    if (typeof toolResult === 'string') {
      return toolResult.length > 600 ? `${toolResult.slice(0, 600)}...` : toolResult;
    }
    try {
      const serialized = JSON.stringify(toolResult);
      if (typeof serialized !== 'string') return String(toolResult);
      return serialized.length > 600 ? `${serialized.slice(0, 600)}...` : serialized;
    } catch {
      return String(toolResult);
    }
  }

  private async init(startingUrl?: string): Promise<void> {
    this.assertNotAborted();
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('Missing OPENROUTER_API_KEY for OpenRouter');
    this.openai = new OpenAI({ baseURL: OPENROUTER_BASE_URL, apiKey });

    if (this.options.localCdpUrl) {
      await this.initLocal(startingUrl);
    } else {
      await this.initBrowserbase(startingUrl);
    }
  }

  private async initLocal(startingUrl?: string): Promise<void> {
    const cdpUrl = this.options.localCdpUrl!;
    const models = this.resolveModels();
    console.log(`[ORCHESTRATOR] Using local browser via CDP: ${cdpUrl}`);

    this.stagehand = new Stagehand({
      env: 'LOCAL',
      verbose: 0,
      model: {
        modelName: models.extract,
        apiKey: process.env.OPENROUTER_API_KEY,
        baseURL: OPENROUTER_BASE_URL,
      },
      localBrowserLaunchOptions: {
        cdpUrl,
      },
      experimental: true,
      disableAPI: true,
    });

    await this.stagehand.init();
    const sessionId = this.options.localSessionId ?? 'local';
    this.activeSessionId = sessionId;

    this.assertNotAborted();
    this.emit({ type: 'session:ready', sessionId, liveViewUrl: '' });

    if (startingUrl) {
      const page = this.stagehand.context.pages()[0];
      await page.goto(startingUrl, { waitUntil: 'domcontentloaded' });
      console.log(`[ORCHESTRATOR] Navigated to ${startingUrl}`);
    }
  }

  private async initBrowserbase(startingUrl?: string): Promise<void> {
    const models = this.resolveModels();
    const projectId = this.options.browserbaseProjectId ?? process.env.BROWSERBASE_PROJECT_ID ?? '';
    if (!projectId) {
      throw new Error('Missing BROWSERBASE_PROJECT_ID for Browserbase');
    }

    const contextId =
      this.options.browserbaseContextId ?? process.env.BROWSERBASE_CONTEXT_ID ?? undefined;

    const createLease = await acquireBrowserbaseSessionCreateLease('orchestrator:init');
    let leaseConfirmed = false;

    try {
      this.stagehand = new Stagehand({
        env: 'BROWSERBASE',
        verbose: 1,
        model: {
          modelName: models.extract,
          apiKey: process.env.OPENROUTER_API_KEY,
          baseURL: OPENROUTER_BASE_URL,
        },
        browserbaseSessionCreateParams: {
          projectId,
          browserSettings: {
            blockAds: true,
            context: contextId
              ? {
                  id: contextId,
                  persist: true,
                }
              : undefined,
          },
        },
        experimental: true,
        disableAPI: true,
      });

      await this.stagehand.init();
      const sessionId = this.stagehand.browserbaseSessionID!;
      createLease.confirmCreated(sessionId);
      leaseConfirmed = true;
      this.activeSessionId = sessionId;

      this.assertNotAborted();
      const liveViewUrl = `https://browserbase.com/sessions/${sessionId}`;
      console.log(liveViewUrl);
      this.emit({ type: 'session:ready', sessionId, liveViewUrl });

      // Only navigate if a starting URL is provided; otherwise the first navigate step will handle it
      if (startingUrl) {
        const page = this.stagehand.context.pages()[0];
        await page.goto(startingUrl, { waitUntil: 'domcontentloaded' });
        console.log(`[ORCHESTRATOR] Navigated to ${startingUrl}`);
      }
    } catch (error) {
      if (!leaseConfirmed) {
        createLease.cancel();
      }
      throw error;
    }
  }

  private async close(): Promise<void> {
    const sessionId = this.stagehand?.browserbaseSessionID ?? this.activeSessionId;
    const isLocal = !!this.options.localCdpUrl;

    if (this.stagehand) {
      try {
        await this.stagehand.close();
      } catch {
        console.log('[ORCHESTRATOR] Error closing stagehand');
      }
      this.stagehand = null;
    }

    if (sessionId && !isLocal) {
      releaseBrowserbaseSession(sessionId);
    }
    this.activeSessionId = null;
  }

  /**
   * Wait for page to be ready for interaction by checking multiple signals:
   * 1. Loading indicators gone (spinners, skeletons, progress bars)
   * 2. Network idle (no pending requests)
   * 3. DOM stability (no significant mutations)
   */
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
    for (let i = 0; i < steps.length; i++) {
      const index = i + indexOffset;
      this.assertNotAborted();
      const step = steps[i];
      const instruction = this.describeStepInstruction(step);
      this.emit({ type: 'step:start', step, index, instruction });

      // Wait for page to be ready before each step (except save which doesn't interact with page)
      // if (step.type !== 'save') {
      //   await this.waitForPageReady();
      // }

      if (step.type === 'step') {
        await this.executeSingleStep(step.description, context, index, step);
      } else if (step.type === 'loop') {
        await executeLoopStep(this.buildLoopDeps(step, index), step, index);
      } else if (step.type === 'conditional') {
        await this.executeConditionalStep(step, context, index);
      } else if (step.type === 'extract') {
        await this.executeExtractStep(step, context, index);
      } else if (step.type === 'save') {
        await this.executeSaveStep(step, context, index);
      } else if (step.type === 'navigate') {
        await this.executeNavigateStep(step, index);
      } else if (step.type === 'tab_navigate') {
        await this.executeTabNavigateStep(step, index);
      }

      this.assertNotAborted();
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

  private async executeNavigateStep(step: NavigateStep, index: number): Promise<void> {
    if (!this.stagehand) throw new Error('Browser session not initialized');

    console.log(`[ORCHESTRATOR] Navigating to: ${step.url}`);

    try {
      this.assertNotAborted();
      const page = this.stagehand.context.pages()[0];
      await page.goto(step.url, { waitUntil: 'domcontentloaded' });

      this.stepResults.push({
        instruction: `Navigate to ${step.url}`,
        success: true,
      });
      this.emit({ type: 'step:end', step, index, success: true });
    } catch (error: any) {
      console.error(`[ORCHESTRATOR] Navigation failed:`, error.message ?? error);
      this.stepResults.push({
        instruction: `Navigate to ${step.url}`,
        success: false,
        error: error.message,
      });
      this.emit({
        type: 'step:end',
        step,
        index,
        success: false,
        error: error?.message ?? 'Navigation failed',
      });
    }
  }

  private async executeTabNavigateStep(step: TabNavigateStep, index: number): Promise<void> {
    if (!this.stagehand) throw new Error('Browser session not initialized');

    console.log(`[ORCHESTRATOR] Tab navigating to: ${step.url}`);

    try {
      this.assertNotAborted();
      const pages = this.stagehand.context.pages();

      // Check if there's already a tab with this URL
      let targetPage = pages.find((page) => page.url() === step.url);

      if (targetPage) {
        // Tab exists, bring it to front
        console.log(`[ORCHESTRATOR] Found existing tab with URL, bringing to front`);
        if (typeof (targetPage as any).bringToFront === 'function') {
          await (targetPage as any).bringToFront();
        }
      } else {
        // Create a new tab and navigate
        console.log(`[ORCHESTRATOR] Creating new tab for URL`);
        targetPage = await this.stagehand.context.newPage();
        await targetPage.goto(step.url, { waitUntil: 'domcontentloaded' });
      }

      this.stepResults.push({
        instruction: `Tab navigate to ${step.url}`,
        success: true,
      });
      this.emit({ type: 'step:end', step, index, success: true });
    } catch (error: any) {
      console.error(`[ORCHESTRATOR] Tab navigation failed:`, error.message ?? error);
      this.stepResults.push({
        instruction: `Tab navigate to ${step.url}`,
        success: false,
        error: error.message,
      });
      this.emit({
        type: 'step:end',
        step,
        index,
        success: false,
        error: error?.message ?? 'Tab navigation failed',
      });
    }
  }

  private async executeExtractStep(
    step: ExtractStep,
    context: LoopContext | undefined,
    index: number,
  ): Promise<void> {
    if (!this.stagehand) throw new Error('Browser session not initialized');
    if (!this.openai) throw new Error('LLM client not initialized');

    const extractStart = Date.now();
    const activeUrl = this.getActivePageUrl();
    const provider = getSpreadsheetProvider(activeUrl);
    console.log(
      `[EXTRACT] start step_index=${index} provider=${provider ?? 'none'} url="${activeUrl}" description="${step.description}"`,
    );

    console.log(context);

    const contextualInstruction =
      context && context.item != null
        ? `Context item: ${JSON.stringify(context.item)}\nInstruction: ${step.description}`
        : step.description;

    const pageReadyStart = Date.now();
    await waitForPageReady(this.stagehand, undefined, this.assertNotAborted.bind(this));
    console.log(
      `[EXTRACT] page-ready duration_ms=${Date.now() - pageReadyStart} step_index=${index}`,
    );

    try {
      this.assertNotAborted();
      const schema = parseSchemaMap(step.dataSchema);
      console.log(
        `[EXTRACT] schema step_index=${index} fields=${Object.keys(schema ?? {}).length}`,
      );
      const sharedStrategyStart = Date.now();
      const result = await extractWithSharedStrategy({
        stagehand: this.stagehand,
        llmClient: this.openai,
        model: this.resolveModels().extract,
        dataExtractionGoal: contextualInstruction,
        schema,
        context,
        extractedVariables: this.extractedVariables,
      });
      console.log(
        `[EXTRACT] shared-strategy:end step_index=${index} mode=${result.mode} duration_ms=${Date.now() - sharedStrategyStart}`,
      );

      const output = result.scraped_data;
      const map: Record<string, string> = {};
      if (output && typeof output === 'object' && !Array.isArray(output)) {
        for (const [key, value] of Object.entries(output)) {
          if (typeof value === 'string') {
            map[key] = value;
          } else if (value === null || value === undefined) {
            map[key] = 'null';
          } else {
            map[key] = JSON.stringify(value);
          }
        }
      }

      if (Object.keys(map).length > 0) {
        Object.assign(this.extractedVariables, map);
        this.globalState.push({ ...map });
        console.log(
          `[ORCHESTRATOR] Extracted variables (saved to global state): ${JSON.stringify(map)}`,
        );
      }

      this.stepResults.push({
        instruction: step.description,
        success: true,
        output: JSON.stringify(output ?? {}),
      });
      console.log(
        `[EXTRACT] end step_index=${index} success=true total_duration_ms=${Date.now() - extractStart}`,
      );
      this.emit({ type: 'step:end', step, index, success: true });
    } catch (error: any) {
      console.error(
        `[ORCHESTRATOR] Extract failed after ${Date.now() - extractStart}ms:`,
        error.message ?? error,
      );
      this.stepResults.push({
        instruction: step.description,
        success: false,
        error: error.message,
      });
      this.emit({
        type: 'step:end',
        step,
        index,
        success: false,
        error: error?.message ?? 'Extract failed',
      });
    }
  }

  private async executeSaveStep(
    step: SaveStep,
    context: LoopContext | undefined,
    index: number,
  ): Promise<void> {
    console.log(`[ORCHESTRATOR] Executing save: ${step.description}`);

    try {
      const savedFile = await this.generateSavedFile(step.description);
      this.savedFiles.push(savedFile);
      console.log(
        `[ORCHESTRATOR] Save step produced ${savedFile.outputExtension} file (${this.savedFiles.length} total)`,
      );

      this.stepResults.push({
        instruction: step.description,
        success: true,
        output: JSON.stringify({
          outputExtension: savedFile.outputExtension,
          savedFileIndex: this.savedFiles.length - 1,
        }),
      });
      this.emit({
        type: 'step:end',
        step,
        index,
        success: true,
        savedFile: {
          output: savedFile.output,
          outputExtension: savedFile.outputExtension,
          savedFileIndex: this.savedFiles.length - 1,
        },
      });
    } catch (error: any) {
      console.error(`[ORCHESTRATOR] Save step failed:`, error.message ?? error);

      // Fallback: save raw globalState as JSON
      const fallback: SavedFile = {
        output: JSON.stringify(this.globalState ?? [], null, 2),
        outputExtension: 'json',
      };
      this.savedFiles.push(fallback);

      this.stepResults.push({
        instruction: step.description,
        success: true,
        output: JSON.stringify({
          outputExtension: 'json',
          savedFileIndex: this.savedFiles.length - 1,
          fallback: true,
        }),
      });
      this.emit({
        type: 'step:end',
        step,
        index,
        success: true,
        savedFile: {
          output: fallback.output,
          outputExtension: 'json',
          savedFileIndex: this.savedFiles.length - 1,
          fallback: true,
        },
      });
    }
  }

  private async generateSavedFile(saveDescription: string): Promise<SavedFile> {
    if (!this.openai) throw new Error('LLM client not initialized');

    const globalStateJson = JSON.stringify(this.globalState ?? [], null, 2);

    const response = await this.openai.chat.completions.create({
      model: this.resolveModels().save,
      messages: [
        {
          role: 'system',
          content:
            'You generate an output file for a completed workflow. ' +
            'The output should contain ONLY the data the user asked to save — no titles, summaries, or metadata about the workflow itself. ' +
            'Choose the best file format based on the data:\n' +
            '- "csv" for tabular/list data\n' +
            '- "excel" when the user asks for an Excel/spreadsheet file (return CSV content in "output" for conversion)\n' +
            '- "json" for structured data\n' +
            '- "txt" for plain text\n' +
            '- "md" for rich formatted text\n' +
            'Return a JSON object with "output" (the file contents) and "outputExtension" (one of: txt, csv, excel, md, json).',
        },
        {
          role: 'user',
          content:
            `Workflow: ${this.workflowName}\n\n` +
            `Save instruction: ${saveDescription}\n\n` +
            `Collected data JSON:\n${globalStateJson}\n\n` +
            'Generate the output file containing only the saved data in the most appropriate format. ' +
            'Do not include workflow metadata, summaries, or descriptions — just the data itself.',
        },
      ],
      response_format: { type: 'json_object' },
    });

    const rawContent = response.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(rawContent);
    const output = parsed?.output;
    const outputExtension = parsed?.outputExtension;

    console.log({ output, outputExtension });
    if (typeof output !== 'string' || output.trim().length === 0) {
      throw new Error('Invalid output response from LLM');
    }
    if (!['txt', 'csv', 'excel', 'md', 'json'].includes(outputExtension)) {
      throw new Error('Invalid output extension from LLM');
    }

    return { output: output.trim(), outputExtension };
  }

  private async executeSingleStep(
    instruction: string,
    context: LoopContext | undefined,
    index: number,
    step: Step,
  ): Promise<void> {
    if (!this.stagehand) throw new Error('Browser session not initialized');

    const contextualInstruction =
      context && context.item != null
        ? `${instruction} on item ${JSON.stringify(context.item)}`
        : instruction;

    console.log(`[STEP] Executing step: ${contextualInstruction}`);

    this.assertNotAborted();

    let stepOutput: string | undefined;

    const tools = createBrowserTabTools(this.stagehand, {
      onRequestCredentials: (request) =>
        this.requestCredentialHandoff(request, step, index, instruction),
    });

    const agentConfig = {
      systemPrompt: buildSystemPrompt(this.extractedVariables, context),
      tools,
      model: {
        modelName: this.resolveModels().agent,
        apiKey: process.env.OPENROUTER_API_KEY,
        baseURL: OPENROUTER_BASE_URL,
      },
    } as const;

    const usageTotals = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    };
    const prepareStep = this.buildPrepareStepForActiveTools(`executeSingleStep:${index}`);
    let chunksSinceLastStepFinish = 0;
    const streamChunkText = new Map<string, string>();

    const onStepFinish = (event: any) => {
      const stepText = typeof event?.text === 'string' ? event.text : '';
      if (chunksSinceLastStepFinish === 0 && stepText.length > 0) {
        this.emit({
          type: 'step:reasoning',
          step,
          index,
          delta: stepText,
        });
      }
      chunksSinceLastStepFinish = 0;
      streamChunkText.clear();

      const stepInputTokens = Number(event?.usage?.inputTokens ?? 0);
      const stepCachedInputTokens = Number(event?.usage?.cachedInputTokens ?? 0);
      const stepOutputTokens = Number(event?.usage?.outputTokens ?? 0);

      usageTotals.inputTokens += Number.isFinite(stepInputTokens) ? stepInputTokens : 0;
      usageTotals.cachedInputTokens += Number.isFinite(stepCachedInputTokens)
        ? stepCachedInputTokens
        : 0;
      usageTotals.outputTokens += Number.isFinite(stepOutputTokens) ? stepOutputTokens : 0;

      const toolCalls: Array<{ toolName?: string }> = Array.isArray(event?.toolCalls)
        ? event.toolCalls
        : [];
      if (toolCalls.length === 0) return;

      const toolResults: unknown[] = Array.isArray(event?.toolResults) ? event.toolResults : [];

      for (const [toolIndex, toolCall] of toolCalls.entries()) {
        const toolName =
          typeof toolCall?.toolName === 'string' && toolCall.toolName.trim().length > 0
            ? toolCall.toolName
            : 'unknown';
        this.logUsageAfterToolCall(toolName, usageTotals, {
          inputTokens: Number.isFinite(stepInputTokens) ? stepInputTokens : 0,
          cachedInputTokens: Number.isFinite(stepCachedInputTokens) ? stepCachedInputTokens : 0,
          outputTokens: Number.isFinite(stepOutputTokens) ? stepOutputTokens : 0,
        });
        // if (toolIndex < toolResults.length) {
        //   console.log(
        //     `[ORCHESTRATOR] Tool result "${toolName}": ${this.summarizeToolResultForLog(toolResults[toolIndex])}`,
        //   );
        // }
      }
    };

    try {
      const streamResult = await this.stagehand
        .agent({
          ...agentConfig,
          mode: 'hybrid',
          stream: true,
        })
        .execute({
          instruction: instruction,
          maxSteps: 50,
          callbacks: {
            prepareStep,
            onStepFinish,
            onChunk: ({ chunk }: any) => {
              if (chunk?.type !== 'reasoning-delta' && chunk?.type !== 'text-delta') return;
              const delta = typeof chunk?.text === 'string' ? chunk.text : '';
              if (!delta) return;
              const chunkId = typeof chunk?.id === 'string' ? chunk.id : 'default';
              const nextText = `${streamChunkText.get(chunkId) ?? ''}${delta}`;
              streamChunkText.set(chunkId, nextText);
              chunksSinceLastStepFinish += 1;
              this.emit({
                type: 'step:reasoning',
                step,
                index,
                delta: nextText,
              });
            },
          },
        });
      await streamResult.consumeStream();
      const result = await streamResult.result;

      this.assertNotAborted();
      this.stepResults.push({
        instruction: instruction,
        success: result.success,
        output: stepOutput,
        error: result.success ? undefined : result.message,
      });

      console.log(
        `[ORCHESTRATOR] Step completed: success=${result.success}${result.success ? '' : ` | message: ${result.message}`}`,
      );
      this.emit({
        type: 'step:end',
        step,
        index,
        success: Boolean(result.success),
        ...(result.success ? {} : { error: result.message || 'Agent could not complete the task' }),
      });
    } catch (error: any) {
      console.error(`[ORCHESTRATOR] Step failed:`, error.message ?? error);
      if (error.cause) console.error(`[ORCHESTRATOR] Cause:`, error.cause);
      if (error.stack) console.error(`[ORCHESTRATOR] Stack:`, error.stack);
      this.stepResults.push({
        instruction,
        success: false,
        error: error.message,
      });
      this.emit({
        type: 'step:end',
        step,
        index,
        success: false,
        error: error?.message ?? 'Step failed',
      });
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
      requestCredentialHandoff: (request) =>
        this.requestCredentialHandoff(
          request,
          loopStep,
          loopIndex,
          this.describeStepInstruction(loopStep),
        ),
    };
  }

  private formatLoopContext(context?: LoopContext): string {
    if (!context) return 'None';
    const summary: Record<string, unknown> = {};
    if (context.itemIndex != null) summary.itemIndex = context.itemIndex;
    if (context.item != null) summary.item = context.item;
    return Object.keys(summary).length > 0 ? JSON.stringify(summary, null, 2) : 'None';
  }

  private async executeConditionalStep(
    step: ConditionalStep,
    context: LoopContext | undefined,
    index: number,
  ): Promise<void> {
    if (!this.stagehand) throw new Error('Browser session not initialized');

    console.log(`[ORCHESTRATOR] Evaluating condition: ${step.condition}`);

    let conditionMet: boolean | 'unsure' = 'unsure';

    this.assertNotAborted();
    if (context && this.openai) {
      try {
        const response = await this.openai.chat.completions.create({
          model: this.resolveModels().conditional,
          messages: [
            {
              role: 'system',
              content:
                'You are a helpful assistant that evaluates conditions based on provided context. You must return a JSON object with a single key "result" which can be "true", "false", or "unsure". Only return "unsure" if the context does not contain enough information to be certain.',
            },
            {
              role: 'user',
              content: `Context:\n${this.formatLoopContext(context)}\n\nExtracted Variables:\n${JSON.stringify(this.extractedVariables, null, 2)}\n\nCondition: ${step.condition}`,
            },
          ],
          response_format: { type: 'json_object' },
        });

        const rawContent = response.choices[0]?.message?.content ?? '{}';
        const parsed = JSON.parse(rawContent);
        const result = parsed?.result as 'true' | 'false' | 'unsure';
        console.log(`[ORCHESTRATOR] Quick evaluation result: ${result}`);

        if (result === 'true') {
          conditionMet = true;
        } else if (result === 'false') {
          conditionMet = false;
        } else {
          conditionMet = 'unsure';
        }
      } catch (error: any) {
        console.error(`[ORCHESTRATOR] Quick evaluation failed: ${error.message}`);
        conditionMet = 'unsure';
      }
    }

    if (conditionMet === 'unsure') {
      const agent = this.stagehand.agent({
        systemPrompt: buildSystemPrompt(this.extractedVariables, context),
        tools: createBrowserTabTools(this.stagehand, {
          onRequestCredentials: (request) =>
            this.requestCredentialHandoff(request, step, index, this.describeStepInstruction(step)),
        }),
        stream: false,
        mode: 'hybrid',
      });

      try {
        const conditionInstruction = context
          ? `Context:\n${this.formatLoopContext(context)}\n\nEvaluate this condition based on what you see on the page and any available memories: "${step.condition}". Return whether the condition is true or false.`
          : `Evaluate this condition based on what you see on the page and any available memories: "${step.condition}". Return whether the condition is true or false.`;
        const result = await withTimeout(
          agent.execute({
            instruction: conditionInstruction,
            maxSteps: 10,
            callbacks: {
              prepareStep: this.buildPrepareStepForActiveTools(`executeConditionalStep:${index}`),
            },
            output: z.object({
              conditionMet: z.boolean().describe('Whether the condition is met'),
            }),
          }),
          AGENT_TIMEOUT_MS,
          `agent.execute for condition "${step.condition.slice(0, 50)}"`,
        );
        conditionMet = Boolean(result.output?.conditionMet);
        console.log(`[ORCHESTRATOR] Agent evaluation: "${step.condition}" => ${conditionMet}`);
      } catch (error: any) {
        console.error(`[ORCHESTRATOR] Agent evaluation failed:`, error.message ?? error);
        conditionMet = false;
      }
    }

    const stepsToRun = conditionMet === true ? step.trueSteps : (step.falseSteps ?? []);
    if (stepsToRun.length > 0) {
      await this.executeSteps(stepsToRun, context);
    }
    this.emit({ type: 'step:end', step, index, success: true });
  }

  private async captureBrowserState(): Promise<BrowserState> {
    if (!this.stagehand) throw new Error('Browser session not initialized');

    const pages = this.stagehand.context.pages();
    const activePage = this.stagehand.context.activePage();

    const tabs: TabState[] = pages.map((page, index) => ({
      url: page.url(),
      index,
    }));

    const activeTabIndex = activePage ? pages.indexOf(activePage) : 0;

    console.log(
      `[ORCHESTRATOR] Captured browser state: ${tabs.length} tabs, active tab index: ${activeTabIndex}`,
    );

    return {
      tabs,
      activeTabIndex: activeTabIndex >= 0 ? activeTabIndex : 0,
    };
  }

  private async restoreBrowserState(state: BrowserState): Promise<void> {
    if (!this.stagehand) throw new Error('Browser session not initialized');

    console.log(
      `[ORCHESTRATOR] Restoring browser state: ${state.tabs.length} tabs, active tab index: ${state.activeTabIndex}`,
    );

    const currentPages = this.stagehand.context.pages();

    // Close extra tabs (from end to preserve indices)
    if (currentPages.length > state.tabs.length) {
      for (let i = currentPages.length - 1; i >= state.tabs.length; i--) {
        try {
          await currentPages[i].close();
          console.log(`[ORCHESTRATOR] Closed extra tab at index ${i}`);
        } catch (error: any) {
          console.warn(`[ORCHESTRATOR] Failed to close tab at index ${i}: ${error.message}`);
        }
      }
    }

    // Open new tabs if current count < saved count
    const pagesAfterClose = this.stagehand.context.pages();
    while (pagesAfterClose.length < state.tabs.length) {
      try {
        const newPage = await this.stagehand.context.newPage();
        pagesAfterClose.push(newPage);
        console.log(`[ORCHESTRATOR] Opened new tab, total tabs: ${pagesAfterClose.length}`);
      } catch (error: any) {
        console.warn(`[ORCHESTRATOR] Failed to open new tab: ${error.message}`);
        break;
      }
    }

    // Navigate each tab back to its original URL (only if URL changed)
    const finalPages = this.stagehand.context.pages();
    for (let i = 0; i < state.tabs.length && i < finalPages.length; i++) {
      const savedTab = state.tabs[i];
      const currentPage = finalPages[i];
      const currentUrl = currentPage.url();

      if (currentUrl !== savedTab.url) {
        try {
          await currentPage.goto(savedTab.url, {
            waitUntil: 'domcontentloaded',
            timeoutMs: 30000,
          });
          console.log(`[ORCHESTRATOR] Restored tab ${i} to ${savedTab.url}`);
        } catch (error: any) {
          console.warn(
            `[ORCHESTRATOR] Failed to restore tab ${i} to ${savedTab.url}: ${error.message}`,
          );
        }
      }
    }

    // Bring the original active tab to front
    if (state.activeTabIndex >= 0 && state.activeTabIndex < finalPages.length) {
      try {
        const targetPage = finalPages[state.activeTabIndex];
        if (typeof (targetPage as any).bringToFront === 'function') {
          await (targetPage as any).bringToFront();
          console.log(`[ORCHESTRATOR] Brought tab ${state.activeTabIndex} to front`);
        }
      } catch (error: any) {
        console.warn(
          `[ORCHESTRATOR] Failed to bring tab ${state.activeTabIndex} to front: ${error.message}`,
        );
      }
    }

    console.log('[ORCHESTRATOR] Browser state restoration complete');
  }
}

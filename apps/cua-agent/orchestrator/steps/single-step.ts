import type { Step, LoopContext, OrchestratorEvent } from '../../types';
import type { OrchestratorContext } from '../orchestrator-context';
import { createBrowserTabTools } from '../agent-tools';
import { buildSystemPrompt } from '../system-prompt';
import { OPENROUTER_BASE_URL } from '../orchestrator-context';

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function logUsageAfterToolCall(
  emit: (event: OrchestratorEvent) => void,
  toolName: string,
  totals: { inputTokens: number; cachedInputTokens: number; outputTokens: number },
  deltas?: { inputTokens: number; cachedInputTokens: number; outputTokens: number },
): void {
  const tokens = deltas ?? totals;
  console.log(
    `[ORCHESTRATOR] Usage after tool call "${toolName}": input_tokens=${tokens.inputTokens}, cached_input_tokens=${tokens.cachedInputTokens}, output_tokens=${tokens.outputTokens}`,
  );
  emit({
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

// ---------------------------------------------------------------------------
// executeSingleStep
// ---------------------------------------------------------------------------

export async function executeSingleStep(
  ctx: OrchestratorContext,
  instruction: string,
  context: LoopContext | undefined,
  index: number,
  step: Step,
): Promise<void> {
  if (!ctx.stagehand) throw new Error('Browser session not initialized');

  const contextualInstruction =
    context && context.item != null
      ? `${instruction} on item ${JSON.stringify(context.item)}`
      : instruction;

  console.log(`[STEP] Executing step: ${contextualInstruction}`);

  ctx.assertNotAborted();

  let stepOutput: string | undefined;

  const tools = createBrowserTabTools(ctx.stagehand, {
    onRequestCredentials: (request) =>
      ctx.requestCredentialHandoff(request, step, index, instruction),
  });

  const agentConfig = {
    systemPrompt: buildSystemPrompt(
      ctx.extractedVariables,
      ctx.sessionFiles.getDownloadedFiles(),
      context,
    ),
    tools,
    model: {
      modelName: ctx.resolveModels().agent,
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: OPENROUTER_BASE_URL,
    },
    interactionSync: ctx.sessionFiles.createAgentInteractionSync(),
  } as const;

  const usageTotals = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  const prepareStep = ctx.buildPrepareStepForActiveTools(`executeSingleStep:${index}`);
  let chunksSinceLastStepFinish = 0;
  const streamChunkText = new Map<string, string>();

  const onStepFinish = (event: any) => {
    const stepText = typeof event?.text === 'string' ? event.text : '';
    if (chunksSinceLastStepFinish === 0 && stepText.length > 0) {
      ctx.emit({
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

    for (const [toolIndex, toolCall] of toolCalls.entries()) {
      const toolName =
        typeof toolCall?.toolName === 'string' && toolCall.toolName.trim().length > 0
          ? toolCall.toolName
          : 'unknown';
      logUsageAfterToolCall(ctx.emit, toolName, usageTotals, {
        inputTokens: Number.isFinite(stepInputTokens) ? stepInputTokens : 0,
        cachedInputTokens: Number.isFinite(stepCachedInputTokens) ? stepCachedInputTokens : 0,
        outputTokens: Number.isFinite(stepOutputTokens) ? stepOutputTokens : 0,
      });
    }
  };

  try {
    const streamResult = await ctx.stagehand
      .agent({
        ...agentConfig,
        mode: 'hybrid',
        stream: true,
      })
      .execute({
        instruction: instruction,
        maxSteps: 50,
        highlightCursor: false,
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
            ctx.emit({
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
    await ctx.sessionFiles.waitForSettledChooserWork();

    ctx.assertNotAborted();
    ctx.stepResults.push({
      instruction: instruction,
      success: result.success,
      output: stepOutput,
      error: result.success ? undefined : result.message,
    });

    console.log(
      `[ORCHESTRATOR] Step completed: success=${result.success}${result.success ? '' : ` | message: ${result.message}`}`,
    );
    ctx.emit({
      type: 'step:end',
      step,
      index,
      success: Boolean(result.success),
      ...(result.success ? {} : { error: result.message || 'Agent could not complete the task' }),
    });
  } catch (error: any) {
    let finalError = error;
    try {
      await ctx.sessionFiles.waitForSettledChooserWork();
    } catch (fileChooserError) {
      finalError = fileChooserError;
    }
    console.error(`[ORCHESTRATOR] Step failed:`, finalError?.message ?? finalError ?? error);
    if (finalError?.cause) console.error(`[ORCHESTRATOR] Cause:`, finalError.cause);
    if (finalError?.stack) console.error(`[ORCHESTRATOR] Stack:`, finalError.stack);
    ctx.stepResults.push({
      instruction,
      success: false,
      error: finalError?.message ?? 'Step failed',
    });
    ctx.emit({
      type: 'step:end',
      step,
      index,
      success: false,
      error: finalError?.message ?? 'Step failed',
    });
  }
}

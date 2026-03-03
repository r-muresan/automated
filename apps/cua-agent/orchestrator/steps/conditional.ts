import { z } from 'zod';
import type { ConditionalStep, LoopContext } from '../../types';
import type { OrchestratorContext } from '../orchestrator-context';
import { OPENROUTER_BASE_URL } from '../orchestrator-context';
import { AGENT_TIMEOUT_MS } from '../constants';
import { withTimeout } from '../utils';
import { createBrowserTabTools } from '../agent-tools';
import { buildSystemPrompt } from '../system-prompt';

// ---------------------------------------------------------------------------
// Local helper
// ---------------------------------------------------------------------------

function formatLoopContext(context?: LoopContext): string {
  if (!context) return 'None';
  const summary: Record<string, unknown> = {};
  if (context.itemIndex != null) summary.itemIndex = context.itemIndex;
  if (context.item != null) summary.item = context.item;
  return Object.keys(summary).length > 0 ? JSON.stringify(summary, null, 2) : 'None';
}

// ---------------------------------------------------------------------------
// executeConditionalStep
// ---------------------------------------------------------------------------

export async function executeConditionalStep(
  ctx: OrchestratorContext,
  step: ConditionalStep,
  context: LoopContext | undefined,
  index: number,
): Promise<void> {
  if (!ctx.stagehand) throw new Error('Browser session not initialized');

  console.log(`[ORCHESTRATOR] Evaluating condition: ${step.condition}`);

  let conditionMet: boolean | 'unsure' = 'unsure';

  ctx.assertNotAborted();
  if (context && ctx.openai) {
    try {
      const response = await ctx.openai.chat.completions.create({
        model: ctx.resolveModels().conditional,
        messages: [
          {
            role: 'system',
            content:
              'You are a helpful assistant that evaluates conditions based on provided context. You must return a JSON object with a single key "result" which can be "true", "false", or "unsure". Only return "unsure" if the context does not contain enough information to be certain.',
          },
          {
            role: 'user',
            content: `Context:\n${formatLoopContext(context)}\n\nExtracted Variables:\n${JSON.stringify(ctx.extractedVariables, null, 2)}\n\nCondition: ${step.condition}`,
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
    const describeStepInstruction = (s: ConditionalStep) => `Conditional: ${s.condition}`;

    const agent = ctx.stagehand.agent({
      systemPrompt: buildSystemPrompt(
        ctx.extractedVariables,
        ctx.sessionFiles.getDownloadedFiles(),
        context,
      ),
      tools: createBrowserTabTools(ctx.stagehand, {
        onRequestCredentials: (request) =>
          ctx.requestCredentialHandoff(request, step, index, describeStepInstruction(step)),
      }),
      stream: false,
      mode: 'hybrid',
      interactionSync: ctx.sessionFiles.createAgentInteractionSync(),
    });

    try {
      const conditionInstruction = context
        ? `Context:\n${formatLoopContext(context)}\n\nEvaluate this condition based on what you see on the page and any available memories: "${step.condition}". Return whether the condition is true or false.`
        : `Evaluate this condition based on what you see on the page and any available memories: "${step.condition}". Return whether the condition is true or false.`;
      const result = await withTimeout(
        agent.execute({
          instruction: conditionInstruction,
          maxSteps: 10,
          callbacks: {
            prepareStep: ctx.buildPrepareStepForActiveTools(`executeConditionalStep:${index}`),
          },
          output: z.object({
            conditionMet: z.boolean().describe('Whether the condition is met'),
          }),
        }),
        AGENT_TIMEOUT_MS,
        `agent.execute for condition "${step.condition.slice(0, 50)}"`,
      );
      await ctx.sessionFiles.waitForSettledChooserWork();
      conditionMet = Boolean(result.output?.conditionMet);
      console.log(`[ORCHESTRATOR] Agent evaluation: "${step.condition}" => ${conditionMet}`);
    } catch (error: any) {
      try {
        await ctx.sessionFiles.waitForSettledChooserWork();
      } catch (fileChooserError) {
        throw fileChooserError;
      }
      console.error(`[ORCHESTRATOR] Agent evaluation failed:`, error.message ?? error);
      conditionMet = false;
    }
  }

  const stepsToRun = conditionMet === true ? step.trueSteps : (step.falseSteps ?? []);
  if (stepsToRun.length > 0) {
    await ctx.executeSteps(stepsToRun, context);
  }
  ctx.emit({ type: 'step:end', step, index, success: true });
}

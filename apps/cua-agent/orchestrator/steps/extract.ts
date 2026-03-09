import type { ExtractStep, LoopContext } from '../../types';
import type { OrchestratorContext } from '../orchestrator-context';
import { getSpreadsheetProvider } from '../agent-tools';
import { extractWithSharedStrategy, parseSchemaMap } from '../extraction';
import { waitForPageReady } from '../page-ready';

export async function executeExtractStep(
  ctx: OrchestratorContext,
  step: ExtractStep,
  context: LoopContext | undefined,
  index: number,
): Promise<void> {
  if (!ctx.stagehand) throw new Error('Browser session not initialized');
  if (!ctx.openai) throw new Error('LLM client not initialized');

  const extractStart = Date.now();
  const activeUrl = ctx.getActivePageUrl();
  const provider = getSpreadsheetProvider(activeUrl);
  console.log(
    `[EXTRACT] start step_index=${index} provider=${provider ?? 'none'} url="${activeUrl}" description="${step.description}"`,
  );

  const contextualInstruction =
    context && context.item != null
      ? `For this specific item: ${JSON.stringify(context.item)}\nInstruction: ${step.description}`
      : step.description;

  const pageReadyStart = Date.now();
  if (!provider) {
    await waitForPageReady(ctx.stagehand, undefined, ctx.assertNotAborted.bind(ctx));
  }

  console.log(
    `[EXTRACT] page-ready duration_ms=${Date.now() - pageReadyStart} step_index=${index}`,
  );

  try {
    ctx.assertNotAborted();
    const schema = parseSchemaMap(step.dataSchema);
    console.log(`[EXTRACT] schema step_index=${index} fields=${Object.keys(schema ?? {}).length}`);
    const sharedStrategyStart = Date.now();
    const result = await extractWithSharedStrategy({
      stagehand: ctx.stagehand,
      llmClient: ctx.openai,
      model: ctx.resolveModels().extract,
      dataExtractionGoal: contextualInstruction,
      schema,
      context,
      extractedVariables: ctx.extractedVariables,
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
      Object.assign(ctx.extractedVariables, map);
      ctx.globalState.push({ ...map });
      console.log(
        `[ORCHESTRATOR] Extracted variables (saved to global state): ${JSON.stringify(map)}`,
      );
    }

    ctx.stepResults.push({
      instruction: step.description,
      success: true,
      output: JSON.stringify(output ?? {}),
    });
    console.log(
      `[EXTRACT] end step_index=${index} success=true total_duration_ms=${Date.now() - extractStart}`,
    );
    ctx.emit({ type: 'step:end', step, index, success: true });
  } catch (error: any) {
    console.error(
      `[ORCHESTRATOR] Extract failed after ${Date.now() - extractStart}ms:`,
      error.message ?? error,
    );
    ctx.stepResults.push({
      instruction: step.description,
      success: false,
      error: error.message,
    });
    ctx.emit({
      type: 'step:end',
      step,
      index,
      success: false,
      error: error?.message ?? 'Extract failed',
    });
  }
}

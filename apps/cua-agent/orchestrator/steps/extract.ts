import type { ExtractStep, LoopContext } from '../../types';
import type { OrchestratorContext } from '../orchestrator-context';
import { getSpreadsheetProvider } from '../agent-tools';
import { extractWithSharedStrategy } from '../extraction';
import { waitForPageReady } from '../page-ready';

function flattenToMap(output: unknown): Record<string, unknown> {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return {};
  return { ...(output as Record<string, unknown>) };
}

function extractExpandedItems(output: unknown): Record<string, unknown>[] | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  const entries = Object.entries(output as Record<string, unknown>);
  if (entries.length !== 1) return null;
  const [, value] = entries[0];
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((v) => v && typeof v === 'object' && !Array.isArray(v))) return null;
  return value.map((item: Record<string, unknown>) => ({ ...item }));
}

function mergeIntoGlobalState(
  globalState: { source: string; items: Record<string, unknown>[] }[],
  source: string,
  items: Record<string, unknown>[],
): void {
  const existing = globalState.find((entry) => entry.source === source);
  if (existing) {
    existing.items.push(...items);
  } else {
    globalState.push({ source, items });
  }
}

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
    const sharedStrategyStart = Date.now();
    const result = await extractWithSharedStrategy({
      stagehand: ctx.stagehand,
      llmClient: ctx.openai,
      model: ctx.resolveModels().extract,
      dataExtractionGoal: contextualInstruction,
      context,
      globalState: ctx.globalState,
    });
    console.log(
      `[EXTRACT] shared-strategy:end step_index=${index} mode=${result.mode} duration_ms=${Date.now() - sharedStrategyStart}`,
    );

    const output = result.scraped_data;

    // Build source label: step description + loop context if any
    let source = step.description;
    if (context?.item != null) {
      source += ` (loop item ${context.itemIndex ?? '?'}: ${JSON.stringify(context.item)})`;
    }

    const expandedItems = extractExpandedItems(output);
    const items = expandedItems ?? [flattenToMap(output)];
    const nonEmpty = expandedItems ? items : items.filter((m) => Object.keys(m).length > 0);

    if (nonEmpty.length > 0) {
      mergeIntoGlobalState(ctx.globalState, source, nonEmpty);
      console.log(
        expandedItems
          ? `[ORCHESTRATOR] Extracted ${nonEmpty.length} items (expanded array, saved to global state)`
          : `[ORCHESTRATOR] Extracted variables (saved to global state): ${JSON.stringify(nonEmpty[0])}`,
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

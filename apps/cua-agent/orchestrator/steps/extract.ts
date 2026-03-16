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

    // Check if the output is an object with a single key whose value is an array of objects.
    // In that case, expand the array items directly into globalState instead of stringifying.
    let expandedItems: Record<string, string>[] | null = null;
    if (output && typeof output === 'object' && !Array.isArray(output)) {
      const entries = Object.entries(output);
      if (entries.length === 1) {
        const [, value] = entries[0];
        if (
          Array.isArray(value) &&
          value.length > 0 &&
          value.every((v) => v && typeof v === 'object' && !Array.isArray(v))
        ) {
          expandedItems = value.map((item: Record<string, unknown>) => {
            const row: Record<string, string> = {};
            for (const [k, v] of Object.entries(item)) {
              if (typeof v === 'string') row[k] = v;
              else if (v === null || v === undefined) row[k] = 'null';
              else row[k] = JSON.stringify(v);
            }
            return row;
          });
        }
      }
    }

    if (expandedItems && expandedItems.length > 0) {
      // Store each array element as a separate item in globalState
      const existing = ctx.globalState.find(
        (entry: any) => entry.source === source,
      );
      if (existing) {
        existing.items.push(...expandedItems);
      } else {
        ctx.globalState.push({ source, items: expandedItems });
      }

      console.log(
        `[ORCHESTRATOR] Extracted ${expandedItems.length} items (expanded array, saved to global state)`,
      );
    } else {
      // Fallback: flatten all values to strings and store as a single item
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
        const existing = ctx.globalState.find(
          (entry: any) => entry.source === source,
        );
        if (existing) {
          existing.items.push({ ...map });
        } else {
          ctx.globalState.push({ source, items: [{ ...map }] });
        }

        console.log(
          `[ORCHESTRATOR] Extracted variables (saved to global state): ${JSON.stringify(map)}`,
        );
      }
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

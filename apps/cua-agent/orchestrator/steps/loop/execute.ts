import type { LoopStep } from '../../../types';
import { resolveCollector, type CollectedItem } from '../../extraction';
import { waitForPageReady } from '../../page-ready';
import type { LoopDeps } from './deps';
import { deriveLoopPlan } from './plan';
import fs from 'fs/promises';

type StagehandPage = ReturnType<LoopDeps['stagehand']['context']['pages']>[number];

async function closeIterationTabs(params: {
  deps: LoopDeps;
  initialPages: Set<StagehandPage>;
  initialActivePage: StagehandPage;
}): Promise<void> {
  const { deps, initialPages, initialActivePage } = params;

  const currentPages = deps.stagehand.context.pages();
  const firstPage = currentPages[0];
  const newPages = currentPages.filter((p) => !initialPages.has(p) && p !== firstPage);

  for (const page of newPages) {
    await page.close();
  }

  if (newPages.length > 0) {
    deps.stagehand.context.setActivePage(initialActivePage);
    await initialActivePage.sendCDP('Page.bringToFront');
  }
}

async function processItems(params: {
  deps: LoopDeps;
  step: LoopStep;
  index: number;
  items: CollectedItem[];
  totalProcessed: number;
  maxItems: number;
  processedItems: CollectedItem[];
  initialPages: Set<StagehandPage>;
  initialActivePage: StagehandPage;
  preLoopStateLength: number;
  iterationStateAccumulator: any[];
}): Promise<number> {
  const {
    deps,
    step,
    index,
    items,
    maxItems,
    processedItems,
    initialPages,
    initialActivePage,
    preLoopStateLength,
    iterationStateAccumulator,
  } = params;
  let { totalProcessed } = params;

  for (const item of items) {
    if (totalProcessed >= maxItems) break;
    deps.assertNotAborted();

    console.log(`[LOOP] Processing item ${totalProcessed + 1}: "${item.fingerprint}"`);

    // Scope iteration state: collect any entries added by previous iteration,
    // then reset globalState back to pre-loop snapshot so iterations are isolated.
    const addedByPrevIteration = deps.globalState.splice(preLoopStateLength);
    if (addedByPrevIteration.length > 0) {
      iterationStateAccumulator.push(...addedByPrevIteration);
    }

    deps.emit({
      type: 'loop:iteration:start',
      step,
      index,
      iteration: totalProcessed + 1,
      totalItems: totalProcessed + items.length,
      item: item.data,
    });

    let iterationSuccess = true;
    let iterationError: string | undefined;

    try {
      await deps.executeSteps(step.steps, {
        item: item.data,
        itemIndex: totalProcessed + 1,
      });
    } catch (error: any) {
      iterationSuccess = false;
      iterationError = error?.message ?? 'Iteration failed';
      console.warn(`[LOOP] Item "${item.fingerprint}" failed: ${iterationError}`);
    }

    processedItems.push(item);
    totalProcessed++;

    deps.emit({
      type: 'loop:iteration:end',
      step,
      index,
      iteration: totalProcessed,
      totalItems: totalProcessed,
      success: iterationSuccess,
      error: iterationError,
    });

    await closeIterationTabs({ deps, initialPages, initialActivePage });
  }

  return totalProcessed;
}

export async function executeLoopStep(
  deps: LoopDeps,
  step: LoopStep,
  index: number,
): Promise<void> {
  console.log(`[LOOP] Starting: "${step.description}"`);
  deps.assertNotAborted();

  const loopPlan = await deriveLoopPlan(deps, step);
  let maxItems = loopPlan.maxItems;
  console.log(`[LOOP] Plan: query="${loopPlan.query}" maxItems=${maxItems}`);

  let loopSuccess = true;
  let loopError: string | undefined;

  await waitForPageReady(deps.stagehand);

  const initialPages = new Set(deps.stagehand.context.pages());
  const initialActivePage =
    deps.stagehand.context.activePage() ?? deps.stagehand.context.pages()[0];

  // Snapshot globalState length before the loop so iteration data can be scoped.
  // Each iteration will only see pre-loop state; iteration-specific data is
  // accumulated separately and merged back after the loop completes.
  const preLoopStateLength = deps.globalState.length;
  const iterationStateAccumulator: any[] = [];

  try {
    const resolved = await resolveCollector({
      stagehand: deps.stagehand,
      llmClient: deps.openai,
      model: deps.models.extract,
      description: loopPlan.query,
      downloadedFiles: deps.getDownloadedFiles(),
    });

    if (!resolved) {
      console.log('[LOOP] No collector found items — skipping');
      deps.emit({ type: 'step:end', step, index, success: true });
      return;
    }

    const { mode, collector, firstPage: rawFirstPage, targetItemCount } = resolved;
    console.log(`[LOOP] Using ${mode} collector`);

    // If the extraction model detected a specific target count (e.g. "first 6 stocks"),
    // use it to cap maxItems so the loop stops at the right number.
    if (targetItemCount != null && targetItemCount > 0) {
      maxItems = Math.min(maxItems, targetItemCount);
      console.log(`[LOOP] targetItemCount=${targetItemCount} → capped maxItems=${maxItems}`);
    }

    const savedLoopItemsJson = JSON.stringify(
      rawFirstPage.map((i, idx) => ({ index: idx + 1, ...i.data })),
      null,
      2,
    );
    fs.writeFile('loop-items.json', savedLoopItemsJson);

    const processedItems: CollectedItem[] = [];

    // Process first page
    let totalProcessed = await processItems({
      deps,
      step,
      index,
      items: rawFirstPage,
      totalProcessed: 0,
      maxItems: maxItems,
      processedItems,
      initialPages,
      initialActivePage,
      preLoopStateLength,
      iterationStateAccumulator,
    });

    // Collect and process subsequent pages
    let pageIndex = 1;
    while (totalProcessed < maxItems) {
      deps.assertNotAborted();

      const rawBatch = await collector.collect(pageIndex++);

      if (rawBatch.length === 0) break;

      console.log(`[LOOP] Page ${pageIndex - 1}: ${rawBatch.length} item(s) via ${mode}`);

      totalProcessed = await processItems({
        deps,
        step,
        index,
        items: rawBatch,
        totalProcessed,
        maxItems: maxItems,
        processedItems,
        initialPages,
        initialActivePage,
        preLoopStateLength,
        iterationStateAccumulator,
      });
    }

    console.log(`[LOOP] Complete: "${step.description}" — ${totalProcessed} item(s) via ${mode}`);
  } catch (error: any) {
    if ((error as any)?.message === 'Workflow aborted') throw error;
    loopSuccess = false;
    loopError = error?.message ?? 'Loop failed';
    console.error(`[LOOP] Error: ${loopError}`);
  }

  // Merge iteration-scoped state back into globalState.
  // Collect any entries from the final iteration first.
  const finalIterationEntries = deps.globalState.splice(preLoopStateLength);
  if (finalIterationEntries.length > 0) {
    iterationStateAccumulator.push(...finalIterationEntries);
  }
  // Push all iteration data back so it's visible globally after the loop.
  if (iterationStateAccumulator.length > 0) {
    deps.globalState.push(...iterationStateAccumulator);
  }

  deps.emit({
    type: 'step:end',
    step,
    index,
    success: loopSuccess,
    error: loopError,
  });
}

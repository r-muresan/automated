import OpenAI from 'openai';
import type { Stagehand } from '../../../stagehand/v3';
import { extractDom, extractWithKnownSelector } from '../dom';
import { buildDeterministicItemKey } from '../item-key';
import { scrollPageDown, tryClickPaginationButton } from '../pagination';
import type { UnifiedExtractor, ExtractOutput, CollectedItem } from '../types';

const MAX_SCROLL_ATTEMPTS = 3;

export function createDomStrategy(params: {
  stagehand: Stagehand;
  llmClient: OpenAI;
  model: string;
  dataExtractionGoal: string;
}): UnifiedExtractor {
  const { stagehand, llmClient, model, dataExtractionGoal } = params;

  let cachedSelector: string | null = null;
  let discoveryDone = false;
  let exhausted = false;
  let resolvedTargetItemCount: number | null = null;
  const knownFingerprints = new Set<string>();

  function toCollectedItems(data: unknown): CollectedItem[] {
    const items: CollectedItem[] = [];

    // Handle { items: [...] } format from mapElements
    let rawItems: unknown[];
    if (data && typeof data === 'object' && 'items' in data && Array.isArray((data as any).items)) {
      rawItems = (data as any).items;
    } else if (data && typeof data === 'object' && 'extraction' in data) {
      // Single element extraction
      rawItems = [data as Record<string, unknown>];
    } else if (Array.isArray(data)) {
      rawItems = data;
    } else if (data && typeof data === 'object') {
      rawItems = [data as Record<string, unknown>];
    } else {
      return [];
    }

    for (const raw of rawItems) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const record = raw as Record<string, unknown>;
      const fingerprint = buildDeterministicItemKey(record);
      if (knownFingerprints.has(fingerprint)) continue;
      knownFingerprints.add(fingerprint);
      items.push({ fingerprint, data: record });
    }

    return items;
  }

  return {
    name: 'dom',
    get targetItemCount() { return resolvedTargetItemCount; },
    set targetItemCount(v: number | null) { resolvedTargetItemCount = v; },

    async extract(): Promise<ExtractOutput | null> {
      const domSelectorStart = Date.now();
      const result = await extractDom({
        stagehand,
        llmClient,
        model,
        dataExtractionGoal,
      });
      if (result == null) return null;
      resolvedTargetItemCount = result.targetItemCount;
      console.log(
        `[EXTRACTION] dom-selector:success duration_ms=${Date.now() - domSelectorStart}`,
      );
      return {
        mode: 'dom',
        scraped_data: result.data,
      };
    },

    async collect(pageIndex: number): Promise<CollectedItem[]> {
      if (exhausted) return [];

      const page = stagehand.context.activePage() ?? stagehand.context.pages()[0];

      // Discover selector on first call
      if (!discoveryDone) {
        discoveryDone = true;
        const result = await extractDom({
          stagehand,
          llmClient,
          model,
          dataExtractionGoal,
        });

        if (!result) return [];

        cachedSelector = result.chosenSelector;
        resolvedTargetItemCount = result.targetItemCount;

        if (!cachedSelector) {
          // LLM chose "direct" strategy — no selector for pagination
          console.log('[LOOP-COLLECT] DOM: direct strategy chosen, no selector for pagination');
          return [];
        }

        console.log(`[LOOP-COLLECT] DOM: using selector "${cachedSelector}"`);
        const items = toCollectedItems(result.data);
        console.log(`[LOOP-COLLECT] DOM page 0: ${items.length} items`);
        return items;
      }

      if (!cachedSelector) return [];

      // Subsequent pages: scroll to reveal more items
      for (let i = 0; i < MAX_SCROLL_ATTEMPTS; i++) {
        const scrolled = await scrollPageDown(page);
        if (!scrolled) break;

        const data = await extractWithKnownSelector({
          page,
          llmClient,
          model,
          dataExtractionGoal,
          selector: cachedSelector,
        });

        const items = toCollectedItems(data);
        if (items.length > 0) {
          console.log(
            `[LOOP-COLLECT] DOM page ${pageIndex}: ${items.length} items after scroll ${i + 1}`,
          );
          return items;
        }
      }

      // Scroll exhausted — try pagination button via accessibility tree
      const clicked = await tryClickPaginationButton(stagehand);
      if (clicked) {
        const data = await extractWithKnownSelector({
          page,
          llmClient,
          model,
          dataExtractionGoal,
          selector: cachedSelector,
        });

        const items = toCollectedItems(data);
        if (items.length > 0) {
          console.log(
            `[LOOP-COLLECT] DOM page ${pageIndex}: ${items.length} items after pagination click`,
          );
          return items;
        }
      }

      exhausted = true;
      console.log(`[LOOP-COLLECT] DOM page ${pageIndex}: exhausted`);
      return [];
    },
  };
}

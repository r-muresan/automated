import OpenAI from 'openai';
import type { Stagehand } from '../../../stagehand/v3';
import { getSpreadsheetProvider } from '../../agent-tools';
import {
  captureSpreadsheetSnapshot,
  extractFromSpreadsheetWithLlm,
  extractLoopItemsFromSpreadsheetWithLlm,
} from '../spreadsheet';
import type { UnifiedExtractor, ExtractOutput, CollectedItem } from '../types';
import { deduplicateRawItems } from '../types';

const BATCH_SIZE = 20;

export function createSpreadsheetStrategy(params: {
  stagehand: Stagehand;
  llmClient: OpenAI;
  model: string;
  dataExtractionGoal: string;
}): UnifiedExtractor | null {
  const { stagehand, llmClient, model, dataExtractionGoal } = params;
  const page = stagehand.context.activePage() ?? stagehand.context.pages()[0];
  const activeUrl = page?.url?.() ?? '';

  if (!getSpreadsheetProvider(activeUrl)) return null;

  let cachedItems: CollectedItem[] | null = null;

  return {
    name: 'spreadsheet',
    targetItemCount: null,

    async extract(): Promise<ExtractOutput> {
      const snapshotStart = Date.now();
      const snapshot = await captureSpreadsheetSnapshot(stagehand);
      console.log(
        `[EXTRACTION] spreadsheet:snapshot-ready duration_ms=${Date.now() - snapshotStart} range="${snapshot.sampledRangeA1}"`,
      );
      const llmStart = Date.now();
      const result = await extractFromSpreadsheetWithLlm({
        llmClient,
        model,
        dataExtractionGoal,
        snapshot,
      });
      console.log(`[EXTRACTION] spreadsheet:llm-ready duration_ms=${Date.now() - llmStart}`);
      return {
        mode: 'spreadsheet',
        scraped_data: result,
      };
    },

    async collect(pageIndex: number): Promise<CollectedItem[]> {
      if (cachedItems === null) {
        console.log('[LOOP-COLLECT] Spreadsheet: loading items');
        const snapshot = await captureSpreadsheetSnapshot(stagehand);
        const rawItems = await extractLoopItemsFromSpreadsheetWithLlm({
          llmClient,
          model,
          description: dataExtractionGoal,
          snapshot,
        });
        cachedItems = deduplicateRawItems(rawItems);
        console.log(`[LOOP-COLLECT] Spreadsheet: ${cachedItems.length} items found`);
      }

      const start = pageIndex * BATCH_SIZE;
      if (start >= cachedItems.length) return [];
      const batch = cachedItems.slice(start, start + BATCH_SIZE);
      console.log(
        `[LOOP-COLLECT] Spreadsheet page ${pageIndex}: returning ${batch.length} items (${start + 1}-${start + batch.length} of ${cachedItems.length})`,
      );
      return batch;
    },
  };
}

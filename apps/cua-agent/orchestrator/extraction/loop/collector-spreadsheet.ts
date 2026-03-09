import OpenAI from 'openai';
import type { Stagehand } from '../../../stagehand/v3';
import { getSpreadsheetProvider } from '../../agent-tools';
import {
  captureSpreadsheetSnapshot,
  extractLoopItemsFromSpreadsheetWithLlm,
} from '../spreadsheet';
import type { CollectedItem, ItemCollector } from './types';
import { deduplicateRawItems } from './types';

const BATCH_SIZE = 20;

export function createSpreadsheetCollector(params: {
  stagehand: Stagehand;
  llmClient: OpenAI;
  model: string;
  description: string;
}): ItemCollector | null {
  const { stagehand, llmClient, model, description } = params;
  const page = stagehand.context.activePage() ?? stagehand.context.pages()[0];
  const activeUrl = page?.url?.() ?? '';

  if (!getSpreadsheetProvider(activeUrl)) return null;

  let cachedItems: CollectedItem[] | null = null;

  return {
    name: 'spreadsheet',
    async collect(pageIndex: number): Promise<CollectedItem[]> {
      if (cachedItems === null) {
        console.log('[LOOP-COLLECT] Spreadsheet: loading items');
        const snapshot = await captureSpreadsheetSnapshot(stagehand);
        const rawItems = await extractLoopItemsFromSpreadsheetWithLlm({
          llmClient,
          model,
          description,
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

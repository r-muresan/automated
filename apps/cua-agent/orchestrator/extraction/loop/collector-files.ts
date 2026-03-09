import OpenAI from 'openai';
import type { DownloadedSessionFile } from '../../../types';
import { extractLoopItemsFromDownloadedFilesWithLlm } from '../files';
import type { CollectedItem, ItemCollector } from './types';
import { deduplicateRawItems } from './types';

const BATCH_SIZE = 20;

export function createFilesCollector(params: {
  llmClient: OpenAI;
  model: string;
  description: string;
  downloadedFiles: DownloadedSessionFile[];
}): ItemCollector | null {
  const { llmClient, model, description, downloadedFiles } = params;

  if (downloadedFiles.length === 0) return null;

  let cachedItems: CollectedItem[] | null = null;

  return {
    name: 'files',
    async collect(pageIndex: number): Promise<CollectedItem[]> {
      if (cachedItems === null) {
        console.log('[LOOP-COLLECT] Files: loading items');
        const rawItems = await extractLoopItemsFromDownloadedFilesWithLlm({
          llmClient,
          model,
          description,
          downloadedFiles,
        });
        cachedItems = deduplicateRawItems(rawItems);
        console.log(`[LOOP-COLLECT] Files: ${cachedItems.length} items found`);
      }

      const start = pageIndex * BATCH_SIZE;
      if (start >= cachedItems.length) return [];
      const batch = cachedItems.slice(start, start + BATCH_SIZE);
      console.log(
        `[LOOP-COLLECT] Files page ${pageIndex}: returning ${batch.length} items (${start + 1}-${start + batch.length} of ${cachedItems.length})`,
      );
      return batch;
    },
  };
}

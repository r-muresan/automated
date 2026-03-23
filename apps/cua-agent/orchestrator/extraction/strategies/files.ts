import OpenAI from 'openai';
import type { DownloadedSessionFile } from '../../../types';
import { extractLoopItemsFromDownloadedFilesWithLlm } from '../files';
import type { UnifiedExtractor, ExtractOutput, CollectedItem } from '../types';
import { deduplicateRawItems } from '../types';

const BATCH_SIZE = 20;

export function createFilesStrategy(params: {
  llmClient: OpenAI;
  model: string;
  dataExtractionGoal: string;
  downloadedFiles: DownloadedSessionFile[];
}): UnifiedExtractor | null {
  const { llmClient, model, dataExtractionGoal, downloadedFiles } = params;

  if (downloadedFiles.length === 0) return null;

  let cachedItems: CollectedItem[] | null = null;

  return {
    name: 'files',
    targetItemCount: null,

    async extract(): Promise<ExtractOutput | null> {
      // Files extraction is only relevant for loop collection
      return null;
    },

    async collect(pageIndex: number): Promise<CollectedItem[]> {
      if (cachedItems === null) {
        console.log('[LOOP-COLLECT] Files: loading items');
        const rawItems = await extractLoopItemsFromDownloadedFilesWithLlm({
          llmClient,
          model,
          description: dataExtractionGoal,
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

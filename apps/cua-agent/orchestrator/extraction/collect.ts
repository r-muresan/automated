import OpenAI from 'openai';
import type { Stagehand } from '../../stagehand/v3';
import type { DownloadedSessionFile } from '../../types';
import type { ResolvedCollector, UnifiedExtractor } from './types';
import { createSpreadsheetStrategy } from './strategies/spreadsheet';
import { createFilesStrategy } from './strategies/files';
import { createDomStrategy } from './strategies/dom';
import { createVisionStrategy } from './strategies/vision';

/**
 * Tries strategies in priority order and returns the first one that produces items.
 * Returns the collector, its mode, and the already-fetched first page of items.
 */
export async function resolveCollector(params: {
  stagehand: Stagehand;
  llmClient: OpenAI;
  model: string;
  agentModel: string;
  description: string;
  downloadedFiles?: DownloadedSessionFile[];
}): Promise<ResolvedCollector | null> {
  const { stagehand, llmClient, model, agentModel, description } = params;
  const downloadedFiles = params.downloadedFiles ?? [];

  const shared = { stagehand, llmClient, model, agentModel, dataExtractionGoal: description };

  const strategies: (UnifiedExtractor | null)[] = [
    createSpreadsheetStrategy(shared),
    createFilesStrategy({ llmClient, model, dataExtractionGoal: description, downloadedFiles }),
    createDomStrategy(shared),
    createVisionStrategy(shared),
  ];

  for (const strategy of strategies) {
    if (!strategy) continue;

    console.log(`[LOOP-COLLECT] Trying collector: ${strategy.name}`);
    const firstPage = await strategy.collect(0);

    if (firstPage.length === 0) {
      console.log(`[LOOP-COLLECT] ${strategy.name}: no items, trying next`);
      continue;
    }

    console.log(`[LOOP-COLLECT] Using ${strategy.name}: ${firstPage.length} items on first page`);

    return {
      mode: strategy.name as ResolvedCollector['mode'],
      collector: { name: strategy.name, collect: (p: number) => strategy.collect(p) },
      firstPage,
      targetItemCount: strategy.targetItemCount,
    };
  }

  console.log('[LOOP-COLLECT] No collector produced items');
  return null;
}

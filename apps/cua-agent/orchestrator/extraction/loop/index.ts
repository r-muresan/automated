import OpenAI from 'openai';
import type { Stagehand } from '../../../stagehand/v3';
import type { DownloadedSessionFile } from '../../../types';
import { createSpreadsheetCollector } from './collector-spreadsheet';
import { createFilesCollector } from './collector-files';
import { createDomSelectorCollector } from './collector-dom';
import { createVisionCollector } from './collector-vision';
import type { CollectedItem, ItemCollector } from './types';

export type LoopCollectionMode = 'spreadsheet' | 'files' | 'dom-selector' | 'vision';

export interface ResolvedCollector {
  mode: LoopCollectionMode;
  collector: ItemCollector;
  firstPage: CollectedItem[];
}

type CollectorFactory = () => ItemCollector | null;

/**
 * Tries collectors in priority order and returns the first one that produces items.
 * Returns the collector, its mode, and the already-fetched first page of items.
 */
export async function resolveCollector(params: {
  stagehand: Stagehand;
  llmClient: OpenAI;
  model: string;
  description: string;
  downloadedFiles?: DownloadedSessionFile[];
}): Promise<ResolvedCollector | null> {
  const downloadedFiles = params.downloadedFiles ?? [];

  const factories: CollectorFactory[] = [
    () => createSpreadsheetCollector(params),
    () => createFilesCollector({ ...params, downloadedFiles }),
    () => createDomSelectorCollector(params),
    () => createVisionCollector(params),
  ];

  for (const factory of factories) {
    const collector = factory();
    if (!collector) continue;

    console.log(`[LOOP-COLLECT] Trying collector: ${collector.name}`);
    const firstPage = await collector.collect(0);

    if (firstPage.length === 0) {
      console.log(`[LOOP-COLLECT] ${collector.name}: no items, trying next`);
      continue;
    }

    console.log(
      `[LOOP-COLLECT] Using ${collector.name}: ${firstPage.length} items on first page`,
    );
    return { mode: collector.name as LoopCollectionMode, collector, firstPage };
  }

  console.log('[LOOP-COLLECT] No collector produced items');
  return null;
}

export type { CollectedItem, ItemCollector } from './types';

import OpenAI from 'openai';
import type { Stagehand } from '../../../stagehand/v3';
import { getSpreadsheetProvider } from '../../agent-tools';
import {
  captureSpreadsheetSnapshot,
  extractFromSpreadsheetWithLlm,
  extractLoopItemsFromSpreadsheetWithLlm,
} from '../spreadsheet';
import { buildDeterministicItemKey } from '../item-key';
import type { Extractor, ExtractOutput } from './types';
import type { ExtractionItem } from '../vision';

export function createSpreadsheetExtractor(params: {
  stagehand: Stagehand;
  llmClient: OpenAI;
  model: string;
  goalWithMemory: string;
}): Extractor | null {
  const { stagehand, llmClient, model, goalWithMemory } = params;
  const page = stagehand.context.activePage() ?? stagehand.context.pages()[0];
  const activeUrl = page?.url?.() ?? '';

  if (!getSpreadsheetProvider(activeUrl)) return null;

  return {
    name: 'spreadsheet',
    async tryExtract(): Promise<ExtractOutput> {
      const snapshotStart = Date.now();
      const snapshot = await captureSpreadsheetSnapshot(stagehand);
      console.log(
        `[EXTRACTION] spreadsheet:snapshot-ready duration_ms=${Date.now() - snapshotStart} range="${snapshot.sampledRangeA1}"`,
      );
      const llmStart = Date.now();
      const result = await extractFromSpreadsheetWithLlm({
        llmClient,
        model,
        dataExtractionGoal: goalWithMemory,
        snapshot,
      });
      console.log(`[EXTRACTION] spreadsheet:llm-ready duration_ms=${Date.now() - llmStart}`);
      return {
        mode: 'spreadsheet',
        scraped_data: result,
      };
    },
  };
}

export async function identifySpreadsheetItems(params: {
  stagehand: Stagehand;
  llmClient: OpenAI;
  model: string;
  description: string;
  knownItemKeys: Set<string>;
}): Promise<{ mode: 'spreadsheet'; items: ExtractionItem[] } | null> {
  const { stagehand, llmClient, model, description, knownItemKeys } = params;
  const page = stagehand.context.activePage() ?? stagehand.context.pages()[0];
  const activeUrl = page?.url?.() ?? '';

  if (!getSpreadsheetProvider(activeUrl)) return null;

  const snapshot = await captureSpreadsheetSnapshot(stagehand);
  const rawItems = await extractLoopItemsFromSpreadsheetWithLlm({
    llmClient,
    model,
    description,
    snapshot,
  });

  if (rawItems.length === 0) {
    console.warn(
      '[EXTRACTION] Spreadsheet loop discovery returned no items; continuing to session files, DOM, then vision.',
    );
    return null;
  }

  return {
    mode: 'spreadsheet',
    items: toExtractionItems(rawItems, knownItemKeys),
  };
}

function toExtractionItems(
  rawItems: Array<Record<string, unknown>>,
  knownItemKeys: Set<string>,
): ExtractionItem[] {
  const items: ExtractionItem[] = [];
  for (const item of rawItems) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const fingerprint = buildDeterministicItemKey(item);
    if (knownItemKeys.has(fingerprint)) continue;
    items.push({ fingerprint, data: item });
  }
  return items;
}

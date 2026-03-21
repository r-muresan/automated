import type { Stagehand } from '../../../stagehand/v3';
import { extractFromDom, extractLoopItemsFromDom } from '../dom';
import { normalizeLoopItems, validateAndFillExtractionResult } from '../schema';
import type { ParsedSchema } from '../schema';
import { buildDeterministicItemKey } from '../item-key';
import type { Extractor, ExtractOutput } from './types';
import { applyValidation } from './types';
import type { ExtractionItem } from '../vision';

export function createDomExtractor(params: {
  stagehand: Stagehand;
  goalWithMemory: string;
  schema?: ParsedSchema | null;
  skipValidation?: boolean;
}): Extractor {
  const { stagehand, goalWithMemory, schema, skipValidation } = params;

  return {
    name: 'dom',
    async tryExtract(): Promise<ExtractOutput> {
      const domStart = Date.now();
      const result = await extractFromDom({
        stagehand,
        dataExtractionGoal: goalWithMemory,
        schema,
      });
      console.log(`[EXTRACTION] dom:success duration_ms=${Date.now() - domStart}`);
      return {
        mode: 'dom',
        scraped_data: applyValidation(result, schema, skipValidation, validateAndFillExtractionResult),
      };
    },
  };
}

export async function identifyDomItems(params: {
  stagehand: Stagehand;
  description: string;
  knownItemKeys: Set<string>;
}): Promise<{ mode: 'dom'; items: ExtractionItem[] } | null> {
  const { stagehand, description, knownItemKeys } = params;

  const domLoopResult = await extractLoopItemsFromDom({ stagehand, description });
  const normalized = normalizeLoopItems(domLoopResult);
  const items = toExtractionItems(normalized.items, knownItemKeys);

  if (items.length === 0) return null;

  return { mode: 'dom', items };
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

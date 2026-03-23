import type { Stagehand } from '../../../stagehand/v3';
import { extractLoopItemsFromDom } from '../dom';
import { normalizeLoopItems } from '../schema';
import { buildDeterministicItemKey } from '../item-key';
import type { ExtractionItem } from '../vision';

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

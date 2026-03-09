import { buildDeterministicItemKey } from '../item-key';

export interface CollectedItem {
  fingerprint: string;
  data: Record<string, unknown>;
}

export interface ItemCollector {
  readonly name: string;
  collect(pageIndex: number): Promise<CollectedItem[]>;
}

export function deduplicateRawItems(rawItems: Array<Record<string, unknown>>): CollectedItem[] {
  const seen = new Set<string>();
  const items: CollectedItem[] = [];

  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const fingerprint = buildDeterministicItemKey(raw);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    items.push({ fingerprint, data: raw });
  }

  return items;
}

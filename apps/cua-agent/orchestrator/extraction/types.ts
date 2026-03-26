import { buildDeterministicItemKey } from './item-key';

export type ExtractionMode = 'spreadsheet' | 'files' | 'dom' | 'vision';

export type ExtractOutput = {
  scraped_data: unknown;
  mode: ExtractionMode;
};

export interface CollectedItem {
  fingerprint: string;
  data: Record<string, unknown>;
}

export interface ItemCollector {
  readonly name: string;
  collect(pageIndex: number): Promise<CollectedItem[]>;
}

export type LoopCollectionMode = 'spreadsheet' | 'files' | 'dom-selector' | 'vision';

export interface ResolvedCollector {
  mode: LoopCollectionMode;
  collector: ItemCollector;
  firstPage: CollectedItem[];
  targetItemCount: number | null;
}

/**
 * Unified extractor: supports both single-shot extraction and paginated collection.
 */
export interface UnifiedExtractor {
  readonly name: ExtractionMode;

  /** Single-shot: extract all data from current page state. Used by extract steps. */
  extract(): Promise<ExtractOutput | null>;

  /** Paginated: collect items for a given page index. Used by loop steps. */
  collect(pageIndex: number): Promise<CollectedItem[]>;

  /** If the model detected a specific target item count from the extraction goal. */
  targetItemCount: number | null;
}

/** Remove keys whose value is null or undefined. */
export function stripNullKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v != null) result[k] = v;
  }
  return result;
}

export function deduplicateRawItems(rawItems: Array<Record<string, unknown>>): CollectedItem[] {
  const seen = new Set<string>();
  const items: CollectedItem[] = [];

  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const cleaned = stripNullKeys(raw);
    const fingerprint = buildDeterministicItemKey(cleaned);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    items.push({ fingerprint, data: cleaned });
  }

  return items;
}

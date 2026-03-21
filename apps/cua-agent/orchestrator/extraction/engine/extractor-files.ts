import OpenAI from 'openai';
import type { DownloadedSessionFile } from '../../../types';
import { extractLoopItemsFromDownloadedFilesWithLlm } from '../files';
import { buildDeterministicItemKey } from '../item-key';
import type { ExtractionItem } from '../vision';

export async function identifyFileItems(params: {
  llmClient: OpenAI;
  model: string;
  description: string;
  downloadedFiles: DownloadedSessionFile[];
  knownItemKeys: Set<string>;
}): Promise<{ mode: 'files'; items: ExtractionItem[] } | null> {
  const { llmClient, model, description, downloadedFiles, knownItemKeys } = params;

  if (downloadedFiles.length === 0) return null;

  console.log(downloadedFiles);

  const rawItems = await extractLoopItemsFromDownloadedFilesWithLlm({
    llmClient,
    model,
    description,
    downloadedFiles,
  });

  const items = toExtractionItems(rawItems, knownItemKeys);
  if (items.length === 0) return null;

  return { mode: 'files', items };
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

import OpenAI from 'openai';
import type { CollectedItem } from './types';

/**
 * Post-processes extracted items to remove invalid entries:
 * - Items with empty or whitespace-only text
 * - Header/footer rows (detected via LLM)
 */
export async function cleanExtractedItems(params: {
  items: CollectedItem[];
  description: string;
  llmClient: OpenAI;
  model: string;
}): Promise<CollectedItem[]> {
  const { items, description, llmClient, model } = params;
  if (items.length === 0) return [];

  // Step 1: Remove items with empty text
  const nonEmpty = items.filter((item) => {
    const text = String(item.data.text ?? '').trim();
    return text.length > 0;
  });

  if (nonEmpty.length === 0) return [];
  if (nonEmpty.length <= 1) return nonEmpty;

  // Step 2: Use LLM to identify non-data rows (headers, footers, etc.)
  // Send a compact representation to save tokens
  const itemSummaries = nonEmpty.map((item, idx) => ({
    idx,
    text: String(item.data.text ?? '').slice(0, 200),
    hasHref: !!item.data.href,
  }));

  try {
    const response = await llmClient.chat.completions.create({
      model,
      messages: [
        {
          role: 'user',
          content:
            `You are filtering extracted web page items for a loop that iterates over: "${description}"\n\n` +
            `Below are the extracted items. Identify which items are NOT valid data items ` +
            `(e.g. header rows, footer rows, summary rows, empty/placeholder rows, or UI chrome). ` +
            `Return ONLY a JSON array of the idx values to REMOVE. If all items are valid, return [].\n\n` +
            `Items:\n${JSON.stringify(itemSummaries, null, 2)}\n\n` +
            `Return only the JSON array, no other text.`,
        },
      ],
      temperature: 0,
      max_tokens: 200,
    });

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) return nonEmpty;

    // Parse the array of indices to remove
    const match = content.match(/\[[\s\S]*?\]/);
    if (!match) return nonEmpty;

    const indicesToRemove: number[] = JSON.parse(match[0]);
    if (!Array.isArray(indicesToRemove) || indicesToRemove.length === 0) return nonEmpty;

    const removeSet = new Set(indicesToRemove);
    const cleaned = nonEmpty.filter((_, idx) => !removeSet.has(idx));

    const removed = nonEmpty.length - cleaned.length;
    if (removed > 0) {
      console.log(`[LOOP-CLEAN] Removed ${removed} non-data item(s) (headers/footers/empty)`);
    }

    return cleaned;
  } catch (error) {
    console.warn('[LOOP-CLEAN] LLM filtering failed, using heuristic-only results:', (error as Error).message);
    return nonEmpty;
  }
}

import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { buildZodObjectFromMap, type ParsedSchema } from './schema';
import { parseJsonFromText } from './common';

export interface ExtractionItem {
  fingerprint: string;
  data: Record<string, unknown>;
}

export interface PaginationCheck {
  hasMore: boolean;
  action: 'scroll_down' | 'click_next' | 'click_load_more' | 'none';
  selectorHint: string;
}

export async function identifyItemsFromVision(params: {
  llmClient: OpenAI;
  model: string;
  screenshotDataUrl: string;
  description: string;
  knownFingerprints: Set<string>;
}): Promise<ExtractionItem[]> {
  const { llmClient, model, screenshotDataUrl, description, knownFingerprints } = params;

  const itemsSchema = z.object({ items: z.array(z.record(z.string(), z.unknown())) });

  const prompt = `You are analyzing a screenshot of a web page to find a list of items.

Find ALL items matching this description: "${description}"

Return a JSON object with an "items" array where each element is an object with the extracted properties.`;

  const response = await llmClient.chat.completions.parse({
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: screenshotDataUrl, detail: 'high' } },
        ],
      },
    ],
    response_format: zodResponseFormat(itemsSchema, 'items_response'),
  });

  const parsed = response.choices[0]?.message?.parsed;

  if (!parsed) {
    console.warn('[EXTRACTION] Empty parsed vision response while identifying loop items');
    return [];
  }

  const items: ExtractionItem[] = [];
  for (const item of parsed.items) {
    if (!item || typeof item !== 'object') continue;
    const normalizedItem = item as Record<string, unknown>;
    const fingerprint = JSON.stringify(normalizedItem);
    if (knownFingerprints.has(fingerprint)) continue;
    items.push({ fingerprint, data: normalizedItem });
  }

  return items;
}

export async function extractFromVision(params: {
  llmClient: OpenAI;
  model: string;
  screenshotDataUrl: string;
  dataExtractionGoal: string;
  schema?: ParsedSchema | null;
}): Promise<unknown> {
  const { llmClient, model, screenshotDataUrl, dataExtractionGoal, schema } = params;

  const prompt = `You are extracting structured information from a webpage screenshot.

Extraction goal:
${dataExtractionGoal}

Return only JSON.`;

  if (schema) {
    const zodSchema = buildZodObjectFromMap(schema);
    const response = await llmClient.chat.completions.parse({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: screenshotDataUrl, detail: 'high' } },
          ],
        },
      ],
      response_format: zodResponseFormat(zodSchema, 'vision_extract_response'),
    });

    return response.choices[0]?.message?.parsed ?? {};
  }

  const response = await llmClient.chat.completions.create({
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: screenshotDataUrl, detail: 'high' } },
        ],
      },
    ],
  });

  let rawContent: string | null = response.choices[0]?.message?.content ?? null;

  if (Array.isArray(rawContent)) {
    rawContent = rawContent
      .map((part: any) => (typeof part === 'string' ? part : (part?.text ?? '')))
      .join('');
  }

  if (!rawContent || typeof rawContent !== 'string') {
    return {};
  }

  try {
    return parseJsonFromText(rawContent);
  } catch (error) {
    throw new Error(`Failed to parse vision extraction JSON: ${(error as Error).message}`);
  }
}

export async function checkForMoreItemsFromVision(params: {
  llmClient: OpenAI;
  model: string;
  screenshotDataUrl: string;
  description: string;
  totalProcessed: number;
}): Promise<PaginationCheck> {
  const { llmClient, model, screenshotDataUrl, description, totalProcessed } = params;

  const prompt = `You are analyzing a screenshot of a web page.

I am iterating through a list of: "${description}"
I have processed ${totalProcessed} items so far.

Determine if there are MORE items I haven't processed yet.

Look for:
1. A "Next" button, "Next Page", or numbered pagination (e.g. "2", "3", "›")
2. A "Load More", "Show More", or "View More" button
3. A scroll indicator showing content below the fold (scrollbar position, "↓ more results")
4. Lazy-loaded content that appears when scrolling down

Return ONLY a JSON object:
{
  "hasMore": boolean,
  "action": "scroll_down" | "click_next" | "click_load_more" | "none",
  "selectorHint": "brief description of the element to interact with, or empty string"
}

If hasMore is false, set action to "none" and selectorHint to "".`;

  const response = await llmClient.chat.completions.create({
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: screenshotDataUrl, detail: 'high' } },
        ],
      },
    ],
    max_tokens: 300,
  });

  const raw = response.choices[0]?.message?.content ?? '';
  try {
    const parsed = parseJsonFromText(typeof raw === 'string' ? raw : JSON.stringify(raw));
    const asRecord = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};

    const action =
      typeof asRecord.action === 'string' &&
      ['scroll_down', 'click_next', 'click_load_more', 'none'].includes(asRecord.action)
        ? (asRecord.action as PaginationCheck['action'])
        : 'none';

    return {
      hasMore: Boolean(asRecord.hasMore),
      action,
      selectorHint: typeof asRecord.selectorHint === 'string' ? asRecord.selectorHint : '',
    };
  } catch {
    console.warn('[EXTRACTION] Failed to parse vision pagination response:', String(raw).slice(0, 200));
    return { hasMore: false, action: 'none', selectorHint: '' };
  }
}

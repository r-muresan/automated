import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import type { Stagehand } from '../../stagehand/v3';
import { buildZodObjectFromMap, type ParsedSchema } from './schema';
import {
  buildStructuralDiscoveryScript,
  buildDomOutlineScript,
  buildElementExtractionScript,
  type CandidateSelector,
} from './dom-scripts';

interface ExtractedElement {
  textContent: string;
  innerText: string;
  tagName: string;
  id: string;
  href: string;
  outerHTML: string;
}

function stripCacheStatus<T extends Record<string, unknown>>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  if (!Object.prototype.hasOwnProperty.call(value, 'cacheStatus')) return value;

  const { cacheStatus: _cacheStatus, ...rest } = value;
  return rest as T;
}

function isTransientExtractionError(error: unknown): boolean {
  const message = String((error as Error)?.message ?? '').toLowerCase();
  return (
    message.includes('no object generated') ||
    message.includes('could not parse the response') ||
    message.includes('resource exhausted') ||
    message.includes('rate limit') ||
    message.includes('429') ||
    message.includes('json error injected into sse stream')
  );
}

async function withDomExtractionRetry<T>(
  operationName: string,
  operation: () => Promise<T>,
): Promise<T> {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const retryable = isTransientExtractionError(error) && attempt < maxAttempts;
      if (!retryable) {
        throw error;
      }

      const delayMs = 300 * Math.pow(2, attempt - 1);
      console.warn(
        `[EXTRACTION] ${operationName} transient failure; retrying (${attempt}/${maxAttempts}) in ${delayMs}ms: ${(error as Error).message}`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error(`[EXTRACTION] ${operationName} failed after retries`);
}

const extractionStrategySchema = z.object({
  strategy: z
    .enum(['selector', 'direct'])
    .describe(
      '"selector" to use a CSS selector to find elements (preferred), "direct" to return data immediately',
    ),
  selector: z
    .string()
    .nullable()
    .describe(
      'CSS selector matching elements that contain the target data (required when strategy is "selector")',
    ),
  data: z
    .union([z.record(z.string(), z.unknown()), z.string()])
    .nullable()
    .describe('Extracted data object (required when strategy is "direct")'),
});

/**
 * Selector-based DOM extraction: asks an LLM to either return a CSS selector
 * for elements containing the target data (preferred), or to return the data
 * directly from the DOM outline. Returns null if this approach fails.
 */
export async function extractFromDomWithSelector(params: {
  stagehand: Stagehand;
  llmClient: OpenAI;
  model: string;
  dataExtractionGoal: string;
  schema?: ParsedSchema | null;
}): Promise<unknown | null> {
  const { stagehand, llmClient, model, dataExtractionGoal, schema } = params;
  const page = stagehand.context.activePage() ?? stagehand.context.pages()[0];

  const [structuralCandidates, domOutline] = await Promise.all([
    page.evaluate<CandidateSelector[]>(buildStructuralDiscoveryScript()),
    page.evaluate<string>(buildDomOutlineScript()),
  ]);

  if (!domOutline || domOutline.trim().length < 20) {
    console.warn('[EXTRACTION] DOM outline too short for selector strategy');
    return null;
  }

  const truncatedOutline = domOutline.slice(0, 15_000);

  let candidatesSection = '';
  if (structuralCandidates.length > 0) {
    candidatesSection =
      '\nRepeating element patterns found on page:\n' +
      structuralCandidates
        .map(
          (c, i) =>
            `${i + 1}. "${c.selector}" (${c.count} items) — samples: ${c.sampleTexts.map((t) => `"${t}"`).join(', ')}`,
        )
        .join('\n') +
      '\n';
  }

  const schemaSection = schema
    ? `\nExpected output schema fields: ${Object.keys(schema).join(', ')}`
    : '';

  const prompt = `You are extracting data from a web page DOM.

Extraction goal: ${dataExtractionGoal}
${schemaSection}

DOM outline:
\`\`\`
${truncatedOutline}
\`\`\`
${candidatesSection}
Choose a strategy:
1. **selector** (preferred): Return a CSS selector that matches the element(s) containing the target data. Use this whenever the data lives inside identifiable DOM elements.
2. **direct**: Return the extracted data directly from the DOM outline above. Use this only when a selector doesn't make sense (e.g., the data is spread across unrelated parts of the page).

When using "selector", set the "selector" field and leave "data" as null.
When using "direct", set the "data" field and leave "selector" as null.`;

  const maxSelectorAttempts = 3;
  let elements: ExtractedElement[] = [];
  let chosenSelector: string | null = null;
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'user', content: prompt },
  ];

  for (let attempt = 1; attempt <= maxSelectorAttempts; attempt++) {
    const strategyResponse = await llmClient.chat.completions.parse({
      model,
      messages,
      response_format: zodResponseFormat(extractionStrategySchema, 'extraction_strategy'),
    });

    const parsed = strategyResponse.choices[0]?.message?.parsed;
    if (!parsed) return null;

    if (parsed.strategy === 'direct') {
      console.log('[EXTRACTION] DOM selector strategy: model chose direct extraction');
      // Normalize: if the LLM returned a string instead of an object, wrap it
      console.log(parsed.data);

      if (typeof parsed.data === 'string') {
        return { extraction: parsed.data };
      }
      return parsed.data;
    }

    if (!parsed.selector) {
      console.warn('[EXTRACTION] DOM selector strategy: model chose selector but returned none');
      return null;
    }

    elements = await page.evaluate<ExtractedElement[]>(
      buildElementExtractionScript(parsed.selector),
    );

    if (elements.length > 0) {
      chosenSelector = parsed.selector;
      console.log(
        `[EXTRACTION] DOM selector strategy: "${parsed.selector}" matched ${elements.length} element(s) (attempt ${attempt}/${maxSelectorAttempts})`,
      );
      break;
    }

    console.warn(
      `[EXTRACTION] Selector "${parsed.selector}" matched 0 elements (attempt ${attempt}/${maxSelectorAttempts})`,
    );

    if (attempt < maxSelectorAttempts) {
      // Feed the failed attempt back so the LLM tries a different selector
      messages.push({
        role: 'assistant',
        content: JSON.stringify(parsed),
      });
      messages.push({
        role: 'user',
        content: `The selector "${parsed.selector}" matched 0 elements on the page. Please try a different, broader CSS selector. Consider using partial attribute selectors, ancestor selectors, or different class/tag combinations.`,
      });
    }
  }

  if (!chosenSelector || elements.length === 0) {
    console.warn('[EXTRACTION] DOM selector strategy: all selector attempts matched 0 elements');
    return null;
  }

  // Map element data to schema using a second LLM call
  const elementsSummary = elements
    .map((el, i) => `Element ${i + 1} (${el.tagName}): ${el.innerText || el.textContent}`)
    .join('\n');

  const mappingPrompt = `Extract structured data from these DOM elements.

Extraction goal: ${dataExtractionGoal}
${schemaSection}

Elements found via selector "${chosenSelector}":
${elementsSummary}

Return the extracted data as a JSON object matching the schema.`;

  if (schema) {
    const zodSchema = buildZodObjectFromMap(schema);
    const mappingResponse = await llmClient.chat.completions.parse({
      model,
      messages: [{ role: 'user', content: mappingPrompt }],
      response_format: zodResponseFormat(zodSchema, 'extracted_data'),
    });
    return mappingResponse.choices[0]?.message?.parsed ?? null;
  }

  // No schema: return element data in a structured format
  if (elements.length === 1) {
    return { extraction: elements[0].innerText || elements[0].textContent };
  }
  return {
    items: elements.map((el) => ({
      text: el.innerText || el.textContent,
      ...(el.href ? { href: el.href } : {}),
      ...(el.id ? { id: el.id } : {}),
    })),
  };
}

export async function extractFromDom(params: {
  stagehand: Stagehand;
  dataExtractionGoal: string;
  schema?: ParsedSchema | null;
}): Promise<unknown> {
  const { stagehand, dataExtractionGoal, schema } = params;
  const page = stagehand.context.activePage() ?? stagehand.context.pages()[0];

  const zodSchema = schema
    ? buildZodObjectFromMap(schema)
    : z.object({ extraction: z.unknown().nullable() });

  const result = await withDomExtractionRetry('DOM extract', async () =>
    stagehand.extract(dataExtractionGoal, zodSchema, { page }),
  );

  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return result;
  }

  return stripCacheStatus(result as Record<string, unknown>);
}

export async function extractLoopItemsFromDom(params: {
  stagehand: Stagehand;
  description: string;
}): Promise<unknown> {
  const { stagehand, description } = params;
  const page = stagehand.context.activePage() ?? stagehand.context.pages()[0];
  const itemsSchema = z.object({
    items: z.array(
      z
        .object({
          text: z.string().trim().min(1),
        })
        .passthrough(),
    ),
  });

  const instruction =
    `Find all currently visible items that match this description: "${description}". ` +
    'Return a JSON object with an "items" array. ' +
    'Each item must be a flat object with a required non-empty "text" field that contains the most recognizable visible identifier for that item. ' +
    'Include selector/id/href/url fields whenever available so items can be de-duplicated deterministically. ' +
    'You may include any additional useful fields when available.';

  const result = await withDomExtractionRetry('DOM loop-item extraction', async () =>
    stagehand.extract(instruction, itemsSchema, { page }),
  );

  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return result;
  }

  return stripCacheStatus(result as Record<string, unknown>);
}

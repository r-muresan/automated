import OpenAI from 'openai';
import { z } from 'zod';
import { zodResponseFormat } from 'openai/helpers/zod';
interface EvaluatablePage {
  evaluate<T>(script: string | ((...args: unknown[]) => T), ...args: unknown[]): Promise<T>;
}
import { buildElementExtractionScript } from '../dom-scripts';
import type { ExtractedElement } from './shared';
import { extractionStrategySchema } from './shared';
import { handleDirectExtraction } from './extract-direct';

/**
 * Selector-based DOM extraction: asks an LLM to either return a CSS selector
 * for elements containing the target data (preferred), or to return the data
 * directly from the DOM outline.
 */
export async function extractWithSelector(params: {
  page: EvaluatablePage;
  llmClient: OpenAI;
  model: string;
  dataExtractionGoal: string;
  truncatedOutline: string;
  candidatesSection: string;
}): Promise<unknown | null> {
  const {
    page,
    llmClient,
    model,
    dataExtractionGoal,
    truncatedOutline,
    candidatesSection,
  } = params;

  console.log(candidatesSection);

  const prompt = `You are extracting data from a web page DOM.

Extraction goal: ${dataExtractionGoal}

DOM outline:
\`\`\`
${truncatedOutline}
\`\`\`
${candidatesSection}
Choose a strategy:
1. **selector** (STRONGLY preferred): You MUST use one of the candidate selectors listed above under "Repeating element patterns found on page". The DOM outline is compressed and simplified, so selectors you invent yourself will almost certainly not match any real elements. Pick the candidate selector that best matches the target data.
2. **direct**: Return the extracted data directly from the DOM outline above. Use this ONLY when no candidate selector is relevant (e.g., the data is spread across unrelated parts of the page) or when no candidates are listed.

When using "selector", set the "selector" field to one of the candidate selectors above and leave "data" as null.
When using "direct", set the "data" field and leave "selector" as null.`;

  const strategyResponse = await llmClient.chat.completions.parse({
    model,
    messages: [{ role: 'user', content: prompt }],
    response_format: zodResponseFormat(extractionStrategySchema, 'extraction_strategy'),
  });

  const parsed = strategyResponse.choices[0]?.message?.parsed;
  if (!parsed) return null;

  console.log(parsed);

  if (parsed.strategy === 'direct') {
    return handleDirectExtraction(parsed);
  }

  if (!parsed.selector) {
    console.warn('[EXTRACTION] DOM selector strategy: model chose selector but returned none');
    return null;
  }

  const elements = await page.evaluate<ExtractedElement[]>(
    buildElementExtractionScript(parsed.selector),
  );

  console.log(elements);

  if (elements.length === 0) {
    console.warn(`[EXTRACTION] Selector "${parsed.selector}" matched 0 elements`);
    return null;
  }

  const chosenSelector = parsed.selector;
  console.log(
    `[EXTRACTION] DOM selector strategy: "${parsed.selector}" matched ${elements.length} element(s)`,
  );

  return mapElements({
    elements,
    chosenSelector,
    llmClient,
    model,
    dataExtractionGoal,
  });
}

async function mapElements(params: {
  elements: ExtractedElement[];
  chosenSelector: string;
  llmClient: OpenAI;
  model: string;
  dataExtractionGoal: string;
}): Promise<unknown | null> {
  const { elements, chosenSelector, llmClient, model, dataExtractionGoal } = params;

  // Single element: return simple structure
  if (elements.length === 1) {
    return { extraction: elements[0].innerText || elements[0].textContent };
  }

  // Multiple elements: let the LLM decide the schema per item
  const itemSchema = z.object({}).passthrough();
  const arraySchema = z.object({ items: z.array(z.record(z.string(), z.unknown())) });

  const BATCH_SIZE = 30;
  const allItems: unknown[] = [];

  for (let i = 0; i < elements.length; i += BATCH_SIZE) {
    const batch = elements.slice(i, i + BATCH_SIZE);
    const elementsSummary = batch
      .map((el, j) => `Element ${i + j + 1} (${el.tagName}): ${el.innerText || el.textContent}`)
      .join('\n');

    const mappingPrompt = `Extract structured data from these DOM elements. Each element represents one item — return one object per element.

Extraction goal: ${dataExtractionGoal}

Elements found via selector "${chosenSelector}":
${elementsSummary}

Return a JSON object with an "items" array, where each entry is one extracted item. Choose appropriate field names based on the data (e.g. "name", "description", "url", etc.). There should be exactly ${batch.length} items in the array, one per element.`;

    const mappingResponse = await llmClient.chat.completions.parse({
      model,
      messages: [{ role: 'user', content: mappingPrompt }],
      response_format: zodResponseFormat(arraySchema, 'extracted_data'),
    });

    const parsed = mappingResponse.choices[0]?.message?.parsed;
    if (parsed?.items) {
      allItems.push(...parsed.items);
    }
  }

  return { items: allItems };
}

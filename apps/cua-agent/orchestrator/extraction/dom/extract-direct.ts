import type { z } from 'zod';
import type { extractionStrategySchema } from './shared';

type ExtractionStrategy = z.infer<typeof extractionStrategySchema>;

/**
 * Handle the "direct" extraction strategy where the LLM returns
 * data directly from the DOM outline without using a CSS selector.
 */
export function handleDirectExtraction(parsed: ExtractionStrategy): unknown {
  console.log('[EXTRACTION] DOM selector strategy: model chose direct extraction');
  console.log(parsed.data);

  if (typeof parsed.data === 'string') {
    return { extraction: parsed.data };
  }
  return parsed.data;
}

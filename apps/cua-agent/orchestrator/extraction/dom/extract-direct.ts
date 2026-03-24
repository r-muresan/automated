import type { z } from 'zod';
import type { coordinateExtractionSchema } from './shared';

type CoordinateExtraction = z.infer<typeof coordinateExtractionSchema>;

/**
 * Handle the "direct" extraction strategy where the LLM returns
 * data directly from the screenshot without using coordinates.
 */
export function handleDirectExtraction(parsed: CoordinateExtraction): unknown {
  console.log('[EXTRACTION] DOM strategy: model chose direct extraction');
  console.log(parsed.data);

  if (typeof parsed.data === 'string') {
    return { extraction: parsed.data };
  }
  return parsed.data;
}

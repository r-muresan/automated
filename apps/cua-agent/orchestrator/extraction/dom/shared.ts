import { z } from 'zod';

export interface ExtractedElement {
  textContent: string;
  innerText: string;
  tagName: string;
  id: string;
  href: string;
  outerHTML: string;
}

export const extractionStrategySchema = z.object({
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
  targetItemCount: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe(
      'If the extraction goal specifies a specific number of items (e.g. "first 6 stocks", "top 10 results"), return that number here. Null if no specific count is mentioned.',
    ),
});

export const coordinateExtractionSchema = z.object({
  strategy: z
    .enum(['coordinate', 'direct'])
    .describe(
      '"coordinate" to point at example elements on the page (preferred for repeating items), "direct" to return extracted data immediately',
    ),
  data: z
    .union([z.record(z.string(), z.unknown()), z.string()])
    .nullable()
    .describe('Extracted data object (required when strategy is "direct", null when "coordinate")'),
  targetItemCount: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe(
      'If the extraction goal specifies a specific number of items (e.g. "first 6 stocks", "top 10 results"), return that number here. Null if no specific count is mentioned.',
    ),
});


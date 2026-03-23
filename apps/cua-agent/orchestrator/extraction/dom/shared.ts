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
});

export function stripCacheStatus<T extends Record<string, unknown>>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  if (!Object.prototype.hasOwnProperty.call(value, 'cacheStatus')) return value;

  const { cacheStatus: _cacheStatus, ...rest } = value;
  return rest as T;
}

export function isTransientExtractionError(error: unknown): boolean {
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

export async function withDomExtractionRetry<T>(
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

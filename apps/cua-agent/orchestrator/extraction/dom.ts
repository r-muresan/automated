import { z } from 'zod';
import type { Stagehand } from '../../stagehand/v3';
import { buildZodObjectFromMap, type ParsedSchema } from './schema';

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
    items: z.array(z.record(z.string(), z.unknown())),
  });

  const instruction =
    `Find all currently visible items that match this description: "${description}". ` +
    'Return a JSON object with an "items" array. Each item should be a flat object with fields that uniquely describe the item.';

  const result = await withDomExtractionRetry('DOM loop-item extraction', async () =>
    stagehand.extract(instruction, itemsSchema, { page }),
  );

  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return result;
  }

  return stripCacheStatus(result as Record<string, unknown>);
}

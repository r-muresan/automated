import { z } from 'zod';
import type { Stagehand } from '../../../stagehand/v3';
import { stripCacheStatus, withDomExtractionRetry } from './shared';

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

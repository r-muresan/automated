import OpenAI from 'openai';
import type { Stagehand } from '../../../stagehand/v3';
import { capturePageScreenshot } from '../common';
import { identifyItemsFromVision } from '../vision';
import { scrollPageDown, tryClickPaginationButton } from './page-scroll';
import type { CollectedItem, ItemCollector } from './types';

export function createVisionCollector(params: {
  stagehand: Stagehand;
  llmClient: OpenAI;
  model: string;
  description: string;
}): ItemCollector {
  const { stagehand, llmClient, model, description } = params;

  const knownKeys = new Set<string>();
  let exhausted = false;

  async function identifyNewItems(): Promise<CollectedItem[]> {
    const screenshotDataUrl = await capturePageScreenshot(stagehand);
    const items = await identifyItemsFromVision({
      llmClient,
      model,
      screenshotDataUrl,
      description,
      knownItemKeys: knownKeys,
    });

    for (const item of items) {
      knownKeys.add(item.fingerprint);
    }
    return items;
  }

  return {
    name: 'vision',
    async collect(pageIndex: number): Promise<CollectedItem[]> {
      if (exhausted) return [];

      // First page: just identify what's visible
      if (pageIndex === 0) {
        const items = await identifyNewItems();
        console.log(`[LOOP-COLLECT] Vision page 0: ${items.length} items`);
        return items;
      }

      // Subsequent pages: try scrolling first
      const page = stagehand.context.activePage() ?? stagehand.context.pages()[0];
      const scrolled = await scrollPageDown(page);

      if (scrolled) {
        const items = await identifyNewItems();
        if (items.length > 0) {
          console.log(
            `[LOOP-COLLECT] Vision page ${pageIndex}: ${items.length} items after scroll`,
          );
          return items;
        }
      }

      // Scroll didn't help — try pagination button via accessibility tree
      const clicked = await tryClickPaginationButton(stagehand);
      if (clicked) {
        const items = await identifyNewItems();
        if (items.length > 0) {
          console.log(
            `[LOOP-COLLECT] Vision page ${pageIndex}: ${items.length} items after pagination click`,
          );
          return items;
        }
      }

      exhausted = true;
      console.log(`[LOOP-COLLECT] Vision page ${pageIndex}: exhausted`);
      return [];
    },
  };
}

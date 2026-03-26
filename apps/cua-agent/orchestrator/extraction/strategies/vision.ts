import OpenAI from 'openai';
import type { Stagehand } from '../../../stagehand/v3';
import { capturePageScreenshot } from '../common';
import { extractFromVision, identifyItemsFromVision } from '../vision';
import { scrollPageDown, tryClickPaginationButton } from '../pagination';
import type { UnifiedExtractor, ExtractOutput, CollectedItem } from '../types';

export function createVisionStrategy(params: {
  stagehand: Stagehand;
  llmClient: OpenAI;
  model: string;
  dataExtractionGoal: string;
}): UnifiedExtractor {
  const { stagehand, llmClient, model, dataExtractionGoal } = params;

  const knownKeys = new Set<string>();
  let exhausted = false;

  async function identifyNewItems(): Promise<CollectedItem[]> {
    const screenshotDataUrl = await capturePageScreenshot(stagehand);
    const items = await identifyItemsFromVision({
      llmClient,
      model,
      screenshotDataUrl,
      description: dataExtractionGoal,
      knownItemKeys: knownKeys,
    });

    for (const item of items) {
      knownKeys.add(item.fingerprint);
    }
    return items;
  }

  return {
    name: 'vision',
    targetItemCount: null,

    async extract(): Promise<ExtractOutput> {
      const screenshotStart = Date.now();
      const screenshotDataUrl = await capturePageScreenshot(stagehand, { fullPage: true });
      console.log(
        `[EXTRACTION] vision:screenshot-ready duration_ms=${Date.now() - screenshotStart} chars=${screenshotDataUrl.length}`,
      );
      const visionStart = Date.now();
      const result = await extractFromVision({
        llmClient,
        model,
        screenshotDataUrl,
        dataExtractionGoal,
      });
      console.log(`[EXTRACTION] vision:llm-ready duration_ms=${Date.now() - visionStart}`);
      return {
        mode: 'vision',
        scraped_data: result,
      };
    },

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

import OpenAI from 'openai';
import type { Stagehand } from '../../../stagehand/v3';
import { capturePageScreenshot } from '../common';
import {
  extractFromVision,
  identifyItemsFromVision,
  type ExtractionItem,
} from '../vision';
import type { Extractor, ExtractOutput } from './types';

export function createVisionExtractor(params: {
  stagehand: Stagehand;
  llmClient: OpenAI;
  model: string;
  goalWithMemory: string;
}): Extractor {
  const { stagehand, llmClient, model, goalWithMemory } = params;

  return {
    name: 'vision',
    async tryExtract(): Promise<ExtractOutput> {
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
        dataExtractionGoal: goalWithMemory,
      });
      console.log(`[EXTRACTION] vision:llm-ready duration_ms=${Date.now() - visionStart}`);
      return {
        mode: 'vision',
        scraped_data: result,
      };
    },
  };
}

export async function identifyVisionItems(params: {
  stagehand: Stagehand;
  llmClient: OpenAI;
  model: string;
  description: string;
  knownItemKeys: Set<string>;
}): Promise<{ mode: 'vision'; items: ExtractionItem[] }> {
  const { stagehand, llmClient, model, description, knownItemKeys } = params;

  const screenshotDataUrl = await capturePageScreenshot(stagehand);
  const items = await identifyItemsFromVision({
    llmClient,
    model,
    screenshotDataUrl,
    description,
    knownItemKeys,
  });

  return { mode: 'vision', items };
}

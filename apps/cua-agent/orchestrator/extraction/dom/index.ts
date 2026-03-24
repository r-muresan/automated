import OpenAI from 'openai';
import type { Stagehand } from '../../../stagehand/v3';
import { capturePageScreenshot } from '../common';
import { extractWithCoordinates, type SelectorExtractionResult } from './extract-selector';

export type { SelectorExtractionResult } from './extract-selector';
export { extractWithKnownSelector, structureElements } from './extract-selector';

/**
 * DOM extraction: captures a screenshot, decides strategy, then runs a
 * coordinate-finding agent (kimi k2.5) to identify repeating elements.
 * Returns null if this approach fails.
 */
export async function extractDom(params: {
  stagehand: Stagehand;
  llmClient: OpenAI;
  model: string;
  agentModel: string;
  dataExtractionGoal: string;
}): Promise<SelectorExtractionResult | null> {
  const { stagehand, llmClient, model, agentModel, dataExtractionGoal } = params;

  const screenshotDataUrl = await capturePageScreenshot(stagehand);

  return extractWithCoordinates({
    stagehand,
    llmClient,
    model,
    agentModel,
    dataExtractionGoal,
    screenshotDataUrl,
  });
}

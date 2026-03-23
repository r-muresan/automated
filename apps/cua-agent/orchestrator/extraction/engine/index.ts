import OpenAI from 'openai';
import type { Stagehand } from '../../../stagehand/v3';
import type { LoopContext } from '../../../types';
import { getSpreadsheetProvider } from '../../agent-tools';
import { capturePageScreenshot } from '../common';
import type { Extractor, ExtractOutput, ExtractionMode } from './types';
import type { PaginationCheck, ExtractionItem } from '../vision';
import { checkForMoreItemsFromVision } from '../vision';
import { createSpreadsheetExtractor, identifySpreadsheetItems } from './extractor-spreadsheet';
import { createDomExtractor } from './extractor-dom-selector';
import { identifyDomItems } from './extractor-dom';
import { identifyFileItems } from './extractor-files';
import { createVisionExtractor, identifyVisionItems } from './extractor-vision';

export type { ExtractOutput, ExtractionMode } from './types';
export type { PaginationCheck, ExtractionItem } from '../vision';

export async function extractWithSharedStrategy(params: {
  stagehand: Stagehand;
  llmClient: OpenAI;
  model: string;
  dataExtractionGoal: string;
  context?: LoopContext;
  globalState?: any[];
}): Promise<ExtractOutput> {
  const {
    stagehand,
    llmClient,
    model,
    dataExtractionGoal,
    context,
    globalState,
  } = params;

  const page = stagehand.context.activePage() ?? stagehand.context.pages()[0];
  const activeUrl = page?.url?.() ?? '';
  const spreadsheetProvider = getSpreadsheetProvider(activeUrl);
  const start = Date.now();
  console.log(
    `[EXTRACTION] extractWithSharedStrategy:start provider=${spreadsheetProvider ?? 'none'} url="${activeUrl}"`,
  );

  const contextualGoal =
    context && context.item != null
      ? `For this specific item: ${JSON.stringify(context.item)}\nInstruction: ${dataExtractionGoal}`
      : dataExtractionGoal;
  const goalWithMemory =
    globalState && globalState.length > 0
      ? `${contextualGoal}\n\nPreviously collected data:\n${JSON.stringify(globalState, null, 2)}`
      : contextualGoal;

  const shared = { stagehand, llmClient, model, goalWithMemory };

  // Build ordered list of extractors, each in its own file
  const extractors: (Extractor | null)[] = [
    createSpreadsheetExtractor(shared),
    createDomExtractor(shared),
    createVisionExtractor(shared),
  ];

  // Try extractors in priority order
  for (const extractor of extractors) {
    if (!extractor) continue;
    try {
      console.log(`[EXTRACTION] Trying extractor: ${extractor.name}`);
      const result = await extractor.tryExtract();
      if (result) {
        console.log(
          `[EXTRACTION] extractWithSharedStrategy:end mode=${result.mode} extractor=${extractor.name} total_ms=${Date.now() - start}`,
        );
        return result;
      }
      console.log(`[EXTRACTION] ${extractor.name}: no result, trying next`);
    } catch (error) {
      console.warn(
        `[EXTRACTION] ${extractor.name} failed after ${Date.now() - start}ms; trying next:`,
        (error as Error).message,
      );
    }
  }

  throw new Error('All extraction strategies failed');
}

export { checkForMoreItemsFromVision, capturePageScreenshot };

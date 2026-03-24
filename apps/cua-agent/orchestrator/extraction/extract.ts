import OpenAI from 'openai';
import type { Stagehand } from '../../stagehand/v3';
import type { LoopContext } from '../../types';
import { getSpreadsheetProvider } from '../agent-tools';
import type { ExtractOutput, UnifiedExtractor } from './types';
import { createSpreadsheetStrategy } from './strategies/spreadsheet';
import { createDomStrategy } from './strategies/dom';
import { createVisionStrategy } from './strategies/vision';

export async function extractWithSharedStrategy(params: {
  stagehand: Stagehand;
  llmClient: OpenAI;
  model: string;
  agentModel: string;
  dataExtractionGoal: string;
  context?: LoopContext;
  globalState?: any[];
}): Promise<ExtractOutput> {
  const { stagehand, llmClient, model, agentModel, dataExtractionGoal, context, globalState } = params;

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

  const shared = { stagehand, llmClient, model, agentModel, dataExtractionGoal: goalWithMemory };

  // Build ordered list of strategies
  const strategies: (UnifiedExtractor | null)[] = [
    createSpreadsheetStrategy(shared),
    createDomStrategy(shared),
    createVisionStrategy(shared),
  ];

  // Try strategies in priority order
  for (const strategy of strategies) {
    if (!strategy) continue;
    try {
      console.log(`[EXTRACTION] Trying extractor: ${strategy.name}`);
      const result = await strategy.extract();
      if (result) {
        console.log(
          `[EXTRACTION] extractWithSharedStrategy:end mode=${result.mode} extractor=${strategy.name} total_ms=${Date.now() - start}`,
        );
        return result;
      }
      console.log(`[EXTRACTION] ${strategy.name}: no result, trying next`);
    } catch (error) {
      console.warn(
        `[EXTRACTION] ${strategy.name} failed after ${Date.now() - start}ms; trying next:`,
        (error as Error).message,
      );
    }
  }

  throw new Error('All extraction strategies failed');
}

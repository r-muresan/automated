import OpenAI from 'openai';
import type { Stagehand } from '../../../stagehand/v3';
import { extractDom } from '../dom';
import type { Extractor, ExtractOutput } from './types';

export function createDomExtractor(params: {
  stagehand: Stagehand;
  llmClient: OpenAI;
  model: string;
  goalWithMemory: string;
}): Extractor {
  const { stagehand, llmClient, model, goalWithMemory } = params;

  return {
    name: 'dom-selector',
    async tryExtract(): Promise<ExtractOutput | null> {
      const domSelectorStart = Date.now();
      const result = await extractDom({
        stagehand,
        llmClient,
        model,
        dataExtractionGoal: goalWithMemory,
      });
      if (result == null) return null;
      console.log(
        `[EXTRACTION] dom-selector:success duration_ms=${Date.now() - domSelectorStart}`,
      );
      return {
        mode: 'dom',
        scraped_data: result,
      };
    },
  };
}

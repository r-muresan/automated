import OpenAI from 'openai';
import type { Stagehand } from '../../../stagehand/v3';
import { extractFromDomWithSelector } from '../dom';
import type { ParsedSchema } from '../schema';
import { validateAndFillExtractionResult } from '../schema';
import type { Extractor, ExtractOutput } from './types';
import { applyValidation } from './types';

export function createDomSelectorExtractor(params: {
  stagehand: Stagehand;
  llmClient: OpenAI;
  model: string;
  goalWithMemory: string;
  schema?: ParsedSchema | null;
  skipValidation?: boolean;
}): Extractor {
  const { stagehand, llmClient, model, goalWithMemory, schema, skipValidation } = params;

  return {
    name: 'dom-selector',
    async tryExtract(): Promise<ExtractOutput | null> {
      const domSelectorStart = Date.now();
      const result = await extractFromDomWithSelector({
        stagehand,
        llmClient,
        model,
        dataExtractionGoal: goalWithMemory,
        schema,
      });
      if (result == null) return null;
      console.log(
        `[EXTRACTION] dom-selector:success duration_ms=${Date.now() - domSelectorStart}`,
      );
      return {
        mode: 'dom',
        scraped_data: applyValidation(result, schema, skipValidation, validateAndFillExtractionResult),
      };
    },
  };
}

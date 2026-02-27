import OpenAI from 'openai';
import type { Stagehand } from '../../stagehand/v3';
import type { LoopContext } from '../../types';
import { getSpreadsheetProvider } from '../agent-tools';
import { capturePageScreenshot } from './common';
import { extractFromDom, extractLoopItemsFromDom } from './dom';
import {
  captureSpreadsheetSnapshot,
  extractFromSpreadsheetWithLlm,
  extractLoopItemsFromSpreadsheetWithLlm,
} from './spreadsheet';
import {
  checkForMoreItemsFromVision,
  extractFromVision,
  identifyItemsFromVision,
  type PaginationCheck,
  type ExtractionItem,
} from './vision';
import { normalizeLoopItems, validateAndFillExtractionResult, type ParsedSchema } from './schema';

export type ExtractionMode = 'spreadsheet' | 'dom' | 'vision';

export type ExtractOutput = {
  scraped_data: unknown;
  mode: ExtractionMode;
};

function toExtractionItems(
  rawItems: Array<Record<string, unknown>>,
  knownFingerprints: Set<string>,
): ExtractionItem[] {
  const items: ExtractionItem[] = [];

  for (const item of rawItems) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const fingerprint = JSON.stringify(item);
    if (knownFingerprints.has(fingerprint)) continue;
    items.push({ fingerprint, data: item });
  }

  return items;
}

export async function extractWithSharedStrategy(params: {
  stagehand: Stagehand;
  llmClient: OpenAI;
  model: string;
  dataExtractionGoal: string;
  schema?: ParsedSchema | null;
  skipValidation?: boolean;
  context?: LoopContext;
  extractedVariables?: Record<string, string>;
}): Promise<ExtractOutput> {
  const {
    stagehand,
    llmClient,
    model,
    dataExtractionGoal,
    schema,
    skipValidation,
    context,
    extractedVariables,
  } = params;

  const page = stagehand.context.activePage() ?? stagehand.context.pages()[0];
  const activeUrl = page?.url?.() ?? '';
  const spreadsheetProvider = getSpreadsheetProvider(activeUrl);
  const start = Date.now();
  console.log(
    `[EXTRACTION] extractWithSharedStrategy:start provider=${spreadsheetProvider ?? 'none'} schema=${schema ? 'yes' : 'no'} url="${activeUrl}"`,
  );

  const contextualGoal =
    context && context.item != null
      ? `Context item: ${JSON.stringify(context.item)}\nInstruction: ${dataExtractionGoal}`
      : dataExtractionGoal;
  const goalWithMemory =
    extractedVariables && Object.keys(extractedVariables).length > 0
      ? `${contextualGoal}\n\nPreviously extracted variables:\n${JSON.stringify(extractedVariables, null, 2)}`
      : contextualGoal;

  if (spreadsheetProvider) {
    const snapshotStart = Date.now();
    const snapshot = await captureSpreadsheetSnapshot(stagehand);
    console.log(
      `[EXTRACTION] spreadsheet:snapshot-ready duration_ms=${Date.now() - snapshotStart} range="${snapshot.sampledRangeA1}"`,
    );
    const llmStart = Date.now();
    const spreadsheetResult = await extractFromSpreadsheetWithLlm({
      llmClient,
      model,
      dataExtractionGoal: goalWithMemory,
      schema,
      snapshot,
    });
    console.log(`[EXTRACTION] spreadsheet:llm-ready duration_ms=${Date.now() - llmStart}`);
    console.log(`[EXTRACTION] extractWithSharedStrategy:end mode=spreadsheet total_ms=${Date.now() - start}`);

    return {
      mode: 'spreadsheet',
      scraped_data:
        schema && !skipValidation
          ? validateAndFillExtractionResult(spreadsheetResult, schema)
          : spreadsheetResult,
    };
  }

  try {
    const domStart = Date.now();
    const domResult = await extractFromDom({
      stagehand,
      dataExtractionGoal: goalWithMemory,
      schema,
    });
    console.log(`[EXTRACTION] dom:success duration_ms=${Date.now() - domStart}`);
    console.log(`[EXTRACTION] extractWithSharedStrategy:end mode=dom total_ms=${Date.now() - start}`);

    return {
      mode: 'dom',
      scraped_data:
        schema && !skipValidation ? validateAndFillExtractionResult(domResult, schema) : domResult,
    };
  } catch (error) {
    console.warn(
      `[EXTRACTION] DOM extraction failed after ${Date.now() - start}ms; falling back to vision:`,
      (error as Error).message,
    );
  }

  const screenshotStart = Date.now();
  const screenshotDataUrl = await capturePageScreenshot(stagehand, { fullPage: true });
  console.log(
    `[EXTRACTION] vision:screenshot-ready duration_ms=${Date.now() - screenshotStart} chars=${screenshotDataUrl.length}`,
  );
  const visionStart = Date.now();
  const visionResult = await extractFromVision({
    llmClient,
    model,
    screenshotDataUrl,
    dataExtractionGoal: goalWithMemory,
    schema,
  });
  console.log(`[EXTRACTION] vision:llm-ready duration_ms=${Date.now() - visionStart}`);
  console.log(`[EXTRACTION] extractWithSharedStrategy:end mode=vision total_ms=${Date.now() - start}`);

  return {
    mode: 'vision',
    scraped_data:
      schema && !skipValidation
        ? validateAndFillExtractionResult(visionResult, schema)
        : visionResult,
  };
}

export async function identifyItemsWithSharedStrategy(params: {
  stagehand: Stagehand;
  llmClient: OpenAI;
  model: string;
  description: string;
  knownFingerprints: Set<string>;
}): Promise<{ mode: ExtractionMode; items: ExtractionItem[] }> {
  const { stagehand, llmClient, model, description, knownFingerprints } = params;

  const page = stagehand.context.activePage() ?? stagehand.context.pages()[0];
  const activeUrl = page?.url?.() ?? '';
  const spreadsheetProvider = getSpreadsheetProvider(activeUrl);

  if (spreadsheetProvider) {
    const snapshot = await captureSpreadsheetSnapshot(stagehand);

    console.log({ snapshot });

    const spreadsheetRawItems = await extractLoopItemsFromSpreadsheetWithLlm({
      llmClient,
      model,
      description,
      snapshot,
    });

    if (spreadsheetRawItems.length > 0) {
      return {
        mode: 'spreadsheet',
        items: toExtractionItems(spreadsheetRawItems, knownFingerprints),
      };
    }

    console.warn(
      '[EXTRACTION] Spreadsheet loop discovery returned no items; falling back to vision.',
    );
    const screenshotDataUrl = await capturePageScreenshot(stagehand);
    const visionItems = await identifyItemsFromVision({
      llmClient,
      model,
      screenshotDataUrl,
      description,
      knownFingerprints,
    });

    return {
      mode: 'vision',
      items: visionItems,
    };
  }

  try {
    const domLoopResult = await extractLoopItemsFromDom({ stagehand, description });
    const normalized = normalizeLoopItems(domLoopResult);
    const domItems = toExtractionItems(normalized.items, knownFingerprints);
    if (domItems.length > 0) {
      return {
        mode: 'dom',
        items: domItems,
      };
    }
  } catch (error) {
    console.warn(
      '[EXTRACTION] DOM loop discovery failed; falling back to vision:',
      (error as Error).message,
    );
  }

  const screenshotDataUrl = await capturePageScreenshot(stagehand);
  const visionItems = await identifyItemsFromVision({
    llmClient,
    model,
    screenshotDataUrl,
    description,
    knownFingerprints,
  });

  return {
    mode: 'vision',
    items: visionItems,
  };
}

export { checkForMoreItemsFromVision, capturePageScreenshot };
export type { PaginationCheck, ExtractionItem };

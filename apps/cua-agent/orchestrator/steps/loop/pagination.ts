import { createHash } from 'crypto';
import type { LoopStep } from '../../../types';
import {
  capturePageScreenshot,
  checkForMoreItemsFromVision,
  type ExtractionMode,
} from '../../extraction';
import {
  buildHybridActiveToolsForUrl,
  createBrowserTabTools,
  getSpreadsheetProvider,
} from '../../agent-tools';
import { waitForPageReady } from '../../page-ready';
import { buildSessionDownloadedFilesSection } from '../../session-files';
import type { LoopDeps } from './deps';

type PaginationState = 'assess' | 'navigate' | 'verify';

export type PaginationResult =
  | {
      shouldContinue: false;
      reason: 'unsupported_mode' | 'no_more_items';
    }
  | {
      shouldContinue: true;
      reason: 'navigated';
      action: 'scroll_down' | 'click_next' | 'click_load_more';
      selectorHint: string;
      progressed: boolean;
    };

function hashString(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}

function getActiveUrl(deps: LoopDeps): string {
  const page = deps.stagehand.context.activePage() ?? deps.stagehand.context.pages()[0];
  return page?.url?.() ?? '';
}

export async function navigateToNextBatch(
  deps: LoopDeps,
  loopStep: LoopStep,
  loopIndex: number,
  action: 'scroll_down' | 'click_next' | 'click_load_more',
  selectorHint: string,
  query: string,
): Promise<void> {
  const actionInstructions: Record<typeof action, string> = {
    scroll_down: 'Scroll down to reveal more items.',
    click_next: `Click the "Next" or "Next Page" button${selectorHint ? ` (${selectorHint})` : ''}.`,
    click_load_more: `Click the "Load More" or "Show More" button${selectorHint ? ` (${selectorHint})` : ''}.`,
  };

  const instruction =
    actionInstructions[action] ??
    `Navigate to reveal more "${query}" items.${selectorHint ? ` Look for: ${selectorHint}` : ''}`;

  console.log(`[LOOP] Navigating to next batch: ${instruction}`);
  const requestCredentialHandoff = deps.requestCredentialHandoff;
  const promptSections = [
    'You are navigating a web page to reveal more list items.',
    'Perform exactly the action described. Do not do anything else.',
  ];
  const downloadedFilesSection = buildSessionDownloadedFilesSection(deps.getDownloadedFiles());
  if (downloadedFilesSection) {
    promptSections.push('', downloadedFilesSection);
  }

  const agent = deps.stagehand.agent({
    systemPrompt: promptSections.join('\n'),
    tools: createBrowserTabTools(
      deps.stagehand,
      requestCredentialHandoff
        ? {
            onRequestCredentials: (request) =>
              requestCredentialHandoff(request, loopStep, loopIndex),
          }
        : undefined,
    ),
    stream: false,
    model: {
      modelName: deps.models.agent,
      apiKey: deps.openrouterApiKey,
      baseURL: deps.openrouterBaseUrl,
    },
    mode: 'hybrid',
    interactionSync: deps.getAgentInteractionSync(),
  });

  await agent.execute({
    instruction,
    maxSteps: 10,
    callbacks: {
      prepareStep: async ({ stepNumber }: { stepNumber: number }) => {
        const activeUrl = getActiveUrl(deps);
        const provider = getSpreadsheetProvider(activeUrl);
        const activeTools = buildHybridActiveToolsForUrl(activeUrl);
        console.log(
          `[LOOP] Tool activation step=${stepNumber}: provider=${provider ?? 'none'} spreadsheetTools=${provider ? 'enabled' : 'disabled'} activeTools=${JSON.stringify(activeTools)}`,
        );
        return { activeTools };
      },
    },
  });
}

export async function runPaginationStateMachine(params: {
  deps: LoopDeps;
  step: LoopStep;
  index: number;
  query: string;
  totalProcessed: number;
  extractionMode: ExtractionMode;
}): Promise<PaginationResult> {
  const { deps, step, index, query, totalProcessed, extractionMode } = params;

  if (extractionMode === 'spreadsheet' || extractionMode === 'files') {
    console.log(`[LOOP] ${extractionMode} mode has no pagination search — stopping`);
    return {
      shouldContinue: false,
      reason: 'unsupported_mode',
    };
  }

  let state: PaginationState = 'assess';
  let decision:
    | {
        action: 'scroll_down' | 'click_next' | 'click_load_more' | 'none';
        selectorHint: string;
      }
    | undefined;
  let beforeScreenshotHash = '';
  let beforeUrl = '';

  while (true) {
    deps.assertNotAborted();

    if (state === 'assess') {
      const beforeScreenshot = await capturePageScreenshot(deps.stagehand);
      beforeScreenshotHash = hashString(beforeScreenshot);
      beforeUrl = getActiveUrl(deps);

      const pagination = await checkForMoreItemsFromVision({
        llmClient: deps.openai,
        model: deps.models.extract,
        screenshotDataUrl: beforeScreenshot,
        description: query,
        totalProcessed,
      });

      decision = {
        action: pagination.action,
        selectorHint: pagination.selectorHint,
      };

      console.log(
        `[LOOP] Pagination: hasMore=${pagination.hasMore} action=${pagination.action} hint="${pagination.selectorHint}"`,
      );

      if (!pagination.hasMore || pagination.action === 'none') {
        return {
          shouldContinue: false,
          reason: 'no_more_items',
        };
      }

      state = 'navigate';
      continue;
    }

    if (state === 'navigate') {
      if (!decision || decision.action === 'none') {
        return {
          shouldContinue: false,
          reason: 'no_more_items',
        };
      }

      await navigateToNextBatch(deps, step, index, decision.action, decision.selectorHint, query);
      await waitForPageReady(deps.stagehand);
      state = 'verify';
      continue;
    }

    const afterScreenshot = await capturePageScreenshot(deps.stagehand);
    const afterScreenshotHash = hashString(afterScreenshot);
    const afterUrl = getActiveUrl(deps);
    const progressed = beforeScreenshotHash !== afterScreenshotHash || beforeUrl !== afterUrl;

    if (!decision || decision.action === 'none') {
      return {
        shouldContinue: false,
        reason: 'no_more_items',
      };
    }

    return {
      shouldContinue: true,
      reason: 'navigated',
      action: decision.action,
      selectorHint: decision.selectorHint,
      progressed,
    };
  }
}

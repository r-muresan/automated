import OpenAI from 'openai';
import type { Stagehand } from '../stagehand/v3';
import type { LoopStep, Step, OrchestratorEvent, LoopContext } from '../types';
import {
  identifyItemsFromVision,
  checkForMoreItemsFromVision,
  type VisionItem,
} from './extraction';
import {
  createBrowserTabTools,
  type CredentialHandoffRequest,
  type CredentialHandoffResult,
} from './agent-tools';
import { waitForPageReady } from './page-ready';

// ---------------------------------------------------------------------------
// Dependency contract — everything the loop needs from the orchestrator
// ---------------------------------------------------------------------------

export interface LoopDeps {
  stagehand: Stagehand;
  openai: OpenAI;
  models: { extract: string; agent: string };
  openrouterApiKey: string;
  openrouterBaseUrl: string;
  emit: (event: OrchestratorEvent) => void;
  assertNotAborted: () => void;
  executeSteps: (steps: Step[], context?: LoopContext) => Promise<void>;
  requestCredentialHandoff?: (
    request: CredentialHandoffRequest,
    step: LoopStep,
    index: number,
  ) => Promise<CredentialHandoffResult>;
}

const CUA_MODEL_ALIASES: Record<string, string> = {
  'anthropic/claude-sonnet-4.6': 'anthropic/claude-sonnet-4.6',
  'anthropic/claude-opus-4.6': 'anthropic/claude-opus-4.6',
};

function resolveCuaModelName(modelName: string): string {
  return CUA_MODEL_ALIASES[modelName] ?? modelName;
}

function resolveOpenRouterModelName(modelName: string): string {
  const normalized = resolveCuaModelName(modelName);
  return normalized.startsWith('openai/') ? normalized : `openai/${normalized}`;
}

// ---------------------------------------------------------------------------
// Page utilities (no DOM, no page.evaluate)
// ---------------------------------------------------------------------------

/** Viewport screenshot as a base64 data URL. Uses CDP — not DOM. */
export async function capturePageScreenshot(stagehand: Stagehand): Promise<string> {
  const page = stagehand.context.activePage() || stagehand.context.pages()[0];
  const screenshot = await page.screenshot({ fullPage: false });
  return `data:image/png;base64,${Buffer.from(screenshot).toString('base64')}`;
}

// ---------------------------------------------------------------------------
// CUA navigation — pure vision + computer-use tools, no DOM
// ---------------------------------------------------------------------------

async function navigateToNextBatch(
  deps: LoopDeps,
  loopStep: LoopStep,
  loopIndex: number,
  action: string,
  selectorHint: string,
  description: string,
): Promise<void> {
  const actionInstructions: Record<string, string> = {
    scroll_down: 'Scroll down to reveal more items.',
    click_next: `Click the "Next" or "Next Page" button${selectorHint ? ` (${selectorHint})` : ''}.`,
    click_load_more: `Click the "Load More" or "Show More" button${selectorHint ? ` (${selectorHint})` : ''}.`,
  };

  const instruction =
    actionInstructions[action] ??
    `Navigate to see more "${description}" items.${selectorHint ? ` Look for: ${selectorHint}` : ''}`;

  console.log(`[VISION_LOOP] Navigating to next batch: ${instruction}`);
  const requestCredentialHandoff = deps.requestCredentialHandoff;

  const agent = deps.stagehand.agent({
    systemPrompt: `You are navigating a web page to reveal more list items.
Perform exactly the action described. Do not do anything else.`,
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
      modelName: resolveOpenRouterModelName(deps.models.agent),
      apiKey: deps.openrouterApiKey,
      baseURL: deps.openrouterBaseUrl,
    },
    mode: 'hybrid',
  });

  try {
    await agent.execute({ instruction, maxSteps: 10 });
  } catch (error: any) {
    console.warn(`[VISION_LOOP] Navigation agent error (continuing): ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main loop entry point
// ---------------------------------------------------------------------------

const MAX_TOTAL_ITEMS = 200;
const MAX_PAGES = 50;
/** Stop after this many consecutive pages that yield zero new items. */
const MAX_CONSECUTIVE_EMPTY = 3;

export async function executeLoopStep(
  deps: LoopDeps,
  step: LoopStep,
  index: number,
): Promise<void> {
  console.log(`[VISION_LOOP] Starting: "${step.description}"`);
  deps.assertNotAborted();

  const processedFingerprints = new Set<string>();
  let totalProcessed = 0;
  let consecutiveEmpty = 0;
  let pageCount = 0;
  let loopSuccess = true;
  let loopError: string | undefined;

  await waitForPageReady(deps.stagehand);

  const initialPages = new Set(deps.stagehand.context.pages());
  const initialActivePage =
    deps.stagehand.context.activePage() ?? deps.stagehand.context.pages()[0];

  try {
    while (totalProcessed < MAX_TOTAL_ITEMS && pageCount < MAX_PAGES) {
      deps.assertNotAborted();
      pageCount++;

      // ── 1. Screenshot (pure vision, no DOM) ────────────────────────────
      const screenshot = await capturePageScreenshot(deps.stagehand);

      // ── 2. Identify new items via vision LLM ───────────────────────────
      const visionItems: VisionItem[] = await identifyItemsFromVision({
        llmClient: deps.openai,
        model: deps.models.extract,
        screenshotDataUrl: screenshot,
        description: step.description,
        knownFingerprints: processedFingerprints,
      });

      console.log(
        `[VISION_LOOP] Page ${pageCount}: ${visionItems.length} new item(s) ` +
          `(${processedFingerprints.size} already processed)`,
      );

      if (visionItems.length === 0) {
        consecutiveEmpty++;
        console.log(`[VISION_LOOP] Empty page ${consecutiveEmpty}/${MAX_CONSECUTIVE_EMPTY}`);
        if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY) {
          console.log('[VISION_LOOP] Consecutive empty limit reached — stopping');
          break;
        }
      } else {
        consecutiveEmpty = 0;
      }

      // ── 3. Process each new item ────────────────────────────────────────
      for (const visionItem of visionItems) {
        if (totalProcessed >= MAX_TOTAL_ITEMS) break;
        deps.assertNotAborted();

        // Register fingerprint before executing so a re-visit won't reprocess
        processedFingerprints.add(visionItem.fingerprint);

        console.log(
          `[VISION_LOOP] Processing item ${totalProcessed + 1}: "${visionItem.fingerprint}"`,
        );

        deps.emit({
          type: 'loop:iteration:start',
          step,
          index,
          iteration: totalProcessed + 1,
          totalItems: Math.max(totalProcessed + visionItems.length, totalProcessed + 1),
          item: visionItem.data,
        });

        let iterationSuccess = true;
        let iterationError: string | undefined;

        try {
          await deps.executeSteps(step.steps, {
            item: visionItem.data,
            itemIndex: totalProcessed + 1,
          });
        } catch (error: any) {
          iterationSuccess = false;
          iterationError = error?.message ?? 'Iteration failed';
          console.warn(`[VISION_LOOP] Item "${visionItem.fingerprint}" failed: ${iterationError}`);
        }

        totalProcessed++;

        deps.emit({
          type: 'loop:iteration:end',
          step,
          index,
          iteration: totalProcessed,
          totalItems: totalProcessed,
          success: iterationSuccess,
          error: iterationError,
        });

        // Close any tabs that were opened during this iteration, never the first tab
        const currentPages = deps.stagehand.context.pages();
        const firstPage = currentPages[0];
        const newPages = currentPages.filter((p) => !initialPages.has(p) && p !== firstPage);
        for (const page of newPages) {
          await page.close();
        }
        if (newPages.length > 0) {
          deps.stagehand.context.setActivePage(initialActivePage);
          await initialActivePage.sendCDP('Page.bringToFront');
        }
      }

      // ── 4. Check for more items (vision, no DOM) ────────────────────────
      const freshScreenshot = await capturePageScreenshot(deps.stagehand);
      const pagination = await checkForMoreItemsFromVision({
        llmClient: deps.openai,
        model: deps.models.extract,
        screenshotDataUrl: freshScreenshot,
        description: step.description,
        totalProcessed,
      });

      console.log(
        `[VISION_LOOP] Pagination: hasMore=${pagination.hasMore} ` +
          `action=${pagination.action} hint="${pagination.selectorHint}"`,
      );

      if (!pagination.hasMore || pagination.action === 'none') {
        console.log('[VISION_LOOP] No more items — done');
        break;
      }

      // ── 5. Navigate to next batch via CUA agent (vision + tools) ────────
      await navigateToNextBatch(
        deps,
        step,
        index,
        pagination.action,
        pagination.selectorHint,
        step.description,
      );

      await waitForPageReady(deps.stagehand);
    }
  } catch (error: any) {
    if ((error as any)?.message === 'Workflow aborted') throw error;
    loopSuccess = false;
    loopError = error?.message ?? 'Loop failed';
    console.error(`[VISION_LOOP] Error: ${loopError}`);
  }

  console.log(
    `[VISION_LOOP] Complete: "${step.description}" — ` +
      `${totalProcessed} item(s) across ${pageCount} page(s)`,
  );

  deps.emit({ type: 'step:end', step, index, success: loopSuccess, error: loopError });
}

import type { NavigateStep, TabNavigateStep } from '../../types';
import type { OrchestratorContext } from '../orchestrator-context';

export async function executeNavigateStep(
  ctx: OrchestratorContext,
  step: NavigateStep,
  index: number,
): Promise<void> {
  if (!ctx.stagehand) throw new Error('Browser session not initialized');

  console.log(`[ORCHESTRATOR] Navigating to: ${step.url}`);

  try {
    ctx.assertNotAborted();
    const page = ctx.stagehand.context.pages()[0];
    await page.goto(step.url, { waitUntil: 'domcontentloaded' });

    ctx.stepResults.push({
      instruction: `Navigate to ${step.url}`,
      success: true,
    });
    ctx.emit({ type: 'step:end', step, index, success: true });
  } catch (error: any) {
    console.error(`[ORCHESTRATOR] Navigation failed:`, error.message ?? error);
    ctx.stepResults.push({
      instruction: `Navigate to ${step.url}`,
      success: false,
      error: error.message,
    });
    ctx.emit({
      type: 'step:end',
      step,
      index,
      success: false,
      error: error?.message ?? 'Navigation failed',
    });
  }
}

export async function executeTabNavigateStep(
  ctx: OrchestratorContext,
  step: TabNavigateStep,
  index: number,
): Promise<void> {
  if (!ctx.stagehand) throw new Error('Browser session not initialized');

  console.log(`[ORCHESTRATOR] Tab navigating to: ${step.url}`);

  try {
    ctx.assertNotAborted();
    const pages = ctx.stagehand.context.pages();

    // Check if there's already a tab with this URL
    let targetPage = pages.find((page) => page.url() === step.url);

    if (targetPage) {
      // Tab exists, bring it to front
      console.log(`[ORCHESTRATOR] Found existing tab with URL, bringing to front`);
      if (typeof (targetPage as any).bringToFront === 'function') {
        await (targetPage as any).bringToFront();
      }
    } else {
      // Create a new tab and navigate
      console.log(`[ORCHESTRATOR] Creating new tab for URL`);
      targetPage = await ctx.stagehand.context.newPage();
      await targetPage.goto(step.url, { waitUntil: 'domcontentloaded' });
    }

    ctx.stepResults.push({
      instruction: `Tab navigate to ${step.url}`,
      success: true,
    });
    ctx.emit({ type: 'step:end', step, index, success: true });
  } catch (error: any) {
    console.error(`[ORCHESTRATOR] Tab navigation failed:`, error.message ?? error);
    ctx.stepResults.push({
      instruction: `Tab navigate to ${step.url}`,
      success: false,
      error: error.message,
    });
    ctx.emit({
      type: 'step:end',
      step,
      index,
      success: false,
      error: error?.message ?? 'Tab navigation failed',
    });
  }
}

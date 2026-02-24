import type { Stagehand } from '@browserbasehq/stagehand';
import { LOADING_SELECTORS, getDomStabilityJs } from './page-scripts';

export async function waitForPageReady(
  stagehand: Stagehand,
  options?: {
    networkIdleTimeoutMs?: number;
    loadingIndicatorTimeoutMs?: number;
    domStableMs?: number;
    domStabilityTimeoutMs?: number;
  },
  assertNotAborted?: () => void,
): Promise<void> {
  assertNotAborted?.();
  const {
    networkIdleTimeoutMs: _networkIdleTimeoutMs = 3000,
    loadingIndicatorTimeoutMs = 5000,
    domStableMs = 300,
    domStabilityTimeoutMs = 3000,
  } = options ?? {};

  const totalStartTime = Date.now();
  const page = stagehand.context.activePage();
  if (!page) return;

  let loadingIndicatorResult = 'success';
  const loadingStart = Date.now();
  try {
    await waitForLoadingIndicatorsGone(page, loadingIndicatorTimeoutMs);
  } catch (error: any) {
    if (error.message?.includes('timeout') || error.name === 'TimeoutError') {
      loadingIndicatorResult = 'timeout';
      console.log('[PAGE_READY] Loading indicator timeout - proceeding');
    } else {
      loadingIndicatorResult = 'error';
      console.log('[PAGE_READY] Loading indicator check failed - proceeding');
    }
  }
  const loadingDuration = Date.now() - loadingStart;

  let domStabilityResult = 'success';
  const domStart = Date.now();
  try {
    await waitForDomStable(page, domStableMs, domStabilityTimeoutMs);
  } catch (error: any) {
    if (error.message?.includes('timeout') || error.name === 'TimeoutError') {
      domStabilityResult = 'timeout';
      console.log('[PAGE_READY] DOM stability timeout - proceeding');
    } else {
      domStabilityResult = 'error';
      console.log('[PAGE_READY] DOM stability check failed - proceeding');
    }
  }
  const domDuration = Date.now() - domStart;

  const totalDuration = Date.now() - totalStartTime;
  console.log(
    `[PAGE_READY] Complete in ${totalDuration}ms (loading: ${loadingDuration}ms/${loadingIndicatorResult}, dom: ${domDuration}ms/${domStabilityResult})`,
  );
}

export async function waitForLoadingIndicatorsGone(page: any, timeoutMs: number): Promise<void> {
  const startTime = Date.now();

  const ariaSelectors = new Set([
    '[role="progressbar"]',
    '[role="status"][aria-busy="true"]',
    '[aria-busy="true"]',
    '[aria-live="polite"][aria-busy="true"]',
  ]);

  while (Date.now() - startTime < timeoutMs) {
    let foundSelector: string | null = null;
    let foundInfo = '';

    for (const selector of LOADING_SELECTORS) {
      const requireAnimation = !ariaSelectors.has(selector);
      try {
        const locator = page.locator(selector);
        const count = await locator.count();

        for (let i = 0; i < count; i++) {
          const el = locator.nth(i);
          const visible = await el.isVisible().catch(() => false);
          if (!visible) continue;

          const info = await el
            .evaluate((node: Element) => {
              const style = window.getComputedStyle(node);
              const rect = node.getBoundingClientRect();
              const cn = node.className;
              const className = typeof cn === 'string' ? cn : '';
              return {
                tag: node.tagName.toLowerCase(),
                className,
                id: node.id || '',
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                animationName: style.animationName,
                opacity: style.opacity,
              };
            })
            .catch(() => null);

          if (!info) continue;

          if (info.width < 4 && info.height < 4) continue;

          const lcClass = info.className.toLowerCase();
          if (
            lcClass.includes('complete') ||
            lcClass.includes('done') ||
            lcClass.includes('finished') ||
            lcClass.includes('hidden') ||
            lcClass.includes('inactive') ||
            lcClass.includes('stopped')
          )
            continue;

          if (requireAnimation) {
            const hasAnimation = info.animationName !== 'none' && info.animationName !== '';
            if (!hasAnimation) continue;
          }

          foundSelector = selector;
          foundInfo = `tag=${info.tag} class="${info.className}" id="${info.id}" size=${info.width}x${info.height} animation=${info.animationName}`;
          break;
        }
      } catch {
        // selector not supported or page navigated
      }
      if (foundSelector) break;
    }

    if (!foundSelector) {
      return;
    }

    console.log(`[loading-indicator] Waiting for: "${foundSelector}" — ${foundInfo}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Loading indicator timeout');
}

export async function waitForDomStable(
  page: any,
  stableMs: number,
  timeoutMs: number,
): Promise<void> {
  const js = getDomStabilityJs(stableMs);
  await Promise.race([
    page.evaluate(js),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('DOM stability timeout')), timeoutMs),
    ),
  ]);
}

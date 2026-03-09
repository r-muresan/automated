import type { Stagehand } from '../stagehand/v3';
import { LOADING_SELECTORS, getDomStabilityJs } from './page-scripts';

const PAGE_READY_OPERATION_TIMEOUT_MS = 1500;

type PageLike = {
  evaluate: <T = unknown>(expression: string) => Promise<T>;
  locator: (selector: string) => LocatorLike;
};

type LocatorLike = {
  count: () => Promise<number>;
  nth: (index: number) => LocatorElementLike;
};

type LocatorElementLike = {
  isVisible: () => Promise<boolean>;
};

type LoadingIndicatorInfo = {
  tag: string;
  className: string;
  id: string;
  width: number;
  height: number;
  animationName: string;
  opacity: string;
};

function getLoadingIndicatorInfoJs(selector: string, index: number): string {
  return `(() => {
    const elements = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const node = elements[${index}];
    if (!(node instanceof Element)) return null;
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
  })()`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
}

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
    networkIdleTimeoutMs: _networkIdleTimeoutMs = 1000,
    loadingIndicatorTimeoutMs = 2000,
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

/**
 * Returns JS that checks all loading selectors in a single evaluate() call,
 * avoiding 15+ sequential CDP round-trips.
 */
function getLoadingCheckJs(): string {
  const selectors = LOADING_SELECTORS;
  const ariaSelectors = [
    '[role="progressbar"]',
    '[role="status"][aria-busy="true"]',
    '[aria-busy="true"]',
    '[aria-live="polite"][aria-busy="true"]',
  ];
  return `(() => {
    const selectors = ${JSON.stringify(selectors)};
    const ariaSet = new Set(${JSON.stringify(ariaSelectors)});
    const doneWords = ['complete','done','finished','hidden','inactive','stopped'];
    for (const selector of selectors) {
      try {
        const nodes = document.querySelectorAll(selector);
        const requireAnimation = !ariaSet.has(selector);
        for (let i = 0; i < nodes.length; i++) {
          const node = nodes[i];
          if (!(node instanceof Element)) continue;
          const rect = node.getBoundingClientRect();
          if (rect.width < 4 && rect.height < 4) continue;
          const style = window.getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
          const cn = node.className;
          const className = typeof cn === 'string' ? cn : '';
          const lcClass = className.toLowerCase();
          if (doneWords.some(w => lcClass.includes(w))) continue;
          if (requireAnimation) {
            const anim = style.animationName;
            if (!anim || anim === 'none') continue;
          }
          return {
            selector,
            tag: node.tagName.toLowerCase(),
            className,
            id: node.id || '',
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            animationName: style.animationName,
          };
        }
      } catch (e) {}
    }
    return null;
  })()`;
}

export async function waitForLoadingIndicatorsGone(
  page: PageLike,
  timeoutMs: number,
): Promise<void> {
  const startTime = Date.now();
  const operationTimeoutMs = Math.min(PAGE_READY_OPERATION_TIMEOUT_MS, Math.max(250, timeoutMs));
  const js = getLoadingCheckJs();

  while (Date.now() - startTime < timeoutMs) {
    const found = await withTimeout<{
      selector: string;
      tag: string;
      className: string;
      id: string;
      width: number;
      height: number;
      animationName: string;
    } | null>(page.evaluate(js), operationTimeoutMs, '[PAGE_READY] loading check').catch(
      () => null,
    );

    if (!found) {
      return;
    }

    console.log(
      `[loading-indicator] Waiting for: "${found.selector}" — tag=${found.tag} class="${found.className}" id="${found.id}" size=${found.width}x${found.height} animation=${found.animationName}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Loading indicator timeout');
}

export async function waitForDomStable(
  page: PageLike,
  stableMs: number,
  timeoutMs: number,
): Promise<void> {
  const js = getDomStabilityJs(stableMs);
  await withTimeout(page.evaluate(js), timeoutMs, 'DOM stability');
}

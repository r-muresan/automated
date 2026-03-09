import type { Stagehand } from '../../../stagehand/v3';

type EvaluatablePage = {
  evaluate: <T = unknown>(expression: string) => Promise<T>;
};

const SCROLL_SETTLE_MS = 800;
const PAGINATION_SETTLE_MS = 1600;
const OBSERVE_TIMEOUT_MS = 30_000;

const scrollScript = `
  (() => {
    const el = document.scrollingElement || document.documentElement;
    const before = el.scrollTop;
    el.scrollBy(0, window.innerHeight * 0.8);
    return { scrolled: el.scrollTop > before };
  })()
`;

export async function scrollPageDown(page: EvaluatablePage): Promise<boolean> {
  const result = await page.evaluate<{ scrolled: boolean }>(scrollScript);
  if (result.scrolled) {
    await new Promise((r) => setTimeout(r, SCROLL_SETTLE_MS));
  }
  return result.scrolled;
}

/**
 * Uses stagehand.observe() to find a "load more" / "next page" / "show more"
 * button via the accessibility tree + LLM, then clicks it with stagehand.act().
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export async function tryClickPaginationButton(stagehand: Stagehand): Promise<boolean> {
  try {
    const actions = await withTimeout(
      stagehand.observe(
        'Find a clickable "Load More", "Show More", "Next", "Next Page", or pagination button that loads additional list items. Do not select navigation links or footer links.',
      ),
      OBSERVE_TIMEOUT_MS,
      'stagehand.observe(pagination)',
    );

    if (!actions || actions.length === 0) {
      console.log('[PAGE-SCROLL] No pagination button found via observe');
      return false;
    }

    const action = actions[0];
    console.log(
      `[PAGE-SCROLL] Found pagination element: "${action.description}" (selector: ${action.selector})`,
    );

    await stagehand.act(action);
    await new Promise((r) => setTimeout(r, PAGINATION_SETTLE_MS));
    return true;
  } catch (error) {
    console.warn('[PAGE-SCROLL] Pagination observe/act failed:', (error as Error).message);
    return false;
  }
}

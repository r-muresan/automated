/**
 * Shared list of loading indicator CSS selectors.
 */
const LOADING_SELECTORS = [
  '[class*="spinner"]',
  '[class*="loading"]',
  '[class*="loader"]',
  '[class*="skeleton"]',
  '[class*="progress"]',
  '[class*="shimmer"]',
  '[role="progressbar"]',
  '[role="status"][aria-busy="true"]',
  '[aria-busy="true"]',
  '[aria-live="polite"][aria-busy="true"]',
  '.loading-overlay',
  '.page-loading',
  '.content-loading',
  'svg[class*="spin"]',
  'svg[class*="loading"]',
];

/** Exported so the orchestrator can iterate over selectors. */
export { LOADING_SELECTORS };

/**
 * Returns JavaScript that waits for DOM stability.
 * The script resolves when no significant DOM mutations have occurred for `stableMs` milliseconds.
 */
export function getDomStabilityJs(stableMs: number): string {
  return `
  (() => new Promise((resolve) => {
    let lastMutationTime = Date.now();
    let resolved = false;
    const root = document.body ?? document.documentElement;

    if (!root) {
      resolve(true);
      return;
    }

    const observer = new MutationObserver((mutations) => {
      const mutationList = Array.isArray(mutations) ? mutations : [];
      const significantMutations = mutationList.filter(m => {
        if (m.type === 'childList') return true;
        if (m.type === 'characterData') return true;
        if (m.type === 'attributes') {
          const el = m.target;
          if (el.nodeType !== 1) return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }
        return false;
      });

      if (significantMutations.length > 0) {
        lastMutationTime = Date.now();
      }
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });

    const checkStability = () => {
      if (resolved) return;
      const timeSinceLastMutation = Date.now() - lastMutationTime;
      if (timeSinceLastMutation >= ${stableMs}) {
        resolved = true;
        observer.disconnect();
        resolve(true);
      } else {
        setTimeout(checkStability, 50);
      }
    };

    setTimeout(checkStability, 50);
  }))()
  `;
}

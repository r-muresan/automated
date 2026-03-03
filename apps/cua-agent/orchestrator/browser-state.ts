import type { Stagehand } from '../stagehand/v3';
import type { BrowserState, TabState } from '../types';

export async function captureBrowserState(stagehand: Stagehand): Promise<BrowserState> {
  const pages = stagehand.context.pages();
  const activePage = stagehand.context.activePage();

  const tabs: TabState[] = pages.map((page, index) => ({
    url: page.url(),
    index,
  }));

  const activeTabIndex = activePage ? pages.indexOf(activePage) : 0;

  console.log(
    `[ORCHESTRATOR] Captured browser state: ${tabs.length} tabs, active tab index: ${activeTabIndex}`,
  );

  return {
    tabs,
    activeTabIndex: activeTabIndex >= 0 ? activeTabIndex : 0,
  };
}

export async function restoreBrowserState(
  stagehand: Stagehand,
  state: BrowserState,
): Promise<void> {
  console.log(
    `[ORCHESTRATOR] Restoring browser state: ${state.tabs.length} tabs, active tab index: ${state.activeTabIndex}`,
  );

  const currentPages = stagehand.context.pages();

  // Close extra tabs (from end to preserve indices)
  if (currentPages.length > state.tabs.length) {
    for (let i = currentPages.length - 1; i >= state.tabs.length; i--) {
      try {
        await currentPages[i].close();
        console.log(`[ORCHESTRATOR] Closed extra tab at index ${i}`);
      } catch (error: any) {
        console.warn(`[ORCHESTRATOR] Failed to close tab at index ${i}: ${error.message}`);
      }
    }
  }

  // Open new tabs if current count < saved count
  const pagesAfterClose = stagehand.context.pages();
  while (pagesAfterClose.length < state.tabs.length) {
    try {
      const newPage = await stagehand.context.newPage();
      pagesAfterClose.push(newPage);
      console.log(`[ORCHESTRATOR] Opened new tab, total tabs: ${pagesAfterClose.length}`);
    } catch (error: any) {
      console.warn(`[ORCHESTRATOR] Failed to open new tab: ${error.message}`);
      break;
    }
  }

  // Navigate each tab back to its original URL (only if URL changed)
  const finalPages = stagehand.context.pages();
  for (let i = 0; i < state.tabs.length && i < finalPages.length; i++) {
    const savedTab = state.tabs[i];
    const currentPage = finalPages[i];
    const currentUrl = currentPage.url();

    if (currentUrl !== savedTab.url) {
      try {
        await currentPage.goto(savedTab.url, {
          waitUntil: 'domcontentloaded',
          timeoutMs: 30000,
        });
        console.log(`[ORCHESTRATOR] Restored tab ${i} to ${savedTab.url}`);
      } catch (error: any) {
        console.warn(
          `[ORCHESTRATOR] Failed to restore tab ${i} to ${savedTab.url}: ${error.message}`,
        );
      }
    }
  }

  // Bring the original active tab to front
  if (state.activeTabIndex >= 0 && state.activeTabIndex < finalPages.length) {
    try {
      const targetPage = finalPages[state.activeTabIndex];
      if (typeof (targetPage as any).bringToFront === 'function') {
        await (targetPage as any).bringToFront();
        console.log(`[ORCHESTRATOR] Brought tab ${state.activeTabIndex} to front`);
      }
    } catch (error: any) {
      console.warn(
        `[ORCHESTRATOR] Failed to bring tab ${state.activeTabIndex} to front: ${error.message}`,
      );
    }
  }

  console.log('[ORCHESTRATOR] Browser state restoration complete');
}

import type { Stagehand } from '../../stagehand/v3';
import type { CdpPageLike, TabSummary } from './types';

export function getPages(stagehand: Stagehand): CdpPageLike[] {
  return stagehand.context.pages() as CdpPageLike[];
}

export function getActivePage(stagehand: Stagehand): CdpPageLike | null {
  return stagehand.context.activePage() ?? stagehand.context.pages()[0] ?? null;
}

export function setActivePage(stagehand: Stagehand, page: CdpPageLike): void {
  const context = stagehand.context as any;
  if (typeof context.setActivePage === 'function') {
    context.setActivePage(page);
  }
}

export function getPageUrl(page: CdpPageLike): string {
  try {
    return page.url() ?? '';
  } catch {
    return '';
  }
}

export async function getPageTitle(page: CdpPageLike): Promise<string> {
  try {
    return (await page.title()) ?? '';
  } catch {
    return '';
  }
}

export function getActiveTabIndex(stagehand: Stagehand, pages: CdpPageLike[]): number {
  const activePage = stagehand.context.activePage();
  const activeTabIndex = activePage ? pages.indexOf(activePage) : -1;
  return activeTabIndex >= 0 ? activeTabIndex : 0;
}

export async function getTabSummaries(stagehand: Stagehand): Promise<{
  tabs: TabSummary[];
  activeTabIndex: number;
}> {
  const pages = getPages(stagehand);
  const activeTabIndex = getActiveTabIndex(stagehand, pages);

  const tabs = await Promise.all(
    pages.map(async (page, index) => ({
      index,
      title: await getPageTitle(page),
      url: getPageUrl(page),
      isActive: index === activeTabIndex,
    })),
  );

  return { tabs, activeTabIndex };
}

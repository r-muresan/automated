import type { AgentTools, Stagehand } from '../stagehand/v3';
import { tool } from 'ai';
import { z } from 'zod';

const DEFAULT_TEXT_PREVIEW_CHARS = 3000;
const MIN_TEXT_PREVIEW_CHARS = 200;
const MAX_TEXT_PREVIEW_CHARS = 10000;

interface TabSummary {
  index: number;
  title: string;
  url: string;
  isActive: boolean;
}

export interface CredentialHandoffRequest {
  reason: string;
}

export interface CredentialHandoffResult {
  continued: boolean;
  message?: string;
  requestId?: string;
}

interface BrowserToolOptions {
  onRequestCredentials?: (request: CredentialHandoffRequest) => Promise<CredentialHandoffResult>;
}

function getPages(stagehand: Stagehand): any[] {
  return stagehand.context.pages();
}

function setActivePage(stagehand: Stagehand, page: any): void {
  const context = stagehand.context as any;
  if (typeof context.setActivePage === 'function') {
    context.setActivePage(page);
  }
}

function getActiveTabIndex(stagehand: Stagehand, pages: any[]): number {
  const activePage = stagehand.context.activePage();
  const activeTabIndex = activePage ? pages.indexOf(activePage) : -1;
  return activeTabIndex >= 0 ? activeTabIndex : 0;
}

function getPageUrl(page: any): string {
  try {
    return page.url() ?? '';
  } catch {
    return '';
  }
}

async function getPageTitle(page: any): Promise<string> {
  try {
    return (await page.title()) ?? '';
  } catch {
    return '';
  }
}

async function getTabSummaries(stagehand: Stagehand): Promise<{
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

async function getTabTextPreview(page: any, maxChars: number): Promise<string> {
  try {
    return await page.evaluate((limit: number) => {
      const text = document.body?.innerText ?? '';
      return text.replace(/\s+/g, ' ').trim().slice(0, limit);
    }, maxChars);
  } catch {
    return '';
  }
}

export function createBrowserTabTools(
  stagehand: Stagehand,
  options?: BrowserToolOptions,
): AgentTools {
  const tools = {
    list_tabs: tool({
      description: 'List all open tabs with index, title, URL, and which tab is currently active.',
      inputSchema: z.object({}),
      execute: async () => {
        const { tabs, activeTabIndex } = await getTabSummaries(stagehand);
        return {
          tabs,
          activeTabIndex,
          totalTabs: tabs.length,
        };
      },
    }),
    switch_tab: tool({
      description: 'Switch the active browser tab by its zero-based index.',
      inputSchema: z.object({
        index: z
          .number()
          .int()
          .min(0)
          .describe('Zero-based tab index to switch to (for example: 0, 1, 2).'),
      }),
      execute: async ({ index }) => {
        const pages = getPages(stagehand);
        if (pages.length === 0) {
          return { success: false, error: 'No open tabs to switch to.' };
        }
        if (index < 0 || index >= pages.length) {
          return {
            success: false,
            error: `Tab index ${index} is out of range. Valid indices are 0-${pages.length - 1}.`,
          };
        }

        const page = pages[index];
        await page.bringToFront();
        setActivePage(stagehand, page);
        await page
          .waitForLoadState('domcontentloaded', {
            timeout: 2000,
          })
          .catch(() => {});

        const title = await getPageTitle(page);
        const url = getPageUrl(page);
        const activeTabIndex = getActiveTabIndex(stagehand, pages);

        return {
          success: true,
          activeTabIndex,
          tab: {
            index,
            title,
            url,
            isActive: activeTabIndex === index,
          },
        };
      },
    }),
    // read_tab: tool({
    //   description:
    //     'Read a tab by index (or the active tab by default) and return title, URL, and visible text preview.',
    //   inputSchema: z.object({
    //     index: z
    //       .number()
    //       .int()
    //       .min(0)
    //       .optional()
    //       .describe('Optional zero-based tab index. If omitted, reads the active tab.'),
    //     maxChars: z
    //       .number()
    //       .int()
    //       .min(MIN_TEXT_PREVIEW_CHARS)
    //       .max(MAX_TEXT_PREVIEW_CHARS)
    //       .default(DEFAULT_TEXT_PREVIEW_CHARS)
    //       .optional()
    //       .describe('Maximum number of text characters to return from the tab.'),
    //   }),
    //   execute: async ({ index, maxChars }) => {
    //     const pages = getPages(stagehand);
    //     if (pages.length === 0) {
    //       return { success: false, error: 'No open tabs to read.' };
    //     }

    //     const initialActiveTabIndex = getActiveTabIndex(stagehand, pages);
    //     const targetTabIndex = index ?? initialActiveTabIndex;
    //     if (targetTabIndex < 0 || targetTabIndex >= pages.length) {
    //       return {
    //         success: false,
    //         error: `Tab index ${targetTabIndex} is out of range. Valid indices are 0-${pages.length - 1}.`,
    //       };
    //     }

    //     const page = pages[targetTabIndex];
    //     await page.bringToFront();
    //     setActivePage(stagehand, page);

    //     const safeMaxChars = Math.max(
    //       MIN_TEXT_PREVIEW_CHARS,
    //       Math.min(maxChars ?? DEFAULT_TEXT_PREVIEW_CHARS, MAX_TEXT_PREVIEW_CHARS),
    //     );

    //     const [title, textPreview] = await Promise.all([
    //       getPageTitle(page),
    //       getTabTextPreview(page, safeMaxChars),
    //     ]);
    //     const url = getPageUrl(page);
    //     const activeTabIndex = getActiveTabIndex(stagehand, pages);

    //     return {
    //       success: true,
    //       activeTabIndex,
    //       tab: {
    //         index: targetTabIndex,
    //         title,
    //         url,
    //         isActive: activeTabIndex === targetTabIndex,
    //       },
    //       textPreview,
    //       textPreviewChars: textPreview.length,
    //       truncated: textPreview.length >= safeMaxChars,
    //     };
    //   },
    // }),
    request_user_credentials: tool({
      description:
        'Pause execution and hand control to the user so they can enter credentials (login, 2FA, CAPTCHA, passkey). Wait for user to continue execution.',
      inputSchema: z.object({
        reason: z
          .string()
          .min(5)
          .max(500)
          .describe(
            'Why user credentials are required right now and what they should complete before continuing.',
          ),
      }),
      execute: async ({ reason }) => {
        if (!options?.onRequestCredentials) {
          return {
            success: false,
            error: 'Credential handoff is unavailable in this execution context.',
          };
        }

        try {
          const result = await options.onRequestCredentials({ reason });
          return {
            success: result.continued,
            continued: result.continued,
            requestId: result.requestId,
            message:
              result.message ??
              (result.continued
                ? 'User completed credential step and resumed execution.'
                : 'Credential handoff was not continued.'),
          };
        } catch (error: any) {
          return {
            success: false,
            continued: false,
            error: error?.message ?? 'Credential handoff failed.',
          };
        }
      },
    }),
  };

  return tools as unknown as AgentTools;
}

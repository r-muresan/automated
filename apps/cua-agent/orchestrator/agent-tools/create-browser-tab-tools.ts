import { tool } from 'ai';
import { z } from 'zod';
import type { AgentTools, Stagehand } from '../../stagehand/v3';
import {
  getActiveTabIndex,
  getPageTitle,
  getPageUrl,
  getPages,
  getTabSummaries,
  setActivePage,
} from './page-utils';
import { createSpreadsheetTools } from './spreadsheet';
import type { BrowserToolOptions } from './types';

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
        setActivePage(stagehand, page);
        await page.waitForLoadState('domcontentloaded', 2000).catch(() => {});

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

    ...createSpreadsheetTools(stagehand),

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

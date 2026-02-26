import { tool } from 'ai';
import { z } from 'zod';
import type { Stagehand } from '../../../stagehand/v3';
import { getPageTitle } from '../page-utils';
import type { BridgeRunResult } from '../types';
import { ensureSpreadsheetBridge, getSpreadsheetPageState, runBridge, spreadsheetToolError } from './bridge';

function isBridgeError(result: BridgeRunResult): result is Extract<BridgeRunResult, { ok: false }> {
  return 'error' in result;
}

export function createSpreadsheetTools(stagehand: Stagehand) {
  return {
    sheet_get_context: tool({
      description:
        'Get spreadsheet context when active tab is Google Sheets or Excel Web (provider, workbook title, active sheet, selected A1 range).',
      inputSchema: z.object({}),
      execute: async () => {
        const state = await getSpreadsheetPageState(stagehand);
        if ('error' in state) return state.error;

        try {
          await ensureSpreadsheetBridge(state.page);
        } catch (error: any) {
          return spreadsheetToolError(
            'BRIDGE_INJECTION_FAILED',
            error?.message ?? 'Failed to inject spreadsheet bridge via CDP.',
            { provider: state.provider, url: state.url },
          );
        }

        const contextResult = await runBridge(state.page, 'detectContext');
        if (isBridgeError(contextResult)) {
          return spreadsheetToolError(contextResult.error.code, contextResult.error.message, {
            provider: state.provider,
            url: state.url,
          });
        }

        const context =
          contextResult.value && typeof contextResult.value === 'object'
            ? (contextResult.value as Record<string, unknown>)
            : {};

        return {
          success: true,
          provider: state.provider,
          url: state.url,
          workbookTitle:
            typeof context.workbookTitle === 'string'
              ? context.workbookTitle
              : await getPageTitle(state.page),
          activeSheetName: typeof context.activeSheetName === 'string' ? context.activeSheetName : '',
          activeSelectionA1:
            typeof context.activeSelectionA1 === 'string' ? context.activeSelectionA1 : '',
          isSpreadsheet:
            typeof context.isSpreadsheet === 'boolean' ? context.isSpreadsheet : Boolean(state.provider),
        };
      },
    }),
    sheet_list_sheets: tool({
      description:
        'List sheet tabs when active tab is Google Sheets or Excel Web, including active sheet name.',
      inputSchema: z.object({}),
      execute: async () => {
        const state = await getSpreadsheetPageState(stagehand);
        if ('error' in state) return state.error;

        try {
          await ensureSpreadsheetBridge(state.page);
        } catch (error: any) {
          return spreadsheetToolError(
            'BRIDGE_INJECTION_FAILED',
            error?.message ?? 'Failed to inject spreadsheet bridge via CDP.',
            { provider: state.provider, url: state.url },
          );
        }

        const listResult = await runBridge(state.page, 'listSheets');
        if (isBridgeError(listResult)) {
          return spreadsheetToolError(listResult.error.code, listResult.error.message, {
            provider: state.provider,
            url: state.url,
          });
        }

        const payload =
          listResult.value && typeof listResult.value === 'object'
            ? (listResult.value as Record<string, unknown>)
            : {};

        const sheets = Array.isArray(payload.sheets)
          ? payload.sheets.filter((entry): entry is string => typeof entry === 'string')
          : [];
        const activeSheetName = typeof payload.activeSheetName === 'string' ? payload.activeSheetName : '';

        return {
          success: true,
          provider: state.provider,
          sheets,
          activeSheetName,
        };
      },
    }),
    sheet_read_selection: tool({
      description:
        'Read currently selected spreadsheet cells (selection-only) from Google Sheets or Excel Web by copying to clipboard and parsing TSV.',
      inputSchema: z.object({}),
      execute: async () => {
        const state = await getSpreadsheetPageState(stagehand);
        if ('error' in state) return state.error;

        try {
          await ensureSpreadsheetBridge(state.page);
        } catch (error: any) {
          return spreadsheetToolError(
            'BRIDGE_INJECTION_FAILED',
            error?.message ?? 'Failed to inject spreadsheet bridge via CDP.',
            { provider: state.provider, url: state.url },
          );
        }

        const contextResult = await runBridge(state.page, 'detectContext');
        if (isBridgeError(contextResult)) {
          return spreadsheetToolError(contextResult.error.code, contextResult.error.message, {
            provider: state.provider,
            url: state.url,
          });
        }

        const context =
          contextResult.value && typeof contextResult.value === 'object'
            ? (contextResult.value as Record<string, unknown>)
            : {};

        const keyCombo = process.platform === 'darwin' ? 'Meta+C' : 'Control+C';
        try {
          await state.page.keyPress(keyCombo);
        } catch (error: any) {
          return spreadsheetToolError(
            'CLIPBOARD_READ_FAILED',
            error?.message ?? 'Failed to trigger copy shortcut for selected cells.',
            { keyCombo, provider: state.provider, url: state.url },
          );
        }

        const clipboardResult = await runBridge(state.page, 'readClipboardText');
        if (isBridgeError(clipboardResult)) {
          return spreadsheetToolError('CLIPBOARD_READ_FAILED', clipboardResult.error.message, {
            provider: state.provider,
            url: state.url,
          });
        }

        const clipboardPayload =
          clipboardResult.value && typeof clipboardResult.value === 'object'
            ? (clipboardResult.value as Record<string, unknown>)
            : {};

        if (clipboardPayload.success !== true) {
          return spreadsheetToolError(
            'CLIPBOARD_READ_FAILED',
            typeof clipboardPayload.message === 'string'
              ? clipboardPayload.message
              : 'Clipboard read failed.',
            {
              provider: state.provider,
              url: state.url,
              errorCode:
                typeof clipboardPayload.errorCode === 'string'
                  ? clipboardPayload.errorCode
                  : 'CLIPBOARD_READ_FAILED',
            },
          );
        }

        const rawText = typeof clipboardPayload.text === 'string' ? clipboardPayload.text : '';
        const parsedResult = await runBridge(state.page, 'parseTsv', [rawText]);
        if (isBridgeError(parsedResult)) {
          return spreadsheetToolError(parsedResult.error.code, parsedResult.error.message, {
            provider: state.provider,
            url: state.url,
          });
        }

        const parsedPayload =
          parsedResult.value && typeof parsedResult.value === 'object'
            ? (parsedResult.value as Record<string, unknown>)
            : {};

        const values = Array.isArray(parsedPayload.values)
          ? parsedPayload.values
              .filter((row): row is unknown[] => Array.isArray(row))
              .map((row) =>
                row.map((cell) => (cell == null ? '' : typeof cell === 'string' ? cell : String(cell))),
              )
          : [];

        const metadataResult = await runBridge(state.page, 'getSelectionMetadata');
        const metadata =
          metadataResult.ok && metadataResult.value && typeof metadataResult.value === 'object'
            ? (metadataResult.value as Record<string, unknown>)
            : {};

        return {
          success: true,
          provider: state.provider,
          sheetName:
            typeof metadata.activeSheetName === 'string'
              ? metadata.activeSheetName
              : typeof context.activeSheetName === 'string'
                ? context.activeSheetName
                : '',
          selectionA1:
            typeof metadata.activeSelectionA1 === 'string'
              ? metadata.activeSelectionA1
              : typeof context.activeSelectionA1 === 'string'
                ? context.activeSelectionA1
                : '',
          values,
          rawTsv: typeof parsedPayload.rawTsv === 'string' ? parsedPayload.rawTsv : rawText,
        };
      },
    }),
  };
}

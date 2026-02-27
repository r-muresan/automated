import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import type { Stagehand } from '../../stagehand/v3';
import type { CdpPageLike, SpreadsheetProvider } from '../agent-tools/types';
import {
  ensureSpreadsheetBridge,
  getSpreadsheetPageState,
  runBridge,
  readRangeViaGviz,
  readRangeViaExcelGraph,
} from '../agent-tools/spreadsheet';
import {
  normalizeStringGrid,
  trimEmptyGrid,
  escapePipeCell,
  quoteSheetName,
  splitRangeReference,
} from '../agent-tools/spreadsheet/shared-utils';
import type { ParsedSchema } from './schema';
import { buildZodObjectFromMap } from './schema';
import { parseJsonFromText } from './common';

const SPREADSHEET_PREVIEW_MAX_ROWS = 50;
const SPREADSHEET_PREVIEW_LAST_COLUMN = 'Z';

type SpreadsheetSnapshot = {
  provider: SpreadsheetProvider;
  url: string;
  workbookTitle: string;
  totalSheets: number;
  sheetNames: string[];
  activeSheetName: string;
  activeSelectionA1: string;
  sampledRangeA1: string;
  values: string[][];
  tablePreview: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function formatTable(values: string[][]): string {
  const rows = values.slice(0, SPREADSHEET_PREVIEW_MAX_ROWS);
  const maxColumns = rows.reduce((acc, row) => Math.max(acc, row.length), 0);
  if (rows.length === 0 || maxColumns === 0) return '(empty range)';

  const normalizedRows = rows.map((row) =>
    Array.from({ length: maxColumns }, (_, index) => String(row[index] ?? '')),
  );

  const header = ['#', ...Array.from({ length: maxColumns }, (_, index) => `C${index + 1}`)];
  const divider = header.map(() => '---');
  const lines = [`| ${header.join(' | ')} |`, `| ${divider.join(' | ')} |`];

  normalizedRows.forEach((row, rowIndex) => {
    lines.push(`| ${rowIndex + 1} | ${row.map((cell) => escapePipeCell(cell)).join(' | ')} |`);
  });

  return lines.join('\n');
}

function parseCellAddress(value: string): { row: number } | null {
  const match = /^\$?[A-Za-z]{1,5}\$?(\d{1,7})$/.exec(value.trim());
  if (!match) return null;
  const row = Number(match[1]);
  if (!Number.isInteger(row) || row < 1) return null;
  return { row };
}

function buildWindowRangeA1(sheetName: string, startRow: number): string {
  const sheetPrefix = sheetName ? `${quoteSheetName(sheetName)}!` : '';
  const endRow = startRow + SPREADSHEET_PREVIEW_MAX_ROWS - 1;
  return `${sheetPrefix}A${startRow}:${SPREADSHEET_PREVIEW_LAST_COLUMN}${endRow}`;
}

function resolveSampledRangeA1(activeSelectionA1: string, activeSheetName: string): string {
  const trimmedSelection = activeSelectionA1.trim();
  if (!trimmedSelection) {
    return buildWindowRangeA1(activeSheetName, 1);
  }

  const { sheetName, rangePart } = splitRangeReference(trimmedSelection);
  const [leftCell] = rangePart.split(':', 1);
  const parsedCell = parseCellAddress(leftCell ?? '');
  if (!parsedCell) {
    return buildWindowRangeA1(activeSheetName, 1);
  }

  const targetSheet = sheetName || activeSheetName;
  return buildWindowRangeA1(targetSheet, parsedCell.row);
}

async function bridgeCall(
  page: CdpPageLike,
  method: string,
  args: unknown[] = [],
): Promise<Record<string, unknown>> {
  const result = await runBridge(page, method, args);
  if ('error' in result) {
    throw new Error(result.error.message);
  }

  return asRecord(result.value);
}

async function activateRange(page: CdpPageLike, rangeA1: string): Promise<void> {
  const activation = await bridgeCall(page, 'activateRange', [rangeA1]);
  if (activation.success === false) {
    const message =
      typeof activation.message === 'string' ? activation.message : 'Failed to activate range.';
    throw new Error(message);
  }

  if (activation.nameBoxStillFocused === true) {
    await page.keyPress('Enter');
    await new Promise((resolve) => setTimeout(resolve, 90));
  }
}

async function readRangeViaClipboard(page: CdpPageLike, rangeA1: string): Promise<string[][]> {
  await activateRange(page, rangeA1);

  const keyCombo = process.platform === 'darwin' ? 'Meta+C' : 'Control+C';
  await page.keyPress(keyCombo);
  await new Promise((resolve) => setTimeout(resolve, 100));

  const clipboardResult = await bridgeCall(page, 'readClipboardText');
  if (clipboardResult.success === false) {
    const message =
      typeof clipboardResult.message === 'string'
        ? clipboardResult.message
        : 'Clipboard read failed for spreadsheet range.';
    throw new Error(message);
  }

  const text = typeof clipboardResult.text === 'string' ? clipboardResult.text : '';
  const parsed = await bridgeCall(page, 'parseTsv', [text]);
  return normalizeStringGrid(parsed.values);
}

async function readRangeViaApi(
  page: CdpPageLike,
  provider: SpreadsheetProvider,
  rangeA1: string,
): Promise<string[][]> {
  const { sheetName, rangePart } = splitRangeReference(rangeA1);
  const rangeOnly = rangePart || rangeA1;

  if (provider === 'google_sheets') {
    const result = await readRangeViaGviz(page, sheetName, rangeOnly);
    if (result.ok) return result.values;
    console.log(`[ORCHESTRATOR] Extraction gviz read failed, falling back to clipboard: ${result}`);
  } else if (provider === 'excel_web') {
    const result = await readRangeViaExcelGraph(page, sheetName, rangeOnly);
    if (result.ok) return result.values;
    console.log(
      `[ORCHESTRATOR] Extraction Excel Graph API read failed, falling back to clipboard: ${result}`,
    );
  }

  return readRangeViaClipboard(page, rangeA1);
}

export async function captureSpreadsheetSnapshot(
  stagehand: Stagehand,
): Promise<SpreadsheetSnapshot> {
  const state = await getSpreadsheetPageState(stagehand);
  if ('error' in state) {
    throw new Error(state.error.error.message);
  }

  await ensureSpreadsheetBridge(state.page);

  const workbookInfo = await bridgeCall(state.page, 'getWorkbookInfo');

  const sheetNames = Array.isArray(workbookInfo.sheet_names)
    ? workbookInfo.sheet_names.filter((entry): entry is string => typeof entry === 'string')
    : [];

  const activeSheetName =
    typeof workbookInfo.active_sheet === 'string' && workbookInfo.active_sheet.trim().length > 0
      ? workbookInfo.active_sheet
      : (sheetNames[0] ?? '');

  const activeSelectionA1 =
    typeof workbookInfo.activeSelectionA1 === 'string' &&
    workbookInfo.activeSelectionA1.trim().length > 0
      ? workbookInfo.activeSelectionA1.trim()
      : '';

  const sampledRangeA1 = resolveSampledRangeA1(activeSelectionA1, activeSheetName);

  const values = trimEmptyGrid(await readRangeViaApi(state.page, state.provider, sampledRangeA1));

  return {
    provider: state.provider,
    url: state.url,
    workbookTitle:
      typeof workbookInfo.workbookTitle === 'string' && workbookInfo.workbookTitle.trim().length > 0
        ? workbookInfo.workbookTitle
        : '',
    totalSheets:
      typeof workbookInfo.total_sheets === 'number' ? workbookInfo.total_sheets : sheetNames.length,
    sheetNames,
    activeSheetName,
    activeSelectionA1,
    sampledRangeA1,
    values,
    tablePreview: formatTable(values),
  };
}

function rowsToObjects(values: string[][]): Array<Record<string, string>> {
  if (values.length === 0) return [];

  const firstRow = values[0] ?? [];
  const hasHeaderRow = firstRow.some((cell) => cell.trim().length > 0);
  const headers = firstRow.map((value, index) => {
    const candidate = value.trim();
    return candidate.length > 0 ? candidate : `column_${index + 1}`;
  });

  const dataRows = hasHeaderRow ? values.slice(1) : values;

  return dataRows
    .map((row) => {
      const output: Record<string, string> = {};
      const width = Math.max(headers.length, row.length);
      for (let index = 0; index < width; index += 1) {
        const key = headers[index] ?? `column_${index + 1}`;
        output[key] = row[index] ?? '';
      }
      return output;
    })
    .filter((row) => Object.values(row).some((value) => value.trim().length > 0));
}

export async function extractFromSpreadsheetWithLlm(params: {
  llmClient: OpenAI;
  model: string;
  dataExtractionGoal: string;
  schema?: ParsedSchema | null;
  snapshot: SpreadsheetSnapshot;
}): Promise<unknown> {
  const { llmClient, model, dataExtractionGoal, schema, snapshot } = params;

  const prompt =
    `You are extracting data from a spreadsheet snapshot.\n\n` +
    `Goal:\n${dataExtractionGoal}\n\n` +
    `Spreadsheet metadata:\n` +
    `- Sheet name: ${snapshot.activeSheetName || '(unknown)'}\n` +
    `- Sampled range: ${snapshot.sampledRangeA1}\n` +
    `- Total sheets: ${snapshot.totalSheets}\n\n` +
    `Table preview:\n${snapshot.tablePreview}\n\n` +
    'Return only JSON.';

  if (schema) {
    const zodSchema = buildZodObjectFromMap(schema);
    const response = await llmClient.chat.completions.parse({
      model,
      messages: [{ role: 'user', content: prompt }],
      response_format: zodResponseFormat(zodSchema, 'spreadsheet_extract_response'),
    });
    return response.choices[0]?.message?.parsed ?? {};
  }

  const response = await llmClient.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = response.choices[0]?.message?.content ?? '{}';
  if (typeof raw !== 'string') {
    return {};
  }

  try {
    return parseJsonFromText(raw);
  } catch {
    return {
      snapshot: {
        provider: snapshot.provider,
        workbookTitle: snapshot.workbookTitle,
        activeSheetName: snapshot.activeSheetName,
        sampledRangeA1: snapshot.sampledRangeA1,
      },
      rows: rowsToObjects(snapshot.values),
      values: snapshot.values,
    };
  }
}

export async function extractLoopItemsFromSpreadsheetWithLlm(params: {
  llmClient: OpenAI;
  model: string;
  description: string;
  snapshot: SpreadsheetSnapshot;
}): Promise<Array<Record<string, unknown>>> {
  const { llmClient, model, description, snapshot } = params;

  const itemsSchema = z.object({ items: z.array(z.record(z.string(), z.unknown())) });

  const prompt =
    `You are identifying loop items from a spreadsheet snapshot.\n\n` +
    `Find all rows/items matching this description: "${description}".\n\n` +
    `Spreadsheet metadata:\n` +
    `- Active sheet: ${snapshot.activeSheetName || '(unknown)'}\n` +
    `- Sampled range: ${snapshot.sampledRangeA1}\n\n` +
    `Table preview:\n${snapshot.tablePreview}\n\n` +
    'Return a JSON object with an "items" array only.';

  const response = await llmClient.chat.completions.parse({
    model,
    messages: [{ role: 'user', content: prompt }],
    response_format: zodResponseFormat(itemsSchema, 'spreadsheet_loop_items_response'),
  });

  const parsed = response.choices[0]?.message?.parsed;
  if (!parsed) {
    return rowsToObjects(snapshot.values);
  }

  return parsed.items.map((item) => ({ ...item }));
}

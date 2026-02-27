import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import type { Stagehand } from '../../stagehand/v3';
import type { CdpPageLike, SpreadsheetProvider } from '../agent-tools/types';
import { ensureSpreadsheetBridge, getSpreadsheetPageState, runBridge } from '../agent-tools/spreadsheet';
import type { ParsedSchema } from './schema';
import { buildZodObjectFromMap } from './schema';
import { parseJsonFromText } from './common';

const SPREADSHEET_PREVIEW_MAX_ROWS = 80;
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

function normalizeStringGrid(values: unknown): string[][] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => row.map((cell) => (cell == null ? '' : typeof cell === 'string' ? cell : String(cell))));
}

function trimEmptyGrid(values: string[][]): string[][] {
  if (!values.length) return [];
  let lastRowIndex = values.length - 1;
  while (lastRowIndex >= 0 && values[lastRowIndex].every((cell) => cell.trim() === '')) {
    lastRowIndex -= 1;
  }
  if (lastRowIndex < 0) return [];
  const rows = values.slice(0, lastRowIndex + 1);
  let lastColIndex = 0;
  for (const row of rows) {
    for (let col = row.length - 1; col >= 0; col -= 1) {
      if (row[col] && row[col].trim() !== '') {
        lastColIndex = Math.max(lastColIndex, col);
        break;
      }
    }
  }
  return rows.map((row) => row.slice(0, lastColIndex + 1));
}

function escapePipeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
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

function quoteSheetName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^[A-Za-z0-9_]+$/.test(trimmed)) return trimmed;
  return `'${trimmed.replace(/'/g, "''")}'`;
}

function looksLikeRangeA1(value: string): boolean {
  return /^'?[^'!]*'?!?\$?[A-Za-z]{1,5}\$?\d{1,7}(?::\$?[A-Za-z]{1,5}\$?\d{1,7})?$/i.test(
    value.trim(),
  );
}

function buildDefaultRangeA1(sheetName: string): string {
  const sheetPrefix = sheetName ? `${quoteSheetName(sheetName)}!` : '';
  return `${sheetPrefix}A1:${SPREADSHEET_PREVIEW_LAST_COLUMN}${SPREADSHEET_PREVIEW_MAX_ROWS}`;
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
    const message = typeof activation.message === 'string' ? activation.message : 'Failed to activate range.';
    throw new Error(message);
  }

  if (activation.nameBoxStillFocused === true) {
    await page.keyPress('Enter');
  }
}

async function readRangeViaClipboard(page: CdpPageLike, rangeA1: string): Promise<string[][]> {
  await activateRange(page, rangeA1);

  const keyCombo = process.platform === 'darwin' ? 'Meta+C' : 'Control+C';
  await page.keyPress(keyCombo);

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

export async function captureSpreadsheetSnapshot(stagehand: Stagehand): Promise<SpreadsheetSnapshot> {
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
      : sheetNames[0] ?? '';

  const activeSelectionA1 =
    typeof workbookInfo.activeSelectionA1 === 'string' && workbookInfo.activeSelectionA1.trim().length > 0
      ? workbookInfo.activeSelectionA1.trim()
      : '';

  const sampledRangeA1 = looksLikeRangeA1(activeSelectionA1)
    ? activeSelectionA1
    : buildDefaultRangeA1(activeSheetName);

  const values = trimEmptyGrid(await readRangeViaClipboard(state.page, sampledRangeA1));

  return {
    provider: state.provider,
    url: state.url,
    workbookTitle:
      typeof workbookInfo.workbookTitle === 'string' && workbookInfo.workbookTitle.trim().length > 0
        ? workbookInfo.workbookTitle
        : '',
    totalSheets: typeof workbookInfo.total_sheets === 'number' ? workbookInfo.total_sheets : sheetNames.length,
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
    `- Provider: ${snapshot.provider}\n` +
    `- Workbook title: ${snapshot.workbookTitle || '(unknown)'}\n` +
    `- Active sheet: ${snapshot.activeSheetName || '(unknown)'}\n` +
    `- Active selection: ${snapshot.activeSelectionA1 || '(none)'}\n` +
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
    `- Provider: ${snapshot.provider}\n` +
    `- Workbook title: ${snapshot.workbookTitle || '(unknown)'}\n` +
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

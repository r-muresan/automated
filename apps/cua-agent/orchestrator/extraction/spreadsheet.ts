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
import { parseJsonFromText } from './common';

const SPREADSHEET_PREVIEW_MAX_ROWS = 50;

/**
 * Execute a user-provided JS function string against spreadsheet data.
 * The function receives `values` (string[][]) and `headers` (string[]) and should return the result.
 */
function executeParseFunction(
  code: string,
  values: string[][],
): unknown {
  const headers = (values[0] ?? []).map((h, i) => h.trim() || `column_${i + 1}`);
  const dataRows = values.length > 0 ? values.slice(1) : [];

  // Build a function from the code string.
  // The code should be a function body that uses `values`, `headers`, and `dataRows`.
  const fn = new Function('values', 'headers', 'dataRows', code);
  return fn(values, headers, dataRows);
}
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

function gridDimensions(values: string[][]): { rows: number; cols: number } {
  return {
    rows: values.length,
    cols: values.reduce((max, row) => Math.max(max, row.length), 0),
  };
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

  // Extract sheet name from selection if present, but always start from row 1
  // to ensure we capture headers and all data regardless of cursor position.
  const { sheetName } = splitRangeReference(trimmedSelection);
  const targetSheet = sheetName || activeSheetName;
  return buildWindowRangeA1(targetSheet, 1);
}

async function bridgeCall(
  page: CdpPageLike,
  method: string,
  args: unknown[] = [],
): Promise<Record<string, unknown>> {
  const start = Date.now();
  console.log(
    `[SPREADSHEET_EXTRACT] bridgeCall:start method=${method} args=${args.length} url="${page.url()}"`,
  );
  const result = await runBridge(page, method, args);
  const duration = Date.now() - start;
  console.log(
    `[SPREADSHEET_EXTRACT] bridgeCall:end method=${method} duration_ms=${duration} success=${!('error' in result)}`,
  );
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

  // The bridge focused the Name Box and selected its text. Now type the range
  // reference and press Enter via CDP so Excel Web processes real input events.
  if (activation.needsCdpInput === true) {
    const rangePart =
      typeof activation.rangePart === 'string' ? activation.rangePart : rangeA1;
    await page.keyPress('Control+A');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await page.sendCDP('Input.insertText', { text: rangePart });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await page.keyPress('Enter');
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Blur the Name Box so focus returns to the grid.
    await bridgeCall(page, 'blurNameBox');
  }
}

async function readRangeViaClipboard(page: CdpPageLike, rangeA1: string): Promise<string[][]> {
  const start = Date.now();
  console.log(`[SPREADSHEET_EXTRACT] clipboard-read:start range="${rangeA1}"`);
  await activateRange(page, rangeA1);

  // Detect browser platform (may differ from server — e.g. Browserbase runs Linux).
  let browserIsMac = false;
  try {
    const res = await page.sendCDP<{ result?: { value?: string } }>('Runtime.evaluate', {
      expression: 'navigator.platform',
      returnByValue: true,
    });
    browserIsMac = typeof res.result?.value === 'string' && res.result.value.toLowerCase().includes('mac');
  } catch {}
  const keyCombo = browserIsMac ? 'Meta+C' : 'Control+C';
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
  const normalized = normalizeStringGrid(parsed.values);
  const { rows, cols } = gridDimensions(normalized);
  console.log(
    `[SPREADSHEET_EXTRACT] clipboard-read:end range="${rangeA1}" duration_ms=${Date.now() - start} rows=${rows} cols=${cols}`,
  );
  return normalized;
}

async function readRangeViaApi(
  page: CdpPageLike,
  provider: SpreadsheetProvider,
  rangeA1: string,
): Promise<string[][]> {
  const start = Date.now();
  const { sheetName, rangePart } = splitRangeReference(rangeA1);
  const rangeOnly = rangePart || rangeA1;

  if (provider === 'google_sheets') {
    console.log(
      `[SPREADSHEET_EXTRACT] gviz-read:start sheet="${sheetName || '(active)'}" range="${rangeOnly}"`,
    );
    const result = await readRangeViaGviz(page, sheetName, rangeOnly);
    if (result.ok) {
      const { rows, cols } = gridDimensions(result.values);
      console.log(
        `[SPREADSHEET_EXTRACT] gviz-read:end duration_ms=${Date.now() - start} rows=${rows} cols=${cols}`,
      );
      return result.values;
    }
    const failureMessage = 'message' in result ? result.message : 'unknown error';
    console.log(
      `[SPREADSHEET_EXTRACT] gviz-read:failed duration_ms=${Date.now() - start} message="${failureMessage}" fallback=clipboard`,
    );
  } else if (provider === 'excel_web') {
    console.log(
      `[SPREADSHEET_EXTRACT] excel-graph-read:start sheet="${sheetName || '(active)'}" range="${rangeOnly}"`,
    );
    const result = await readRangeViaExcelGraph(page, sheetName, rangeOnly);

    if (result.ok) {
      const { rows, cols } = gridDimensions(result.values);
      console.log(
        `[SPREADSHEET_EXTRACT] excel-graph-read:end duration_ms=${Date.now() - start} rows=${rows} cols=${cols}`,
      );
      return result.values;
    }
    const failureMessage = 'message' in result ? result.message : 'unknown error';
    console.log(
      `[SPREADSHEET_EXTRACT] excel-graph-read:failed duration_ms=${Date.now() - start} message="${failureMessage}" fallback=clipboard`,
    );
  }

  const values = await readRangeViaClipboard(page, rangeA1);
  const { rows, cols } = gridDimensions(values);
  console.log(
    `[SPREADSHEET_EXTRACT] read-range:clipboard-fallback:end duration_ms=${Date.now() - start} rows=${rows} cols=${cols}`,
  );
  return values;
}

export async function captureSpreadsheetSnapshot(
  stagehand: Stagehand,
): Promise<SpreadsheetSnapshot> {
  const start = Date.now();
  console.log('[SPREADSHEET_EXTRACT] snapshot:start');
  const state = await getSpreadsheetPageState(stagehand);
  if ('error' in state) {
    throw new Error(state.error.error.message);
  }
  console.log(
    `[SPREADSHEET_EXTRACT] snapshot:page-state provider=${state.provider} url="${state.url}"`,
  );

  const bridgeStart = Date.now();
  await ensureSpreadsheetBridge(state.page);
  console.log(
    `[SPREADSHEET_EXTRACT] snapshot:bridge-ready duration_ms=${Date.now() - bridgeStart}`,
  );

  const workbookStart = Date.now();
  const workbookInfo = await bridgeCall(state.page, 'getWorkbookInfo');
  console.log(
    `[SPREADSHEET_EXTRACT] snapshot:workbook-info duration_ms=${Date.now() - workbookStart}`,
  );

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
  console.log(
    `[SPREADSHEET_EXTRACT] snapshot:range activeSelection="${activeSelectionA1 || '(none)'}" sampled="${sampledRangeA1}"`,
  );

  const values = trimEmptyGrid(await readRangeViaApi(state.page, state.provider, sampledRangeA1));
  const { rows, cols } = gridDimensions(values);
  console.log(
    `[SPREADSHEET_EXTRACT] snapshot:end duration_ms=${Date.now() - start} rows=${rows} cols=${cols}`,
  );

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
  snapshot: SpreadsheetSnapshot;
}): Promise<unknown> {
  const { llmClient, model, dataExtractionGoal, snapshot } = params;
  const start = Date.now();
  const { rows, cols } = gridDimensions(snapshot.values);
  console.log(
    `[SPREADSHEET_EXTRACT] llm:start model=${model} rows=${rows} cols=${cols} sampledRange="${snapshot.sampledRangeA1}"`,
  );

  const prompt =
    `You are extracting data from a spreadsheet snapshot.\n\n` +
    `Goal:\n${dataExtractionGoal}\n\n` +
    `Spreadsheet metadata:\n` +
    `- Sheet name: ${snapshot.activeSheetName || '(unknown)'}\n` +
    `- Sampled range: ${snapshot.sampledRangeA1}\n` +
    `- Total sheets: ${snapshot.totalSheets}\n\n` +
    `Table preview:\n${snapshot.tablePreview}\n\n` +
    `You have two options for returning the extracted data:\n\n` +
    `Option 1 — Direct JSON: Return the extracted data as a JSON object or array.\n` +
    `Wrap it like: { "mode": "data", "data": <your extracted JSON> }\n\n` +
    `Option 2 — Code function: Return a JavaScript function body that parses the raw spreadsheet values.\n` +
    `The function receives three arguments:\n` +
    `  - values: string[][] (all rows including header)\n` +
    `  - headers: string[] (first row, cleaned)\n` +
    `  - dataRows: string[][] (all rows after the header)\n` +
    `The function body must return the extracted result.\n` +
    `Wrap it like: { "mode": "code", "code": "<function body>" }\n\n` +
    `Use Option 2 (code) when the data is large, repetitive, or follows a clear pattern that a function can parse more reliably than enumerating every value.\n` +
    `Use Option 1 (data) when the extraction is simple or requires subjective judgment.\n\n` +
    'Return only JSON.';

  const response = await llmClient.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = response.choices[0]?.message?.content ?? '{}';
  if (typeof raw !== 'string') {
    return {};
  }

  try {
    const parsed = parseJsonFromText(raw) as Record<string, unknown>;
    console.log(`[SPREADSHEET_EXTRACT] llm:end duration_ms=${Date.now() - start} parsed=true mode=${parsed?.mode ?? 'legacy'}`);

    if (parsed?.mode === 'code' && typeof parsed.code === 'string') {
      try {
        const result = executeParseFunction(parsed.code, snapshot.values);
        console.log(`[SPREADSHEET_EXTRACT] code-execution:success`);
        return result;
      } catch (execError) {
        console.warn(
          `[SPREADSHEET_EXTRACT] code-execution:failed error="${(execError as Error).message}" fallback=snapshot`,
        );
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

    if (parsed?.mode === 'data' && parsed.data !== undefined) {
      return parsed.data;
    }

    // Legacy: model returned plain JSON without mode wrapper
    return parsed;
  } catch {
    console.log(
      `[SPREADSHEET_EXTRACT] llm:end duration_ms=${Date.now() - start} parsed=false fallback=snapshot`,
    );
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

  const responseSchema = z.object({
    mode: z.enum(['items', 'code']),
    items: z.array(z.record(z.string(), z.unknown())).nullable(),
    code: z.string().nullable(),
  });

  const prompt =
    `You are identifying loop items from a spreadsheet snapshot.\n\n` +
    `Find all rows/items matching this description: "${description}".\n\n` +
    `Spreadsheet metadata:\n` +
    `- Active sheet: ${snapshot.activeSheetName || '(unknown)'}\n` +
    `- Sampled range: ${snapshot.sampledRangeA1}\n\n` +
    `Table preview:\n${snapshot.tablePreview}\n\n` +
    `You have two options:\n\n` +
    `Option 1 — Direct items: Return { "mode": "items", "items": [ ... ] } with each item as an object.\n\n` +
    `Option 2 — Code function: Return { "mode": "code", "code": "<function body>" }.\n` +
    `The function body receives three arguments:\n` +
    `  - values: string[][] (all rows including header)\n` +
    `  - headers: string[] (first row, cleaned)\n` +
    `  - dataRows: string[][] (all rows after the header)\n` +
    `It must return an array of objects (each object is one item).\n\n` +
    `Use Option 2 (code) when the data is large, repetitive, or follows a clear pattern that a function can parse more reliably than enumerating every value.\n` +
    `Use Option 1 (items) when the extraction is simple or requires subjective judgment.`;

  const response = await llmClient.chat.completions.parse({
    model,
    messages: [{ role: 'user', content: prompt }],
    response_format: zodResponseFormat(responseSchema, 'spreadsheet_loop_items_response'),
  });

  const parsed = response.choices[0]?.message?.parsed;
  if (!parsed) {
    return rowsToObjects(snapshot.values);
  }

  if (parsed.mode === 'code' && typeof parsed.code === 'string') {
    try {
      const result = executeParseFunction(parsed.code, snapshot.values);
      console.log(`[SPREADSHEET_EXTRACT] loop-code-execution:success`);
      if (Array.isArray(result)) {
        return result.filter(
          (item): item is Record<string, unknown> =>
            item != null && typeof item === 'object' && !Array.isArray(item),
        );
      }
      console.warn(`[SPREADSHEET_EXTRACT] loop-code-execution:non-array-result fallback=rowsToObjects`);
      return rowsToObjects(snapshot.values);
    } catch (execError) {
      console.warn(
        `[SPREADSHEET_EXTRACT] loop-code-execution:failed error="${(execError as Error).message}" fallback=rowsToObjects`,
      );
      return rowsToObjects(snapshot.values);
    }
  }

  if (parsed.items) {
    return parsed.items.map((item) => ({ ...item }));
  }

  return rowsToObjects(snapshot.values);
}

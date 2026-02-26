import { tool } from 'ai';
import { z } from 'zod';
import type { Stagehand } from '../../../stagehand/v3';
import { getPageTitle } from '../page-utils';
import type {
  BridgeRunResult,
  CdpPageLike,
  SpreadsheetProvider,
  SpreadsheetToolError,
} from '../types';
import { ensureSpreadsheetBridge, getSpreadsheetPageState, runBridge, spreadsheetToolError } from './bridge';

function isBridgeError(result: BridgeRunResult): result is Extract<BridgeRunResult, { ok: false }> {
  return 'error' in result;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function normalizeStringGrid(values: unknown): string[][] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => row.map((cell) => (cell == null ? '' : typeof cell === 'string' ? cell : String(cell))));
}

function escapePipeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function columnNumberToLetters(index: number): string {
  if (!Number.isInteger(index) || index < 1) return '';
  let value = index;
  let result = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function lettersToColumnNumber(letters: string): number {
  let value = 0;
  for (const char of letters.toUpperCase()) {
    const code = char.charCodeAt(0);
    if (code < 65 || code > 90) return NaN;
    value = value * 26 + (code - 64);
  }
  return value;
}

type ParsedRange = {
  sheetName: string;
  rangePart: string;
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
  rows: number;
  cols: number;
};

function unquoteSheetName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function quoteSheetName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^[A-Za-z0-9_]+$/.test(trimmed)) return trimmed;
  return `'${trimmed.replace(/'/g, "''")}'`;
}

function splitRangeReference(value: string): { sheetName: string; rangePart: string } {
  const trimmed = value.trim();
  const bangIndex = trimmed.lastIndexOf('!');
  if (bangIndex < 0) return { sheetName: '', rangePart: trimmed };
  return {
    sheetName: unquoteSheetName(trimmed.slice(0, bangIndex)),
    rangePart: trimmed.slice(bangIndex + 1).trim(),
  };
}

function parseCellAddress(value: string): { col: number; row: number } | null {
  const match = /^\$?([A-Za-z]{1,5})\$?(\d{1,7})$/.exec(value.trim());
  if (!match) return null;
  const col = lettersToColumnNumber(match[1]);
  const row = Number(match[2]);
  if (!Number.isFinite(col) || !Number.isFinite(row) || col < 1 || row < 1) return null;
  return { col, row };
}

function parseA1Range(value: string): ParsedRange | null {
  const { sheetName, rangePart } = splitRangeReference(value);
  if (!rangePart) return null;
  const [leftRaw, rightRaw] = rangePart.split(':', 2);
  const left = parseCellAddress(leftRaw);
  const right = parseCellAddress(rightRaw ?? leftRaw);
  if (!left || !right) return null;
  const startRow = Math.min(left.row, right.row);
  const endRow = Math.max(left.row, right.row);
  const startCol = Math.min(left.col, right.col);
  const endCol = Math.max(left.col, right.col);
  return {
    sheetName,
    rangePart,
    startRow,
    endRow,
    startCol,
    endCol,
    rows: endRow - startRow + 1,
    cols: endCol - startCol + 1,
  };
}

function splitRangeList(input: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuote = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (char === "'") {
      if (inQuote && input[i + 1] === "'") {
        current += "''";
        i += 1;
        continue;
      }
      inQuote = !inQuote;
      current += char;
      continue;
    }

    if (char === ',' && !inQuote) {
      const trimmed = current.trim();
      if (trimmed) result.push(trimmed);
      current = '';
      continue;
    }

    current += char;
  }

  const trimmed = current.trim();
  if (trimmed) result.push(trimmed);
  return result;
}

function normalizeRanges(rangeA1: string | string[]): string[] {
  if (Array.isArray(rangeA1)) {
    return rangeA1.map((entry) => entry.trim()).filter(Boolean);
  }
  return splitRangeList(rangeA1);
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

function formatTable(values: string[][], width: number, maxRows: number, startingRow = 1): string {
  const rows = values.slice(0, Math.max(0, maxRows));
  const maxColumns = rows.reduce((acc, row) => Math.max(acc, row.length), 0);
  if (rows.length === 0 || maxColumns === 0) return '(empty range)';

  const normalizedRows = rows.map((row) =>
    Array.from({ length: maxColumns }, (_, index) => String(row[index] ?? '')),
  );
  const effectiveWidth = Number.isFinite(width) ? Math.max(60, Math.floor(width)) : 300;
  const cellWidth = Math.max(8, Math.min(40, Math.floor(effectiveWidth / (maxColumns + 1)) - 3));
  const clip = (value: string) => (value.length > cellWidth ? `${value.slice(0, cellWidth - 3)}...` : value);

  const header = ['#', ...Array.from({ length: maxColumns }, (_, index) => columnNumberToLetters(index + 1))];
  const divider = header.map(() => '---');
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${divider.join(' | ')} |`,
  ];

  normalizedRows.forEach((row, rowIndex) => {
    const rendered = row.map((cell) => escapePipeCell(clip(cell)));
    lines.push(`| ${startingRow + rowIndex} | ${rendered.join(' | ')} |`);
  });

  return lines.join('\n');
}

type MatrixBuildResult = {
  matrix: unknown[][];
  rows: number;
  cols: number;
};

function resolveRangeDimensions(rangeA1: string, value: unknown): { rows: number; cols: number; startRow: number } {
  const parsed = parseA1Range(rangeA1);
  if (parsed) {
    return {
      rows: parsed.rows,
      cols: parsed.cols,
      startRow: parsed.startRow,
    };
  }

  if (Array.isArray(value)) {
    if (value.length > 0 && Array.isArray(value[0])) {
      const firstRow = value[0] as unknown[];
      return { rows: value.length, cols: firstRow.length || 1, startRow: 1 };
    }
    return { rows: 1, cols: Math.max(1, value.length), startRow: 1 };
  }

  return { rows: 1, cols: 1, startRow: 1 };
}

function buildMatrix(value: unknown, rows: number, cols: number): MatrixBuildResult {
  if (!Array.isArray(value)) {
    return {
      matrix: Array.from({ length: rows }, () => Array.from({ length: cols }, () => value)),
      rows,
      cols,
    };
  }

  if (value.length > 0 && value.every((entry) => Array.isArray(entry))) {
    const matrix = value as unknown[][];
    const matrixCols = matrix.reduce((acc, row) => Math.max(acc, row.length), 0);
    if (rows !== matrix.length || cols !== matrixCols) {
      throw new Error(
        `2D value shape (${matrix.length}x${matrixCols}) does not match range dimensions (${rows}x${cols}).`,
      );
    }
    return { matrix, rows, cols };
  }

  const vector = value as unknown[];
  if (rows === 1 && cols >= 1) {
    if (vector.length !== cols && vector.length !== 1) {
      throw new Error(`Row fill expects ${cols} values, got ${vector.length}.`);
    }
    const row = vector.length === 1 ? Array.from({ length: cols }, () => vector[0]) : vector;
    return { matrix: [row], rows: 1, cols };
  }

  if (cols === 1 && rows >= 1) {
    if (vector.length !== rows && vector.length !== 1) {
      throw new Error(`Column fill expects ${rows} values, got ${vector.length}.`);
    }
    const data = vector.length === 1 ? Array.from({ length: rows }, () => [vector[0]]) : vector.map((entry) => [entry]);
    return { matrix: data, rows, cols: 1 };
  }

  throw new Error(
    '1D list can only fill a single row range (A1:C1) or single column range (A1:A3).',
  );
}

function stringifyCellValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return JSON.stringify(value);
}

function matrixToTsv(matrix: unknown[][]): string {
  return matrix
    .map((row) => row.map((cell) => stringifyCellValue(cell)).join('\t'))
    .join('\n');
}

function matrixContainsFormula(matrix: unknown[][]): boolean {
  return matrix.some((row) =>
    row.some((cell) => typeof cell === 'string' && cell.trim().startsWith('=')),
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function getReadySpreadsheetState(stagehand: Stagehand): Promise<
  | { page: CdpPageLike; provider: SpreadsheetProvider; url: string }
  | { error: SpreadsheetToolError }
> {
  const state = await getSpreadsheetPageState(stagehand);
  if ('error' in state) return { error: state.error };

  try {
    await ensureSpreadsheetBridge(state.page);
  } catch (error: any) {
    return {
      error: spreadsheetToolError(
        'BRIDGE_INJECTION_FAILED',
        error?.message ?? 'Failed to inject spreadsheet bridge via CDP.',
        { provider: state.provider, url: state.url },
      ),
    };
  }

  return state;
}

async function bridgeResult(
  page: CdpPageLike,
  method: string,
  args: unknown[] = [],
): Promise<{ value: Record<string, unknown> } | { error: SpreadsheetToolError }> {
  const result = await runBridge(page, method, args);
  if (isBridgeError(result)) {
    return {
      error: spreadsheetToolError(result.error.code, result.error.message),
    };
  }
  return { value: asRecord(result.value) };
}

function isClipboardFailure(payload: Record<string, unknown>): payload is {
  success: false;
  message: string;
} {
  return payload.success === false;
}

async function activateRange(
  page: CdpPageLike,
  rangeA1: string,
): Promise<{ ok: true; activeSheetName?: string; activeSelectionA1?: string } | { ok: false; error: SpreadsheetToolError }> {
  const activation = await bridgeResult(page, 'activateRange', [rangeA1]);
  if ('error' in activation) return { ok: false, error: activation.error };
  if (activation.value.success !== true) {
    return {
      ok: false,
      error: spreadsheetToolError(
        'UNSUPPORTED_PROVIDER_STATE',
        typeof activation.value.message === 'string'
          ? activation.value.message
          : `Failed to activate range ${rangeA1}.`,
        { rangeA1 },
      ),
    };
  }

  return {
    ok: true,
    activeSheetName:
      typeof activation.value.activeSheetName === 'string' ? activation.value.activeSheetName : undefined,
    activeSelectionA1:
      typeof activation.value.activeSelectionA1 === 'string'
        ? activation.value.activeSelectionA1
        : undefined,
  };
}

async function readRangeViaClipboard(
  page: CdpPageLike,
  rangeA1: string,
): Promise<{ ok: true; values: string[][]; rawTsv: string; metadata: Record<string, unknown> } | { ok: false; error: SpreadsheetToolError }> {
  const activated = await activateRange(page, rangeA1);
  if ('error' in activated) return { ok: false, error: activated.error };

  const keyCombo = process.platform === 'darwin' ? 'Meta+C' : 'Control+C';
  try {
    await page.keyPress(keyCombo);
  } catch (error: any) {
    return {
      ok: false,
      error: spreadsheetToolError(
        'CLIPBOARD_READ_FAILED',
        error?.message ?? 'Failed to trigger copy shortcut for selected cells.',
        { keyCombo, rangeA1 },
      ),
    };
  }

  await sleep(100);

  const clipboardResult = await bridgeResult(page, 'readClipboardText');
  if ('error' in clipboardResult) return { ok: false, error: clipboardResult.error };
  if (isClipboardFailure(clipboardResult.value)) {
    return {
      ok: false,
      error: spreadsheetToolError(
        'CLIPBOARD_READ_FAILED',
        clipboardResult.value.message || 'Clipboard read failed.',
      ),
    };
  }

  const rawText = typeof clipboardResult.value.text === 'string' ? clipboardResult.value.text : '';
  const parsedResult = await bridgeResult(page, 'parseTsv', [rawText]);
  if ('error' in parsedResult) return { ok: false, error: parsedResult.error };
  const values = normalizeStringGrid(parsedResult.value.values);
  const rawTsv = typeof parsedResult.value.rawTsv === 'string' ? parsedResult.value.rawTsv : rawText;

  const metadataResult = await bridgeResult(page, 'getSelectionMetadata');
  if ('error' in metadataResult) return { ok: false, error: metadataResult.error };

  return { ok: true, values, rawTsv, metadata: metadataResult.value };
}

async function writeRangeViaClipboard(
  page: CdpPageLike,
  rangeA1: string,
  matrix: unknown[][],
): Promise<{ ok: true } | { ok: false; error: SpreadsheetToolError }> {
  const activated = await activateRange(page, rangeA1);
  if ('error' in activated) return { ok: false, error: activated.error };

  const tsv = matrixToTsv(matrix);
  const writeResult = await bridgeResult(page, 'writeClipboardText', [tsv]);
  if ('error' in writeResult) return { ok: false, error: writeResult.error };
  if (isClipboardFailure(writeResult.value)) {
    return {
      ok: false,
      error: spreadsheetToolError(
        'CLIPBOARD_READ_FAILED',
        writeResult.value.message || 'Clipboard write failed.',
      ),
    };
  }

  const keyCombo = process.platform === 'darwin' ? 'Meta+V' : 'Control+V';
  try {
    await page.keyPress(keyCombo);
  } catch (error: any) {
    return {
      ok: false,
      error: spreadsheetToolError(
        'UNSUPPORTED_PROVIDER_STATE',
        error?.message ?? 'Failed to paste clipboard data into range.',
        { keyCombo, rangeA1 },
      ),
    };
  }

  await sleep(120);
  return { ok: true };
}

const rangeInputSchema = z.union([
  z.string().min(1).describe('A1 notation (for example A1, B2:C3, Sheet1!A1:B2, or comma-separated).'),
  z.array(z.string().min(1)).min(1).describe('List of A1 ranges.'),
]);

const renameOperationSchema = z.object({
  old_name: z.string().min(1),
  new_name: z.string().min(1),
});

const rowOperationSchema = z.object({
  position: z.number().int().min(1),
  count: z.number().int().min(1).default(1),
  sheet_name: z.string().min(1).optional(),
});

export function createSpreadsheetTools(stagehand: Stagehand) {
  return {
    get_workbook_info: tool({
      description:
        'Get workbook metadata including sheet names and active sheet when the active tab is Google Sheets or Excel Web.',
      inputSchema: z.object({}),
      execute: async () => {
        const state = await getReadySpreadsheetState(stagehand);
        if ('error' in state) return state.error;

        const workbookResult = await bridgeResult(state.page, 'getWorkbookInfo');
        if ('error' in workbookResult) return workbookResult.error;
        const payload = workbookResult.value;

        return {
          success: true,
          provider: state.provider,
          workbook_title:
            typeof payload.workbookTitle === 'string' ? payload.workbookTitle : await getPageTitle(state.page),
          total_sheets: typeof payload.total_sheets === 'number' ? payload.total_sheets : 0,
          sheet_names: Array.isArray(payload.sheet_names)
            ? payload.sheet_names.filter((entry): entry is string => typeof entry === 'string')
            : [],
          active_sheet: typeof payload.active_sheet === 'string' ? payload.active_sheet : '',
          active_selection_a1:
            typeof payload.activeSelectionA1 === 'string' ? payload.activeSelectionA1 : '',
        };
      },
    }),

    get_sheets: tool({
      description: 'Get all sheet names from the active workbook.',
      inputSchema: z.object({}),
      execute: async () => {
        const state = await getReadySpreadsheetState(stagehand);
        if ('error' in state) return state.error;

        const sheetsResult = await bridgeResult(state.page, 'getSheets');
        if ('error' in sheetsResult) return sheetsResult.error;

        const sheets = Array.isArray(sheetsResult.value)
          ? sheetsResult.value.filter((entry): entry is string => typeof entry === 'string')
          : Array.isArray((sheetsResult.value as { sheets?: unknown }).sheets)
            ? ((sheetsResult.value as { sheets: unknown[] }).sheets.filter(
                (entry): entry is string => typeof entry === 'string',
              ) as string[])
            : [];

        return {
          success: true,
          provider: state.provider,
          sheet_names: sheets,
        };
      },
    }),

    get_range_data: tool({
      description:
        'Get cell data for one or more A1 ranges. Returns a formatted table by default. Keep range size under 200 cells for best performance.',
      inputSchema: z.object({
        range_a1: rangeInputSchema,
        return_style_info: z.boolean().default(false),
        width: z.number().int().min(60).default(300),
        max_rows: z.number().int().min(1).max(500).default(100),
      }),
      execute: async ({ range_a1, return_style_info, width, max_rows }) => {
        const state = await getReadySpreadsheetState(stagehand);
        if ('error' in state) return state.error;

        const ranges = normalizeRanges(range_a1);
        if (!ranges.length) {
          return spreadsheetToolError('UNSUPPORTED_PROVIDER_STATE', 'At least one valid A1 range is required.');
        }

        const rangeResults: Array<{
          range_a1: string;
          sheet_name: string;
          start_row: number;
          values: string[][];
          raw_tsv: string;
          table: string;
        }> = [];
        let totalCells = 0;

        for (const range of ranges) {
          const dataResult = await readRangeViaClipboard(state.page, range);
          if ('error' in dataResult) return dataResult.error;

          const parsed = parseA1Range(range);
          const startRow = parsed?.startRow ?? 1;
          const sheetName =
            typeof dataResult.metadata.activeSheetName === 'string'
              ? dataResult.metadata.activeSheetName
              : parsed?.sheetName ?? '';

          totalCells += dataResult.values.reduce((acc, row) => acc + row.length, 0);
          rangeResults.push({
            range_a1: range,
            sheet_name: sheetName,
            start_row: startRow,
            values: dataResult.values,
            raw_tsv: dataResult.rawTsv,
            table: formatTable(dataResult.values, width, max_rows, startRow),
          });
        }

        if (return_style_info) {
          return {
            success: true,
            provider: state.provider,
            ranges: rangeResults.map((entry) => ({
              range_a1: entry.range_a1,
              sheet_name: entry.sheet_name,
              start_row: entry.start_row,
              values: entry.values,
              style_info: entry.values.map((row) => row.map(() => ({}))),
            })),
            total_cells: totalCells,
            warning:
              totalCells > 200
                ? `Requested ${totalCells} cells. Keep ranges under 200 cells for best performance.`
                : undefined,
          };
        }

        if (rangeResults.length === 1) {
          const only = rangeResults[0];
          return {
            success: true,
            provider: state.provider,
            range_a1: only.range_a1,
            sheet_name: only.sheet_name,
            values: only.values,
            raw_tsv: only.raw_tsv,
            table: only.table,
            total_cells: totalCells,
            warning:
              totalCells > 200
                ? `Requested ${totalCells} cells. Keep ranges under 200 cells for best performance.`
                : undefined,
          };
        }

        return {
          success: true,
          provider: state.provider,
          ranges: rangeResults,
          table: rangeResults.map((entry) => `${entry.range_a1}\n${entry.table}`).join('\n\n'),
          total_cells: totalCells,
          warning:
            totalCells > 200
              ? `Requested ${totalCells} cells. Keep ranges under 200 cells for best performance.`
              : undefined,
        };
      },
    }),

    set_range_data: tool({
      description:
        'Set values for one or more A1 ranges. Supports single values, 1D row/column fills, 2D grid fills, and formulas.',
      inputSchema: z.object({
        range_a1: rangeInputSchema,
        value: z.any().describe('Single value, 1D list, 2D list, or formula string beginning with "=".'),
      }),
      execute: async ({ range_a1, value }) => {
        const state = await getReadySpreadsheetState(stagehand);
        if ('error' in state) return state.error;

        const ranges = normalizeRanges(range_a1);
        if (!ranges.length) {
          return spreadsheetToolError('UNSUPPORTED_PROVIDER_STATE', 'At least one valid A1 range is required.');
        }

        const operations: Array<{
          range_a1: string;
          cells_set: number;
          formula: boolean;
          calculated?: string;
        }> = [];

        for (const range of ranges) {
          const dimensions = resolveRangeDimensions(range, value);
          const matrix = buildMatrix(value, dimensions.rows, dimensions.cols);
          const writeResult = await writeRangeViaClipboard(state.page, range, matrix.matrix);
          if ('error' in writeResult) return writeResult.error;

          const formula = matrixContainsFormula(matrix.matrix);
          let calculated: string | undefined;
          if (formula && matrix.rows === 1 && matrix.cols === 1) {
            const readBack = await readRangeViaClipboard(state.page, range);
            if (readBack.ok) {
              calculated = readBack.values[0]?.[0] ?? '';
            }
          }

          operations.push({
            range_a1: range,
            cells_set: matrix.rows * matrix.cols,
            formula,
            ...(calculated != null ? { calculated } : {}),
          });
        }

        return {
          success: operations.every((entry) => entry.cells_set > 0),
          provider: state.provider,
          operations,
        };
      },
    }),

    display_sheet: tool({
      description:
        'Read sheet contents as a formatted table with column headers and row numbers.',
      inputSchema: z.object({
        sheet_name: z.string().min(1).optional(),
        max_rows: z.number().int().min(1).max(500).default(50),
        width: z.number().int().min(60).default(300),
      }),
      execute: async ({ sheet_name, max_rows, width }) => {
        const state = await getReadySpreadsheetState(stagehand);
        if ('error' in state) return state.error;

        const sheetPrefix = sheet_name ? `${quoteSheetName(sheet_name)}!` : '';
        const range = `${sheetPrefix}A1:Z${max_rows}`;
        const dataResult = await readRangeViaClipboard(state.page, range);
        if ('error' in dataResult) return dataResult.error;

        const trimmed = trimEmptyGrid(dataResult.values);
        const activeSheetName =
          typeof dataResult.metadata.activeSheetName === 'string'
            ? dataResult.metadata.activeSheetName
            : sheet_name ?? '';

        return {
          success: true,
          provider: state.provider,
          sheet_name: activeSheetName,
          values: trimmed,
          table: formatTable(trimmed, width, max_rows, 1),
        };
      },
    }),

    create_sheet: tool({
      description: 'Create one or more sheets.',
      inputSchema: z.object({
        sheet_names: z.array(z.string().min(1)).min(1),
      }),
      execute: async ({ sheet_names }) => {
        const state = await getReadySpreadsheetState(stagehand);
        if ('error' in state) return state.error;

        const result = await bridgeResult(state.page, 'createSheets', [sheet_names]);
        if ('error' in result) return result.error;
        return {
          success: result.value.success === true,
          provider: state.provider,
          operations: Array.isArray(result.value.operations) ? result.value.operations : [],
          sheet_names: Array.isArray(result.value.sheetNames)
            ? result.value.sheetNames.filter((entry): entry is string => typeof entry === 'string')
            : [],
          active_sheet:
            typeof result.value.activeSheetName === 'string' ? result.value.activeSheetName : '',
        };
      },
    }),

    delete_sheet: tool({
      description: 'Delete one or more sheets by name.',
      inputSchema: z.object({
        sheet_names: z.array(z.string().min(1)).min(1),
      }),
      execute: async ({ sheet_names }) => {
        const state = await getReadySpreadsheetState(stagehand);
        if ('error' in state) return state.error;

        const result = await bridgeResult(state.page, 'deleteSheets', [sheet_names]);
        if ('error' in result) return result.error;
        return {
          success: result.value.success === true,
          provider: state.provider,
          operations: Array.isArray(result.value.operations) ? result.value.operations : [],
          sheet_names: Array.isArray(result.value.sheetNames)
            ? result.value.sheetNames.filter((entry): entry is string => typeof entry === 'string')
            : [],
          active_sheet:
            typeof result.value.activeSheetName === 'string' ? result.value.activeSheetName : '',
        };
      },
    }),

    rename_sheet: tool({
      description: 'Rename a single sheet.',
      inputSchema: z.object({
        old_name: z.string().min(1),
        new_name: z.string().min(1),
      }),
      execute: async ({ old_name, new_name }) => {
        const state = await getReadySpreadsheetState(stagehand);
        if ('error' in state) return state.error;

        const result = await bridgeResult(state.page, 'renameSheet', [old_name, new_name]);
        if ('error' in result) return result.error;
        return {
          success: result.value.success === true,
          provider: state.provider,
          old_name,
          new_name,
          sheet_names: Array.isArray(result.value.sheetNames)
            ? result.value.sheetNames.filter((entry): entry is string => typeof entry === 'string')
            : [],
        };
      },
    }),

    batch_rename_sheets: tool({
      description: 'Rename multiple sheets in one call.',
      inputSchema: z.object({
        operations: z.array(renameOperationSchema).min(1),
      }),
      execute: async ({ operations }) => {
        const state = await getReadySpreadsheetState(stagehand);
        if ('error' in state) return state.error;

        const result = await bridgeResult(state.page, 'batchRenameSheets', [operations]);
        if ('error' in result) return result.error;
        return {
          success: result.value.success === true,
          provider: state.provider,
          operations: Array.isArray(result.value.operations) ? result.value.operations : [],
          sheet_names: Array.isArray(result.value.sheetNames)
            ? result.value.sheetNames.filter((entry): entry is string => typeof entry === 'string')
            : [],
        };
      },
    }),

    insert_rows: tool({
      description: 'Insert empty rows at a 1-based row position.',
      inputSchema: rowOperationSchema,
      execute: async ({ position, count, sheet_name }) => {
        const state = await getReadySpreadsheetState(stagehand);
        if ('error' in state) return state.error;

        const result = await bridgeResult(state.page, 'mutateStructure', [
          { kind: 'row', action: 'insert', position, count, sheet_name },
        ]);
        if ('error' in result) return result.error;
        return {
          success: result.value.success === true,
          provider: state.provider,
          kind: 'row',
          action: 'insert',
          position,
          count,
          completed: typeof result.value.completed === 'number' ? result.value.completed : 0,
        };
      },
    }),

    insert_columns: tool({
      description: 'Insert empty columns at a 1-based column position.',
      inputSchema: z.object({
        position: z.number().int().min(1),
        count: z.number().int().min(1).default(1),
        sheet_name: z.string().min(1).optional(),
      }),
      execute: async ({ position, count, sheet_name }) => {
        const state = await getReadySpreadsheetState(stagehand);
        if ('error' in state) return state.error;

        const result = await bridgeResult(state.page, 'mutateStructure', [
          { kind: 'column', action: 'insert', position, count, sheet_name },
        ]);
        if ('error' in result) return result.error;
        return {
          success: result.value.success === true,
          provider: state.provider,
          kind: 'column',
          action: 'insert',
          position,
          count,
          completed: typeof result.value.completed === 'number' ? result.value.completed : 0,
        };
      },
    }),

    delete_rows: tool({
      description: 'Delete rows starting at a 1-based row position.',
      inputSchema: rowOperationSchema,
      execute: async ({ position, count, sheet_name }) => {
        const state = await getReadySpreadsheetState(stagehand);
        if ('error' in state) return state.error;

        const result = await bridgeResult(state.page, 'mutateStructure', [
          { kind: 'row', action: 'delete', position, count, sheet_name },
        ]);
        if ('error' in result) return result.error;
        return {
          success: result.value.success === true,
          provider: state.provider,
          kind: 'row',
          action: 'delete',
          position,
          count,
          completed: typeof result.value.completed === 'number' ? result.value.completed : 0,
        };
      },
    }),

    delete_columns: tool({
      description: 'Delete columns starting at a 1-based column position.',
      inputSchema: z.object({
        position: z.number().int().min(1),
        count: z.number().int().min(1).default(1),
        sheet_name: z.string().min(1).optional(),
      }),
      execute: async ({ position, count, sheet_name }) => {
        const state = await getReadySpreadsheetState(stagehand);
        if ('error' in state) return state.error;

        const result = await bridgeResult(state.page, 'mutateStructure', [
          { kind: 'column', action: 'delete', position, count, sheet_name },
        ]);
        if ('error' in result) return result.error;
        return {
          success: result.value.success === true,
          provider: state.provider,
          kind: 'column',
          action: 'delete',
          position,
          count,
          completed: typeof result.value.completed === 'number' ? result.value.completed : 0,
        };
      },
    }),

    batch_insert_rows: tool({
      description: 'Insert rows at multiple positions.',
      inputSchema: z.object({
        operations: z.array(rowOperationSchema).min(1),
      }),
      execute: async ({ operations }) => {
        const state = await getReadySpreadsheetState(stagehand);
        if ('error' in state) return state.error;

        const results: Array<Record<string, unknown>> = [];
        for (const operation of operations) {
          const result = await bridgeResult(state.page, 'mutateStructure', [
            {
              kind: 'row',
              action: 'insert',
              position: operation.position,
              count: operation.count,
              sheet_name: operation.sheet_name,
            },
          ]);
          if ('error' in result) return result.error;
          results.push({
            position: operation.position,
            count: operation.count,
            sheet_name: operation.sheet_name ?? '',
            success: result.value.success === true,
            completed: typeof result.value.completed === 'number' ? result.value.completed : 0,
          });
        }

        return {
          success: results.every((entry) => entry.success === true),
          provider: state.provider,
          operations: results,
        };
      },
    }),
  };
}

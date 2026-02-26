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
import { EXCEL_TOOL_PREFIX, SHEETS_TOOL_PREFIX } from './constants';

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

  let activeSheetName =
    typeof activation.value.activeSheetName === 'string' ? activation.value.activeSheetName : undefined;
  let activeSelectionA1 =
    typeof activation.value.activeSelectionA1 === 'string' ? activation.value.activeSelectionA1 : undefined;

  if (activation.value.nameBoxStillFocused === true) {
    try {
      await page.keyPress('Enter');
    } catch (error: any) {
      return {
        ok: false,
        error: spreadsheetToolError(
          'UNSUPPORTED_PROVIDER_STATE',
          error?.message ?? `Failed to confirm range activation for ${rangeA1}.`,
          { rangeA1 },
        ),
      };
    }
    await sleep(90);

    const metadata = await bridgeResult(page, 'getSelectionMetadata');
    if ('error' in metadata) return { ok: false, error: metadata.error };
    if (typeof metadata.value.activeSheetName === 'string') {
      activeSheetName = metadata.value.activeSheetName;
    }
    if (typeof metadata.value.activeSelectionA1 === 'string') {
      activeSelectionA1 = metadata.value.activeSelectionA1;
    }
  }

  return {
    ok: true,
    activeSheetName,
    activeSelectionA1,
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

type SpreadsheetToolPrefix = typeof SHEETS_TOOL_PREFIX | typeof EXCEL_TOOL_PREFIX;

const READ_SHEET_ROW_WINDOW = 20;
const READ_SHEET_COLUMN_LIMIT = 26;

const PROVIDER_BY_PREFIX: Record<SpreadsheetToolPrefix, SpreadsheetProvider> = {
  [SHEETS_TOOL_PREFIX]: 'google_sheets',
  [EXCEL_TOOL_PREFIX]: 'excel_web',
};

const cellInputSchema = z.object({
  cell_a1: z
    .string()
    .min(1)
    .describe('Single A1 cell reference (for example A1 or Sheet1!B2).'),
});

const setCellInputSchema = z.object({
  cell_a1: z
    .string()
    .min(1)
    .describe('Single A1 cell reference (for example A1 or Sheet1!B2).'),
  value: z.any().describe('Cell value to write. Formulas should start with "=".'),
});

const readSheetInputSchema = z.object({
  sheet_name: z.string().min(1).optional(),
  start_row: z
    .number()
    .int()
    .min(1)
    .default(1)
    .describe('1-based starting row. Reads exactly 20 rows from this row.'),
  width: z.number().int().min(60).default(300),
});

const insertRowsInputSchema = z.object({
  position: z.number().int().min(1),
  count: z.number().int().min(1).default(1),
  sheet_name: z.string().min(1).optional(),
});

const insertColumnsInputSchema = z.object({
  position: z.number().int().min(1),
  count: z.number().int().min(1).default(1),
  sheet_name: z.string().min(1).optional(),
});

const deleteRowInputSchema = z.object({
  position: z.number().int().min(1),
  sheet_name: z.string().min(1).optional(),
});

const deleteColumnInputSchema = z.object({
  position: z.number().int().min(1),
  sheet_name: z.string().min(1).optional(),
});

function toPrefixedToolName(prefix: SpreadsheetToolPrefix, baseName: string): string {
  return `${prefix}_${baseName}`;
}

function providerDisplayName(provider: SpreadsheetProvider): string {
  return provider === 'google_sheets' ? 'Google Sheets' : 'Excel Web';
}

async function getReadySpreadsheetStateForPrefix(
  stagehand: Stagehand,
  prefix: SpreadsheetToolPrefix,
): Promise<
  | { page: CdpPageLike; provider: SpreadsheetProvider; url: string }
  | { error: SpreadsheetToolError }
> {
  const state = await getReadySpreadsheetState(stagehand);
  if ('error' in state) return state;

  const expectedProvider = PROVIDER_BY_PREFIX[prefix];
  if (state.provider !== expectedProvider) {
    return {
      error: spreadsheetToolError(
        'UNSUPPORTED_PROVIDER_STATE',
        `${prefix}_* tools require ${providerDisplayName(expectedProvider)}. Active provider is ${providerDisplayName(state.provider)}.`,
      ),
    };
  }

  return state;
}

function resolveActiveSheetName(
  metadata: Record<string, unknown>,
  parsedRange: ParsedRange | null,
  requestedSheetName?: string,
): string {
  if (typeof metadata.activeSheetName === 'string') return metadata.activeSheetName;
  if (parsedRange?.sheetName) return parsedRange.sheetName;
  if (requestedSheetName) return requestedSheetName;
  return '';
}

function assertSingleCellRange(cellA1: string): ParsedRange | null {
  const parsed = parseA1Range(cellA1);
  if (!parsed) return null;
  if (parsed.rows !== 1 || parsed.cols !== 1) return null;
  return parsed;
}

function normalizeSingleCellA1(value: string): string | null {
  const parsed = assertSingleCellRange(value);
  if (!parsed) return null;
  return `${columnNumberToLetters(parsed.startCol)}${parsed.startRow}`;
}

function createPrefixedSpreadsheetTools(stagehand: Stagehand, prefix: SpreadsheetToolPrefix) {
  return {
    [toPrefixedToolName(prefix, 'read_cell')]: tool({
      description: 'Read a single cell value.',
      inputSchema: cellInputSchema,
      execute: async ({ cell_a1 }) => {
        const state = await getReadySpreadsheetStateForPrefix(stagehand, prefix);
        if ('error' in state) return state.error;

        const parsed = assertSingleCellRange(cell_a1);
        if (!parsed) {
          return spreadsheetToolError(
            'UNSUPPORTED_PROVIDER_STATE',
            'cell_a1 must be a single cell reference (for example A1 or Sheet1!B2).',
            { cell_a1 },
          );
        }

        const dataResult = await readRangeViaClipboard(state.page, cell_a1.trim());
        if ('error' in dataResult) return dataResult.error;

        return {
          success: true,
          provider: state.provider,
          cell_a1: cell_a1.trim(),
          sheet_name: resolveActiveSheetName(dataResult.metadata, parsed),
          value: dataResult.values[0]?.[0] ?? '',
        };
      },
    }),

    [toPrefixedToolName(prefix, 'set_cell')]: tool({
      description: 'Set a single cell value.',
      inputSchema: setCellInputSchema,
      execute: async ({ cell_a1, value }) => {
        const state = await getReadySpreadsheetStateForPrefix(stagehand, prefix);
        if ('error' in state) return state.error;

        const parsed = assertSingleCellRange(cell_a1);
        if (!parsed) {
          return spreadsheetToolError(
            'UNSUPPORTED_PROVIDER_STATE',
            'cell_a1 must be a single cell reference (for example A1 or Sheet1!B2).',
            { cell_a1 },
          );
        }

        const writeResult = await writeRangeViaClipboard(state.page, cell_a1.trim(), [[value]]);
        if ('error' in writeResult) return writeResult.error;

        const readBack = await readRangeViaClipboard(state.page, cell_a1.trim());
        if ('error' in readBack) return readBack.error;

        return {
          success: true,
          provider: state.provider,
          cell_a1: cell_a1.trim(),
          sheet_name: resolveActiveSheetName(readBack.metadata, parsed),
          value: readBack.values[0]?.[0] ?? '',
        };
      },
    }),

    [toPrefixedToolName(prefix, 'select_cell')]: tool({
      description: 'Select and focus a single cell.',
      inputSchema: cellInputSchema,
      execute: async ({ cell_a1 }) => {
        const state = await getReadySpreadsheetStateForPrefix(stagehand, prefix);
        if ('error' in state) return state.error;

        const parsed = assertSingleCellRange(cell_a1);
        if (!parsed) {
          return spreadsheetToolError(
            'UNSUPPORTED_PROVIDER_STATE',
            'cell_a1 must be a single cell reference (for example A1 or Sheet1!B2).',
            { cell_a1 },
          );
        }

        const activationResult = await activateRange(state.page, cell_a1.trim());
        if ('error' in activationResult) return activationResult.error;

        const expectedSelection = normalizeSingleCellA1(cell_a1.trim());
        const actualSelection = normalizeSingleCellA1(activationResult.activeSelectionA1 ?? '');
        if (expectedSelection && actualSelection && expectedSelection !== actualSelection) {
          return spreadsheetToolError(
            'UNSUPPORTED_PROVIDER_STATE',
            `Tried to select ${expectedSelection}, but active selection is ${actualSelection}.`,
            {
              requested_cell_a1: cell_a1.trim(),
              active_selection_a1: activationResult.activeSelectionA1 ?? '',
            },
          );
        }

        return {
          success: true,
          provider: state.provider,
          cell_a1: cell_a1.trim(),
          sheet_name: activationResult.activeSheetName ?? parsed.sheetName ?? '',
          active_selection_a1: activationResult.activeSelectionA1 ?? '',
        };
      },
    }),

    [toPrefixedToolName(prefix, 'get_workbook_info')]: tool({
      description: 'Get workbook metadata including sheets and active selection.',
      inputSchema: z.object({}),
      execute: async () => {
        const state = await getReadySpreadsheetStateForPrefix(stagehand, prefix);
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

    [toPrefixedToolName(prefix, 'read_sheet')]: tool({
      description: 'Read a 20-row window from the active sheet or provided sheet name.',
      inputSchema: readSheetInputSchema,
      execute: async ({ sheet_name, start_row, width }) => {
        const state = await getReadySpreadsheetStateForPrefix(stagehand, prefix);
        if ('error' in state) return state.error;

        const endRow = start_row + READ_SHEET_ROW_WINDOW - 1;
        const lastColumnLetter = columnNumberToLetters(READ_SHEET_COLUMN_LIMIT);
        const sheetPrefix = sheet_name ? `${quoteSheetName(sheet_name)}!` : '';
        const rangeA1 = `${sheetPrefix}A${start_row}:${lastColumnLetter}${endRow}`;
        const dataResult = await readRangeViaClipboard(state.page, rangeA1);
        if ('error' in dataResult) return dataResult.error;

        const trimmedValues = trimEmptyGrid(dataResult.values);

        return {
          success: true,
          provider: state.provider,
          range_a1: rangeA1,
          sheet_name: resolveActiveSheetName(dataResult.metadata, null, sheet_name),
          start_row,
          end_row: endRow,
          row_window_size: READ_SHEET_ROW_WINDOW,
          values: trimmedValues,
          table: formatTable(trimmedValues, width, READ_SHEET_ROW_WINDOW, start_row),
        };
      },
    }),

    [toPrefixedToolName(prefix, 'insert_rows')]: tool({
      description: 'Insert one or more rows at a 1-based row position.',
      inputSchema: insertRowsInputSchema,
      execute: async ({ position, count, sheet_name }) => {
        const state = await getReadySpreadsheetStateForPrefix(stagehand, prefix);
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

    [toPrefixedToolName(prefix, 'insert_columns')]: tool({
      description: 'Insert one or more columns at a 1-based column position.',
      inputSchema: insertColumnsInputSchema,
      execute: async ({ position, count, sheet_name }) => {
        const state = await getReadySpreadsheetStateForPrefix(stagehand, prefix);
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

    [toPrefixedToolName(prefix, 'delete_row')]: tool({
      description: 'Delete one row at a 1-based row position.',
      inputSchema: deleteRowInputSchema,
      execute: async ({ position, sheet_name }) => {
        const state = await getReadySpreadsheetStateForPrefix(stagehand, prefix);
        if ('error' in state) return state.error;

        const result = await bridgeResult(state.page, 'mutateStructure', [
          { kind: 'row', action: 'delete', position, count: 1, sheet_name },
        ]);
        if ('error' in result) return result.error;

        return {
          success: result.value.success === true,
          provider: state.provider,
          kind: 'row',
          action: 'delete',
          position,
          completed: typeof result.value.completed === 'number' ? result.value.completed : 0,
        };
      },
    }),

    [toPrefixedToolName(prefix, 'delete_column')]: tool({
      description: 'Delete one column at a 1-based column position.',
      inputSchema: deleteColumnInputSchema,
      execute: async ({ position, sheet_name }) => {
        const state = await getReadySpreadsheetStateForPrefix(stagehand, prefix);
        if ('error' in state) return state.error;

        const result = await bridgeResult(state.page, 'mutateStructure', [
          { kind: 'column', action: 'delete', position, count: 1, sheet_name },
        ]);
        if ('error' in result) return result.error;

        return {
          success: result.value.success === true,
          provider: state.provider,
          kind: 'column',
          action: 'delete',
          position,
          completed: typeof result.value.completed === 'number' ? result.value.completed : 0,
        };
      },
    }),
  };
}

export function createSpreadsheetTools(stagehand: Stagehand) {
  return {
    ...createPrefixedSpreadsheetTools(stagehand, SHEETS_TOOL_PREFIX),
    ...createPrefixedSpreadsheetTools(stagehand, EXCEL_TOOL_PREFIX),
  };
}

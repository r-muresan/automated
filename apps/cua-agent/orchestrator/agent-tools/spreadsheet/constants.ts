import type { SpreadsheetProvider } from '../types';

export const SPREADSHEET_BASE_TOOL_NAMES = [
  'read_cell',
  'set_cell',
  'select_cell',
  'get_workbook_info',
  'read_sheet',
  'insert_rows',
  'insert_columns',
  'delete_row',
  'delete_column',
] as const;

export const SHEETS_TOOL_PREFIX = 'sheets';
export const EXCEL_TOOL_PREFIX = 'excel';

export const SHEETS_TOOL_NAMES = SPREADSHEET_BASE_TOOL_NAMES.map(
  (name) => `${SHEETS_TOOL_PREFIX}_${name}`,
);
export const EXCEL_TOOL_NAMES = SPREADSHEET_BASE_TOOL_NAMES.map(
  (name) => `${EXCEL_TOOL_PREFIX}_${name}`,
);

export const SPREADSHEET_TOOL_NAMES = [...SHEETS_TOOL_NAMES, ...EXCEL_TOOL_NAMES] as const;

export function getSpreadsheetToolNamesForProvider(provider: SpreadsheetProvider): readonly string[] {
  return provider === 'google_sheets' ? SHEETS_TOOL_NAMES : EXCEL_TOOL_NAMES;
}

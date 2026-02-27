/**
 * Shared TypeScript utilities used by both spreadsheet tools (tools.ts)
 * and extraction (extraction/spreadsheet.ts).
 */

export function normalizeStringGrid(values: unknown): string[][] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => row.map((cell) => (cell == null ? '' : typeof cell === 'string' ? cell : String(cell))));
}

export function trimEmptyGrid(values: string[][]): string[][] {
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

export function escapePipeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function quoteSheetName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^[A-Za-z0-9_]+$/.test(trimmed)) return trimmed;
  return `'${trimmed.replace(/'/g, "''")}'`;
}

export function unquoteSheetName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

export function splitRangeReference(value: string): { sheetName: string; rangePart: string } {
  const trimmed = value.trim();
  const bangIndex = trimmed.lastIndexOf('!');
  if (bangIndex < 0) return { sheetName: '', rangePart: trimmed };
  return {
    sheetName: unquoteSheetName(trimmed.slice(0, bangIndex)),
    rangePart: trimmed.slice(bangIndex + 1).trim(),
  };
}

export function columnNumberToLetters(index: number): string {
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

export function lettersToColumnNumber(letters: string): number {
  let value = 0;
  for (const char of letters.toUpperCase()) {
    const code = char.charCodeAt(0);
    if (code < 65 || code > 90) return NaN;
    value = value * 26 + (code - 64);
  }
  return value;
}

export function parseCellAddress(value: string): { col: number; row: number } | null {
  const match = /^\$?([A-Za-z]{1,5})\$?(\d{1,7})$/.exec(value.trim());
  if (!match) return null;
  const col = lettersToColumnNumber(match[1]);
  const row = Number(match[2]);
  if (!Number.isFinite(col) || !Number.isFinite(row) || col < 1 || row < 1) return null;
  return { col, row };
}

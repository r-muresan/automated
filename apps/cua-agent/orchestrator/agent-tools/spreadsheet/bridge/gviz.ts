/**
 * Google Sheets /gviz/tq fetch-based data reading.
 * Provides a clipboard-free way to read spreadsheet data by fetching
 * CSV output from Google's visualization query endpoint.
 */

import type { Protocol } from 'devtools-protocol';
import type { CdpPageLike } from '../../types';

export function extractSheetId(url: string): string | null {
  const match = /\/spreadsheets\/d\/([^/]+)/i.exec(url);
  return match ? match[1] : null;
}

/**
 * RFC 4180 CSV parser → string[][].
 */
export function parseGvizCsv(csvText: string): string[][] {
  const raw = typeof csvText === 'string' ? csvText : '';
  if (!raw) return [];

  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < normalized.length) {
    const ch = normalized[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < normalized.length && normalized[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field.length === 0) {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  row.push(field);
  if (row.length > 0 || field.length > 0) {
    rows.push(row);
  }

  return rows;
}

function buildGvizUrl(sheetId: string, sheetName: string, rangeA1: string): string {
  const base = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq`;
  const params = new URLSearchParams({ tqx: 'out:csv' });
  if (sheetName) {
    params.set('sheet', sheetName);
  }
  if (rangeA1) {
    params.set('range', rangeA1);
  }
  return `${base}?${params.toString()}`;
}

/**
 * Read spreadsheet data via Google's /gviz/tq endpoint.
 * Executes a fetch() inside the page context to leverage the user's session cookies.
 */
export async function readRangeViaGviz(
  page: CdpPageLike,
  sheetName: string,
  rangeA1: string,
): Promise<{ ok: true; values: string[][] } | { ok: false; message: string }> {
  const pageUrl = page.url();
  const sheetId = extractSheetId(pageUrl);
  if (!sheetId) {
    return { ok: false, message: 'Could not extract Google Sheets document ID from URL.' };
  }

  const gvizUrl = buildGvizUrl(sheetId, sheetName, rangeA1);

  const expression = `(async () => {
    try {
      const response = await fetch(${JSON.stringify(gvizUrl)}, { credentials: 'include' });
      if (!response.ok) {
        return { ok: false, message: 'gviz fetch failed: HTTP ' + response.status };
      }
      const text = await response.text();
      return { ok: true, text };
    } catch (error) {
      return { ok: false, message: error && error.message ? String(error.message) : 'gviz fetch failed' };
    }
  })()`;

  try {
    const response = await page.sendCDP<Protocol.Runtime.EvaluateResponse>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });

    if (response.exceptionDetails) {
      return { ok: false, message: response.exceptionDetails.text || 'gviz evaluation failed' };
    }

    const result = response.result?.value as { ok?: boolean; text?: string; message?: string } | undefined;
    if (!result || result.ok !== true || typeof result.text !== 'string') {
      return { ok: false, message: result?.message || 'gviz returned invalid response' };
    }

    const values = parseGvizCsv(result.text);
    return { ok: true, values };
  } catch (error: any) {
    return { ok: false, message: error?.message ?? 'gviz fetch failed' };
  }
}

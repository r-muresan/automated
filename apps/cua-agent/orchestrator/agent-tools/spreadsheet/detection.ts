import type { SpreadsheetProvider } from '../types';

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function isGoogleSheetsUrl(url: string): boolean {
  const parsed = parseUrl(url);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  return (host === 'docs.google.com' || host === 'sheets.google.com') && path.includes('/spreadsheets');
}

export function isExcelWebUrl(url: string): boolean {
  const parsed = parseUrl(url);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  const fullPath = `${parsed.pathname}${parsed.search}${parsed.hash}`.toLowerCase();

  if (host === 'excel.office.com') return true;
  if (host === 'office.live.com' && fullPath.includes('excel')) return true;
  if ((host === 'www.office.com' || host === 'office.com') && fullPath.includes('excel')) return true;
  return false;
}

export function getSpreadsheetProvider(url: string): SpreadsheetProvider | null {
  if (isGoogleSheetsUrl(url)) return 'google_sheets';
  if (isExcelWebUrl(url)) return 'excel_web';
  return null;
}

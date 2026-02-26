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
  const path = parsed.pathname;
  if (host !== 'docs.google.com' && host !== 'sheets.google.com') return false;

  // Only treat URLs with a concrete sheet document id as spreadsheet pages.
  // Example: /spreadsheets/d/<id>/edit
  return /^\/spreadsheets\/d\/[^/]+(?:\/|$)/i.test(path);
}

export function isExcelWebUrl(url: string): boolean {
  const parsed = parseUrl(url);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  const query = parsed.search.toLowerCase();
  const hash = parsed.hash.toLowerCase();

  const isExcelHost =
    host === 'excel.office.com' ||
    host === 'excel.officeapps.live.com' ||
    /^excel\\.[a-z0-9.-]*officeapps\\.live\\.com$/i.test(host) ||
    host === 'excel.cloud.microsoft' ||
    host === 'office.live.com' ||
    host === 'www.office.com' ||
    host === 'office.com';
  if (!isExcelHost) return false;

  // Require workbook-specific markers so we don't enable tools on home/start pages.
  const workbookParamKeys = ['docid', 'resid', 'id', 'file', 'wopisrc', 'itemid', 'driveid'];
  const hasWorkbookQueryParam = workbookParamKeys.some(
    (key) => parsed.searchParams.has(key) || query.includes(`${key}=`),
  );
  const hasWorkbookHashParam = workbookParamKeys.some((key) => hash.includes(`${key}=`));
  const hasWorkbookPathMarker =
    /^\/open\/(onedrive|sharepoint)\//.test(path) ||
    /^\/x\//.test(path) ||
    path.includes('xlviewer') ||
    path.includes('/workbook');

  return hasWorkbookQueryParam || hasWorkbookHashParam || hasWorkbookPathMarker;
}

export function getSpreadsheetProvider(url: string): SpreadsheetProvider | null {
  if (isGoogleSheetsUrl(url)) return 'google_sheets';
  if (isExcelWebUrl(url)) return 'excel_web';
  return null;
}

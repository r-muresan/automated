import type { Protocol } from 'devtools-protocol';
import type { Stagehand } from '../../../stagehand/v3';
import { getSpreadsheetProvider } from './detection';
import { getActivePage, getPageUrl } from '../page-utils';
import type {
  BridgeRunResult,
  CdpPageLike,
  SpreadsheetErrorCode,
  SpreadsheetPageState,
  SpreadsheetToolError,
} from '../types';

const SPREADSHEET_BRIDGE_VERSION = '1.0.0';
const SPREADSHEET_BRIDGE_GLOBAL = '__cuaSpreadsheetBridge';
const SPREADSHEET_BRIDGE_SCRIPT = `(() => {
  const version = ${JSON.stringify(SPREADSHEET_BRIDGE_VERSION)};
  const globalName = ${JSON.stringify(SPREADSHEET_BRIDGE_GLOBAL)};

  if (
    globalThis[globalName] &&
    typeof globalThis[globalName] === 'object' &&
    globalThis[globalName].version === version
  ) {
    return;
  }

  const parseUrl = () => {
    try {
      return new URL(window.location.href);
    } catch {
      return null;
    }
  };

  const detectProvider = () => {
    const parsed = parseUrl();
    if (!parsed) return null;
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    const full = path + parsed.search.toLowerCase() + parsed.hash.toLowerCase();

    if ((host === 'docs.google.com' || host === 'sheets.google.com') && path.includes('/spreadsheets')) {
      return 'google_sheets';
    }

    if (host === 'excel.office.com') return 'excel_web';
    if (host === 'office.live.com' && full.includes('excel')) return 'excel_web';
    if ((host === 'www.office.com' || host === 'office.com') && full.includes('excel')) return 'excel_web';

    return null;
  };

  const queryAllSafe = (selector) => {
    try {
      return Array.from(document.querySelectorAll(selector));
    } catch {
      return [];
    }
  };

  const textOf = (node) => {
    if (!node) return '';
    const text = (node.textContent || '').replace(/\\s+/g, ' ').trim();
    return text;
  };

  const valueOf = (node) => {
    if (!node) return '';
    try {
      if ('value' in node && typeof node.value === 'string') {
        return node.value.trim();
      }
    } catch {}
    return textOf(node);
  };

  const findFirstValue = (selectors) => {
    for (const selector of selectors) {
      const node = queryAllSafe(selector)[0];
      const value = valueOf(node);
      if (value) return value;
    }
    return '';
  };

  const collectSheetTabElements = () => {
    const selectors = [
      '.docs-sheet-tab[role="tab"]',
      '.docs-sheet-tab',
      '[role="tab"][data-automationid*="SheetTab"]',
      '[role="tab"][id*="sheet-tab"]',
      '[role="tab"][id*="SheetTab"]',
      '[role="tab"][aria-label*="sheet"]',
    ];

    const dedup = new Set();
    const nodes = [];
    for (const selector of selectors) {
      for (const element of queryAllSafe(selector)) {
        if (!element || dedup.has(element)) continue;
        dedup.add(element);
        nodes.push(element);
      }
    }
    return nodes;
  };

  const normalizeSheetName = (value) => {
    if (!value) return '';
    const trimmed = value.trim();
    if (!trimmed) return '';
    if (trimmed === '+' || trimmed === 'Add sheet' || trimmed === 'Add Sheet') return '';
    return trimmed;
  };

  const getSheetNameFromTab = (tab) => {
    if (!tab) return '';
    const tabLocal = (() => {
      try {
        return Array.from(tab.querySelectorAll('.docs-sheet-tab-name, [data-automationid*="SheetTab"]'));
      } catch {
        return [];
      }
    })();
    const candidateNodes = [tab, ...tabLocal];

    for (const node of candidateNodes) {
      if (!node) continue;
      const value = normalizeSheetName(valueOf(node));
      if (value) return value;
      const aria = normalizeSheetName(node.getAttribute?.('aria-label') || '');
      if (aria) return aria;
    }
    return '';
  };

  const getActiveSheetName = () => {
    const tabs = collectSheetTabElements();
    const selected = tabs.find((tab) => {
      const ariaSelected = String(tab.getAttribute?.('aria-selected') || '').toLowerCase();
      if (ariaSelected === 'true') return true;
      const classes = String(tab.className || '').toLowerCase();
      return classes.includes('active') || classes.includes('selected');
    });

    if (selected) {
      const selectedName = getSheetNameFromTab(selected);
      if (selectedName) return selectedName;
    }

    for (const tab of tabs) {
      const name = getSheetNameFromTab(tab);
      if (name) return name;
    }

    return '';
  };

  const listSheets = () => {
    const tabs = collectSheetTabElements();
    const names = [];
    const dedup = new Set();

    for (const tab of tabs) {
      const name = getSheetNameFromTab(tab);
      if (!name || dedup.has(name)) continue;
      dedup.add(name);
      names.push(name);
    }

    return names;
  };

  const getSelectionA1 = (provider) => {
    const shared = [
      '#t-name-box',
      'input[aria-label="Name box"]',
      'input[aria-label*="Name box"]',
      'input[aria-label*="Name Box"]',
      'input[id*="NameBox"]',
      'input[data-automationid*="NameBox"]',
      '[data-automationid*="NameBox"] input',
    ];
    const value = findFirstValue(shared);
    if (value) return value;

    if (provider === 'google_sheets') {
      return findFirstValue(['input[aria-label*="range"]', 'input[aria-label*="Range"]']);
    }

    return '';
  };

  const getWorkbookTitle = (provider) => {
    const title = (document.title || '').trim();
    if (!title) return '';
    if (provider === 'google_sheets') return title.replace(/\\s*-\\s*Google Sheets.*$/i, '').trim();
    if (provider === 'excel_web') return title.replace(/\\s*-\\s*Excel.*$/i, '').trim();
    return title;
  };

  const detectContext = () => {
    const provider = detectProvider();
    const url = window.location.href;
    const isSpreadsheet = provider !== null;
    return {
      provider,
      url,
      isSpreadsheet,
      workbookTitle: provider ? getWorkbookTitle(provider) : '',
      activeSheetName: provider ? getActiveSheetName() : '',
      activeSelectionA1: provider ? getSelectionA1(provider) : '',
    };
  };

  const getSelectionMetadata = () => {
    const context = detectContext();
    return {
      provider: context.provider,
      activeSheetName: context.activeSheetName,
      activeSelectionA1: context.activeSelectionA1,
    };
  };

  const readClipboardText = async () => {
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
        return {
          success: false,
          errorCode: 'CLIPBOARD_READ_FAILED',
          message: 'Clipboard readText API is unavailable in this browser context.',
        };
      }
      const text = await navigator.clipboard.readText();
      return { success: true, text: typeof text === 'string' ? text : '' };
    } catch (error) {
      return {
        success: false,
        errorCode: 'CLIPBOARD_READ_FAILED',
        message: error && error.message ? String(error.message) : 'Clipboard read failed.',
      };
    }
  };

  const parseTsv = (tsv) => {
    const rawTsv = typeof tsv === 'string' ? tsv : '';
    if (!rawTsv) {
      return { values: [], rawTsv };
    }
    const rows = rawTsv
      .replace(/\\r\\n/g, '\\n')
      .replace(/\\r/g, '\\n')
      .split('\\n')
      .map((line) => line.split('\\t'));
    return { values: rows, rawTsv };
  };

  globalThis[globalName] = {
    version,
    detectContext,
    listSheets: () => {
      const context = detectContext();
      return {
        provider: context.provider,
        sheets: listSheets(),
        activeSheetName: context.activeSheetName,
      };
    },
    getSelectionMetadata,
    readClipboardText,
    parseTsv,
  };
})();`;

export function spreadsheetToolError(
  code: SpreadsheetErrorCode,
  message: string,
  details?: Record<string, unknown>,
): SpreadsheetToolError {
  return {
    success: false,
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  };
}

export async function getSpreadsheetPageState(stagehand: Stagehand): Promise<SpreadsheetPageState> {
  const page = getActivePage(stagehand);
  if (!page) {
    return {
      error: spreadsheetToolError(
        'UNSUPPORTED_PROVIDER_STATE',
        'No active page is available for spreadsheet inspection.',
      ),
    };
  }

  const url = getPageUrl(page);
  const provider = getSpreadsheetProvider(url);
  console.log(
    `[ORCHESTRATOR] Spreadsheet provider detection: provider=${provider ?? 'none'} url="${url}"`,
  );

  if (!provider) {
    return {
      error: spreadsheetToolError(
        'NOT_SPREADSHEET_PAGE',
        'Active tab is not Google Sheets or Excel Web.',
        { url },
      ),
    };
  }

  return { page, url, provider };
}

async function readBridgeVersion(page: CdpPageLike): Promise<string | null> {
  try {
    const response = await page.sendCDP<Protocol.Runtime.EvaluateResponse>('Runtime.evaluate', {
      expression: `globalThis.${SPREADSHEET_BRIDGE_GLOBAL}?.version ?? null`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.exceptionDetails) return null;
    const value = response.result?.value;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

export async function ensureSpreadsheetBridge(page: CdpPageLike): Promise<void> {
  const currentVersion = await readBridgeVersion(page);
  if (currentVersion === SPREADSHEET_BRIDGE_VERSION) {
    console.log('[ORCHESTRATOR] Spreadsheet bridge: already ready');
    return;
  }

  console.log('[ORCHESTRATOR] Spreadsheet bridge: injecting CDP script');
  await page.sendCDP('Page.addScriptToEvaluateOnNewDocument', {
    source: SPREADSHEET_BRIDGE_SCRIPT,
  });

  const injectionResult = await page.sendCDP<Protocol.Runtime.EvaluateResponse>('Runtime.evaluate', {
    expression: SPREADSHEET_BRIDGE_SCRIPT,
    returnByValue: true,
    awaitPromise: true,
  });

  if (injectionResult.exceptionDetails) {
    throw new Error(injectionResult.exceptionDetails.text || 'Bridge runtime evaluation failed');
  }

  const injectedVersion = await readBridgeVersion(page);
  if (injectedVersion !== SPREADSHEET_BRIDGE_VERSION) {
    throw new Error('Bridge was not detected after script injection');
  }

  console.log('[ORCHESTRATOR] Spreadsheet bridge: ready');
}

function normalizeBridgeErrorCode(input: unknown): SpreadsheetErrorCode {
  const value = typeof input === 'string' ? input : '';
  if (value === 'CLIPBOARD_READ_FAILED') return 'CLIPBOARD_READ_FAILED';
  if (value === 'NOT_SPREADSHEET_PAGE') return 'NOT_SPREADSHEET_PAGE';
  if (value === 'BRIDGE_INJECTION_FAILED') return 'BRIDGE_INJECTION_FAILED';
  return 'UNSUPPORTED_PROVIDER_STATE';
}

export async function runBridge(
  page: CdpPageLike,
  method: string,
  args: unknown[] = [],
): Promise<BridgeRunResult> {
  const expression = `(() => {
    try {
      const bridge = globalThis.${SPREADSHEET_BRIDGE_GLOBAL};
      if (!bridge || typeof bridge[${JSON.stringify(method)}] !== 'function') {
        return {
          ok: false,
          error: {
            code: 'UNSUPPORTED_PROVIDER_STATE',
            message: 'Spreadsheet bridge method is unavailable: ${method}'
          }
        };
      }
      return Promise.resolve(bridge[${JSON.stringify(method)}](...${JSON.stringify(args)}))
        .then((value) => ({ ok: true, value }))
        .catch((error) => ({
          ok: false,
          error: {
            code: 'UNSUPPORTED_PROVIDER_STATE',
            message: error && error.message ? String(error.message) : String(error)
          }
        }));
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'UNSUPPORTED_PROVIDER_STATE',
          message: error && error.message ? String(error.message) : String(error)
        }
      };
    }
  })()`;

  try {
    const response = await page.sendCDP<Protocol.Runtime.EvaluateResponse>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });

    if (response.exceptionDetails) {
      return {
        ok: false,
        error: {
          code: 'UNSUPPORTED_PROVIDER_STATE',
          message: response.exceptionDetails.text || `Bridge call "${method}" failed`,
        },
      };
    }

    const value = response.result?.value;
    if (!value || typeof value !== 'object') {
      return {
        ok: false,
        error: {
          code: 'UNSUPPORTED_PROVIDER_STATE',
          message: `Bridge call "${method}" returned an invalid payload`,
        },
      };
    }

    if ((value as { ok?: boolean }).ok === true) {
      return { ok: true, value: (value as { value: unknown }).value };
    }

    const error = (value as { error?: { code?: unknown; message?: unknown } }).error;
    return {
      ok: false,
      error: {
        code: normalizeBridgeErrorCode(error?.code),
        message:
          typeof error?.message === 'string'
            ? error.message
            : `Bridge call "${method}" returned an error`,
      },
    };
  } catch (error: any) {
    return {
      ok: false,
      error: {
        code: 'UNSUPPORTED_PROVIDER_STATE',
        message: error?.message ?? `Bridge call "${method}" failed`,
      },
    };
  }
}

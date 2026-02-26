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

const SPREADSHEET_BRIDGE_VERSION = '2.1.0';
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
    const path = parsed.pathname;
    const pathLower = path.toLowerCase();
    const query = parsed.search.toLowerCase();
    const hash = parsed.hash.toLowerCase();

    if (
      (host === 'docs.google.com' || host === 'sheets.google.com') &&
      /^\\/spreadsheets\\/d\\/[^/]+(?:\\/|$)/i.test(path)
    ) {
      return 'google_sheets';
    }

    const isExcelHost =
      host === 'excel.office.com' ||
      host === 'excel.cloud.microsoft' ||
      host === 'office.live.com' ||
      host === 'www.office.com' ||
      host === 'office.com';
    if (!isExcelHost) return null;

    const workbookParamKeys = ['docid', 'resid', 'id', 'file', 'wopisrc', 'itemid', 'driveid'];
    const hasWorkbookQueryParam = workbookParamKeys.some(
      (key) => parsed.searchParams.has(key) || query.includes(key + '=')
    );
    const hasWorkbookHashParam = workbookParamKeys.some((key) => hash.includes(key + '='));
    const hasWorkbookPathMarker =
      /^\\/open\\/(onedrive|sharepoint)\\//.test(pathLower) ||
      /^\\/x\\//.test(pathLower) ||
      pathLower.includes('xlviewer') ||
      pathLower.includes('/workbook');

    if (hasWorkbookQueryParam || hasWorkbookHashParam || hasWorkbookPathMarker) {
      return 'excel_web';
    }

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

  const wait = (ms) =>
    new Promise((resolve) => setTimeout(resolve, Number.isFinite(ms) ? Math.max(0, ms) : 0));

  const isVisible = (node) => {
    if (!node || typeof node.getBoundingClientRect !== 'function') return false;
    const rect = node.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(node);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };

  const normalizeText = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();

  const quoteSheetName = (name) => {
    const raw = String(name || '').trim();
    if (!raw) return '';
    const escaped = raw.replace(/'/g, "''");
    if (/^[A-Za-z0-9_]+$/.test(raw)) return raw;
    return "'" + escaped + "'";
  };

  const unquoteSheetName = (value) => {
    const raw = String(value || '').trim();
    if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
      return raw.slice(1, -1).replace(/''/g, "'");
    }
    return raw;
  };

  const splitSheetAndRange = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return { sheetName: '', rangePart: '' };
    const bangIndex = raw.lastIndexOf('!');
    if (bangIndex < 0) return { sheetName: '', rangePart: raw };
    const sheetPart = raw.slice(0, bangIndex).trim();
    const rangePart = raw.slice(bangIndex + 1).trim();
    return {
      sheetName: unquoteSheetName(sheetPart),
      rangePart,
    };
  };

  const buildRangeReference = (sheetName, rangePart) => {
    const normalizedRange = String(rangePart || '').trim();
    if (!normalizedRange) return '';
    const normalizedSheet = String(sheetName || '').trim();
    if (!normalizedSheet) return normalizedRange;
    return quoteSheetName(normalizedSheet) + '!' + normalizedRange;
  };

  const findNameBoxElement = () => {
    const selectors = [
      '#t-name-box',
      'input[aria-label="Name box"]',
      'input[aria-label*="Name box"]',
      'input[aria-label*="Name Box"]',
      'input[id*="NameBox"]',
      'input[data-automationid*="NameBox"]',
      '[data-automationid*="NameBox"] input',
      '[role="textbox"][aria-label*="Name box"]',
      '[role="textbox"][aria-label*="Name Box"]',
    ];

    for (const selector of selectors) {
      for (const node of queryAllSafe(selector)) {
        if (isVisible(node)) return node;
      }
    }

    return null;
  };

  const setEditableValue = (node, value) => {
    if (!node) return false;
    const text = String(value ?? '');
    try {
      if ('value' in node && typeof node.value === 'string') {
        node.value = text;
      } else if (node.isContentEditable) {
        node.textContent = text;
      } else {
        node.textContent = text;
      }
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch {
      return false;
    }
  };

  const pressEnterOn = (node) => {
    if (!node) return;
    const eventOptions = {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
      code: 'Enter',
      which: 13,
      keyCode: 13,
    };
    try {
      node.dispatchEvent(new KeyboardEvent('keydown', eventOptions));
      node.dispatchEvent(new KeyboardEvent('keypress', eventOptions));
      node.dispatchEvent(new KeyboardEvent('keyup', eventOptions));
    } catch {}
  };

  const findSheetTabByName = (sheetName) => {
    const wanted = normalizeText(sheetName);
    if (!wanted) return null;

    for (const tab of collectSheetTabElements()) {
      const tabName = normalizeText(getSheetNameFromTab(tab));
      if (tabName && tabName === wanted) return tab;
    }

    return null;
  };

  const clickElement = (node) => {
    if (!node) return false;
    try {
      node.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    } catch {}
    try {
      node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      node.click?.();
      return true;
    } catch {
      return false;
    }
  };

  const openContextMenuForElement = (node) => {
    if (!node) return false;
    const rect = node.getBoundingClientRect?.();
    const clientX = rect ? Math.round(rect.left + Math.max(5, Math.min(20, rect.width / 2))) : 20;
    const clientY = rect ? Math.round(rect.top + Math.max(5, Math.min(12, rect.height / 2))) : 20;

    try {
      node.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          button: 2,
          buttons: 2,
          clientX,
          clientY,
        }),
      );
      return true;
    } catch {
      return false;
    }
  };

  const nodeLabel = (node) => {
    if (!node) return '';
    const combined = [textOf(node), node.getAttribute?.('aria-label') || '', node.getAttribute?.('title') || '']
      .filter(Boolean)
      .join(' ');
    return normalizeText(combined);
  };

  const collectMenuItems = () => {
    const selectors = [
      '[role="menuitem"]',
      '[role="menuitemradio"]',
      '[role="menuitemcheckbox"]',
      '.goog-menuitem',
      '[data-automationid*="ContextMenu"] [role="button"]',
      '[data-automationid*="ContextMenu"] button',
      '[data-automationid*="ContextMenuItem"]',
      '.ms-ContextualMenu-item button',
    ];

    const dedup = new Set();
    const nodes = [];
    for (const selector of selectors) {
      for (const node of queryAllSafe(selector)) {
        if (!isVisible(node) || dedup.has(node)) continue;
        dedup.add(node);
        nodes.push(node);
      }
    }
    return nodes;
  };

  const clickMenuItemByKeywords = (required, excluded = []) => {
    const requiredNormalized = required.map((entry) => normalizeText(entry)).filter(Boolean);
    const excludedNormalized = excluded.map((entry) => normalizeText(entry)).filter(Boolean);
    if (requiredNormalized.length === 0) return false;

    for (const node of collectMenuItems()) {
      const label = nodeLabel(node);
      if (!label) continue;
      if (!requiredNormalized.every((term) => label.includes(term))) continue;
      if (excludedNormalized.some((term) => label.includes(term))) continue;
      if (clickElement(node)) return true;
    }

    return false;
  };

  const selectSheet = async (sheetName) => {
    const normalized = String(sheetName || '').trim();
    if (!normalized) {
      return {
        success: false,
        message: 'Sheet name is required.',
      };
    }

    const tab = findSheetTabByName(normalized);
    if (!tab) {
      return {
        success: false,
        message: "Sheet tab not found: " + normalized,
      };
    }

    clickElement(tab);
    await wait(90);

    const activeSheetName = getActiveSheetName();
    return {
      success: normalizeText(activeSheetName) === normalizeText(normalized),
      activeSheetName,
    };
  };

  const activateRange = async (rangeA1) => {
    const context = detectContext();
    if (!context.provider) {
      return {
        success: false,
        message: 'Not on a supported spreadsheet page.',
      };
    }

    const parsed = splitSheetAndRange(rangeA1);
    if (!parsed.rangePart) {
      return {
        success: false,
        message: 'Range in A1 notation is required.',
      };
    }

    if (parsed.sheetName) {
      const selectResult = await selectSheet(parsed.sheetName);
      if (!selectResult.success) {
        return {
          success: false,
          message: selectResult.message || 'Unable to activate sheet before selecting range.',
        };
      }
    }

    const nameBox = findNameBoxElement();
    if (!nameBox) {
      return {
        success: false,
        message: 'Name box input is unavailable for range navigation.',
      };
    }

    try {
      nameBox.focus?.();
      if (!setEditableValue(nameBox, parsed.rangePart)) {
        return {
          success: false,
          message: 'Unable to type A1 range into name box.',
        };
      }
      pressEnterOn(nameBox);
      await wait(90);
      return {
        success: true,
        requestedRangeA1: buildRangeReference(parsed.sheetName, parsed.rangePart),
        activeSheetName: getActiveSheetName(),
        activeSelectionA1: getSelectionA1(context.provider),
      };
    } catch (error) {
      return {
        success: false,
        message: error && error.message ? String(error.message) : 'Range activation failed.',
      };
    }
  };

  const findAddSheetButton = () => {
    const selectors = [
      '.docs-sheet-add-button',
      '.docs-sheet-add',
      '[aria-label="Add sheet"]',
      '[aria-label*="Add sheet"]',
      '[data-automationid*="AddSheet"]',
      '[title="Add sheet"]',
      '[title="New sheet"]',
    ];

    for (const selector of selectors) {
      for (const node of queryAllSafe(selector)) {
        if (isVisible(node)) return node;
      }
    }
    return null;
  };

  const commitInlineSheetRename = async (newName) => {
    const desiredName = String(newName || '').trim();
    if (!desiredName) return false;

    const candidates = [];
    const dedup = new Set();
    const addCandidate = (node) => {
      if (!node || dedup.has(node)) return;
      dedup.add(node);
      candidates.push(node);
    };

    addCandidate(document.activeElement);
    for (const selector of ['input', 'textarea', '[contenteditable="true"]', '[role="textbox"]']) {
      for (const node of queryAllSafe(selector)) {
        if (!isVisible(node)) continue;
        addCandidate(node);
      }
    }

    for (const node of candidates) {
      const editable =
        node &&
        ((typeof node.value === 'string' && !node.disabled) ||
          node.isContentEditable ||
          normalizeText(node.getAttribute?.('role')) === 'textbox');
      if (!editable) continue;
      node.focus?.();
      if (!setEditableValue(node, desiredName)) continue;
      pressEnterOn(node);
      await wait(120);
      return true;
    }

    return false;
  };

  const renameSheet = async (oldName, newName) => {
    const previousName = String(oldName || '').trim();
    const desiredName = String(newName || '').trim();
    if (!previousName || !desiredName) {
      return {
        success: false,
        message: 'Both old_name and new_name are required.',
      };
    }

    const tab = findSheetTabByName(previousName);
    if (!tab) {
      return {
        success: false,
        message: "Sheet tab not found: " + previousName,
      };
    }

    clickElement(tab);
    await wait(60);

    try {
      tab.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
    } catch {}

    await wait(120);
    let renamed = await commitInlineSheetRename(desiredName);

    if (!renamed) {
      openContextMenuForElement(tab);
      await wait(90);
      const clickedRename = clickMenuItemByKeywords(['rename']);
      if (clickedRename) {
        await wait(90);
        renamed = await commitInlineSheetRename(desiredName);
      }
    }

    await wait(120);
    const names = listSheets();
    const success = names.some((name) => normalizeText(name) === normalizeText(desiredName));
    return {
      success: renamed && success,
      oldName: previousName,
      newName: desiredName,
      sheetNames: names,
    };
  };

  const createSheets = async (sheetNames) => {
    const requested = Array.isArray(sheetNames) ? sheetNames : [];
    const operations = [];

    for (const rawName of requested) {
      const name = String(rawName || '').trim();
      if (!name) {
        operations.push({
          sheetName: '',
          success: false,
          message: 'Sheet name must be non-empty.',
        });
        continue;
      }

      const before = listSheets();
      const addButton = findAddSheetButton();
      if (!addButton) {
        operations.push({
          sheetName: name,
          success: false,
          message: 'Add sheet button is unavailable.',
        });
        continue;
      }

      clickElement(addButton);
      await wait(160);
      const afterCreate = listSheets();
      const createdName =
        afterCreate.find((entry) => !before.some((existing) => normalizeText(existing) === normalizeText(entry))) ||
        getActiveSheetName();

      let finalSuccess = true;
      let finalName = createdName || name;
      if (createdName && normalizeText(createdName) !== normalizeText(name)) {
        const renameResult = await renameSheet(createdName, name);
        finalSuccess = renameResult.success;
        finalName = name;
      } else if (!createdName) {
        finalSuccess = false;
      }

      operations.push({
        sheetName: finalName,
        success: finalSuccess,
      });
    }

    return {
      success: operations.every((entry) => entry.success),
      operations,
      sheetNames: listSheets(),
      activeSheetName: getActiveSheetName(),
    };
  };

  const clickDialogButtonByKeywords = (keywords) => {
    const wanted = keywords.map((entry) => normalizeText(entry)).filter(Boolean);
    if (!wanted.length) return false;
    for (const selector of ['button', '[role="button"]']) {
      for (const node of queryAllSafe(selector)) {
        if (!isVisible(node)) continue;
        const label = nodeLabel(node);
        if (!label) continue;
        if (wanted.every((term) => label.includes(term))) {
          if (clickElement(node)) return true;
        }
      }
    }
    return false;
  };

  const deleteSheets = async (sheetNames) => {
    const requested = Array.isArray(sheetNames) ? sheetNames : [];
    const operations = [];

    for (const rawName of requested) {
      const name = String(rawName || '').trim();
      if (!name) {
        operations.push({
          sheetName: '',
          success: false,
          message: 'Sheet name must be non-empty.',
        });
        continue;
      }

      const tab = findSheetTabByName(name);
      if (!tab) {
        operations.push({
          sheetName: name,
          success: false,
          message: 'Sheet tab not found.',
        });
        continue;
      }

      openContextMenuForElement(tab);
      await wait(100);
      let clickedDelete = clickMenuItemByKeywords(['delete'], ['row', 'column']);
      if (!clickedDelete) {
        clickedDelete = clickMenuItemByKeywords(['remove'], ['row', 'column']);
      }

      if (!clickedDelete) {
        operations.push({
          sheetName: name,
          success: false,
          message: 'Delete sheet menu item not found.',
        });
        continue;
      }

      await wait(100);
      clickDialogButtonByKeywords(['delete']);
      await wait(140);

      const stillExists = listSheets().some((entry) => normalizeText(entry) === normalizeText(name));
      operations.push({
        sheetName: name,
        success: !stillExists,
      });
    }

    return {
      success: operations.every((entry) => entry.success),
      operations,
      sheetNames: listSheets(),
      activeSheetName: getActiveSheetName(),
    };
  };

  const batchRenameSheets = async (operations) => {
    const input = Array.isArray(operations) ? operations : [];
    const results = [];

    for (const entry of input) {
      const oldName = entry && typeof entry.old_name === 'string' ? entry.old_name : '';
      const newName = entry && typeof entry.new_name === 'string' ? entry.new_name : '';
      const result = await renameSheet(oldName, newName);
      results.push(result);
    }

    return {
      success: results.every((entry) => entry.success),
      operations: results,
      sheetNames: listSheets(),
    };
  };

  const columnNumberToName = (index) => {
    const number = Number(index);
    if (!Number.isFinite(number) || number < 1) return '';
    let value = Math.floor(number);
    let result = '';
    while (value > 0) {
      const remainder = (value - 1) % 26;
      result = String.fromCharCode(65 + remainder) + result;
      value = Math.floor((value - 1) / 26);
    }
    return result;
  };

  const findSelectedHeader = (kind) => {
    const selectors =
      kind === 'row'
        ? [
            '[role="rowheader"][aria-selected="true"]',
            '.docs-sheet-row-header[aria-selected="true"]',
            '[data-automationid*="RowHeader"][aria-selected="true"]',
          ]
        : [
            '[role="columnheader"][aria-selected="true"]',
            '.docs-sheet-column-header[aria-selected="true"]',
            '[data-automationid*="ColumnHeader"][aria-selected="true"]',
          ];

    for (const selector of selectors) {
      for (const node of queryAllSafe(selector)) {
        if (isVisible(node)) return node;
      }
    }
    return null;
  };

  const clickStructureAction = (kind, action) => {
    const candidateSets = [];
    if (action === 'insert' && kind === 'row') {
      candidateSets.push({ required: ['insert', 'row'], excluded: ['column'] });
      candidateSets.push({ required: ['insert', 'above'], excluded: ['column'] });
      candidateSets.push({ required: ['insert', 'below'], excluded: ['column'] });
    }
    if (action === 'insert' && kind === 'column') {
      candidateSets.push({ required: ['insert', 'column'], excluded: ['row'] });
      candidateSets.push({ required: ['insert', 'left'], excluded: ['row'] });
      candidateSets.push({ required: ['insert', 'right'], excluded: ['row'] });
    }
    if (action === 'delete' && kind === 'row') {
      candidateSets.push({ required: ['delete', 'row'], excluded: ['column'] });
    }
    if (action === 'delete' && kind === 'column') {
      candidateSets.push({ required: ['delete', 'column'], excluded: ['row'] });
    }

    for (const entry of candidateSets) {
      if (clickMenuItemByKeywords(entry.required, entry.excluded)) return true;
    }
    return false;
  };

  const mutateStructure = async (params) => {
    const kind = params && params.kind === 'column' ? 'column' : 'row';
    const action = params && params.action === 'delete' ? 'delete' : 'insert';
    const position = Number(params?.position);
    const countRaw = Number(params?.count);
    const count = Number.isFinite(countRaw) && countRaw > 0 ? Math.floor(countRaw) : 1;
    const sheetName = params && typeof params.sheet_name === 'string' ? params.sheet_name : '';

    if (!Number.isFinite(position) || position < 1) {
      return {
        success: false,
        message: 'Position must be a 1-based integer.',
      };
    }

    const targetIndex = Math.floor(position);
    let completed = 0;
    for (let i = 0; i < count; i += 1) {
      const targetRangePart =
        kind === 'row'
          ? targetIndex + ':' + targetIndex
          : columnNumberToName(targetIndex) + ':' + columnNumberToName(targetIndex);

      const activateResult = await activateRange(buildRangeReference(sheetName, targetRangePart));
      if (!activateResult.success) {
        return {
          success: false,
          message: activateResult.message || 'Unable to activate target row/column.',
          completed,
        };
      }

      await wait(80);
      const anchor = findSelectedHeader(kind) || document.activeElement || document.body;
      openContextMenuForElement(anchor);
      await wait(100);

      const clicked = clickStructureAction(kind, action);
      if (!clicked) {
        return {
          success: false,
          message:
            action === 'insert'
              ? 'Could not find insert option in row/column context menu.'
              : 'Could not find delete option in row/column context menu.',
          completed,
        };
      }

      completed += 1;
      await wait(120);
    }

    return {
      success: true,
      kind,
      action,
      position: targetIndex,
      count,
      completed,
      activeSheetName: getActiveSheetName(),
    };
  };

  const writeClipboardText = async (value) => {
    const text = typeof value === 'string' ? value : String(value ?? '');
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        return {
          success: false,
          errorCode: 'CLIPBOARD_READ_FAILED',
          message: 'Clipboard writeText API is unavailable in this browser context.',
        };
      }
      await navigator.clipboard.writeText(text);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        errorCode: 'CLIPBOARD_READ_FAILED',
        message: error && error.message ? String(error.message) : 'Clipboard write failed.',
      };
    }
  };

  const getWorkbookInfo = () => {
    const context = detectContext();
    const sheetNames = listSheets();
    return {
      provider: context.provider,
      workbookTitle: context.workbookTitle,
      total_sheets: sheetNames.length,
      sheet_names: sheetNames,
      active_sheet: context.activeSheetName,
      activeSelectionA1: context.activeSelectionA1,
    };
  };

  globalThis[globalName] = {
    version,
    detectContext,
    getWorkbookInfo,
    listSheets: () => {
      const context = detectContext();
      return {
        provider: context.provider,
        sheets: listSheets(),
        activeSheetName: context.activeSheetName,
      };
    },
    getSheets: () => listSheets(),
    selectSheet,
    activateRange,
    createSheets,
    deleteSheets,
    renameSheet,
    batchRenameSheets,
    mutateStructure,
    getSelectionMetadata,
    readClipboardText,
    writeClipboardText,
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

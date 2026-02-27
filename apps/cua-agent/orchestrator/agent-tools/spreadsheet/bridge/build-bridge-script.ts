/**
 * Assembles the final injectable IIFE bridge scripts from shared helpers,
 * provider-specific code, and common glue.
 */

import { getSpreadsheetProvider } from '../detection';
import { SHARED_BRIDGE_HELPERS } from './shared-helpers';
import { GOOGLE_SHEETS_BRIDGE_CODE } from './google-sheets-bridge';
import { EXCEL_WEB_BRIDGE_CODE } from './excel-web-bridge';

export const BRIDGE_VERSION = '2.2.0';
export const BRIDGE_GLOBAL = '__cuaSpreadsheetBridge';

/**
 * Common glue code that uses provider-defined variables and shared helpers.
 * Provider code MUST be included before this in the assembled script.
 *
 * Expected from provider code:
 *   - detectProvider()
 *   - providerSheetTabSelectors (array)
 *   - providerSelectionFallbackSelectors (array)
 *   - providerGridSelectors (array)
 *   - getWorkbookTitle(provider)
 *
 * Optional from provider code (checked via typeof):
 *   - ensureHomeTabSelected() — Excel only
 *   - findRibbonStructureButton(action) — Excel only
 *   - clickGoogleMenuStructureAction(kind, action) — Google only
 */
const COMMON_GLUE = `
  const collectSheetTabElements = () => {
    const dedup = new Set();
    const nodes = [];
    for (const selector of providerSheetTabSelectors) {
      for (const element of queryAllSafe(selector)) {
        if (!element || dedup.has(element)) continue;
        dedup.add(element);
        nodes.push(element);
      }
    }
    return nodes;
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
      '#FormulaBar-NameBox-input',
      'input[aria-label="Name box"]',
      'input[aria-label*="Name box"]',
      'input[aria-label*="Name Box"]',
      'input[role="combobox"][aria-label*="Name Box"]',
      'input[role="combobox"][aria-label*="Name box"]',
      'input[id*="NameBox"]',
      'input[id*="NameBox-input"]',
      'input[data-automationid*="NameBox"]',
      '[data-automationid*="NameBox"] input',
    ];
    const value = findFirstValue(shared);
    if (value) return value;

    if (providerSelectionFallbackSelectors.length > 0) {
      return findFirstValue(providerSelectionFallbackSelectors);
    }

    return '';
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

  const findNameBoxElement = () => {
    const selectors = [
      '#t-name-box',
      '#FormulaBar-NameBox-input',
      'input[aria-label="Name box"]',
      'input[aria-label*="Name box"]',
      'input[aria-label*="Name Box"]',
      'input[role="combobox"][aria-label*="Name Box"]',
      'input[role="combobox"][aria-label*="Name box"]',
      'input[id*="NameBox"]',
      'input[id*="NameBox-input"]',
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

  const findSheetTabByName = (sheetName) => {
    const wanted = normalizeText(sheetName);
    if (!wanted) return null;

    for (const tab of collectSheetTabElements()) {
      const tabName = normalizeText(getSheetNameFromTab(tab));
      if (tabName && tabName === wanted) return tab;
    }

    return null;
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
      const activeSelectionA1 = getSelectionA1(context.provider);
      const nameBoxStillFocused = document.activeElement === nameBox;
      return {
        success: true,
        requestedRangeA1: buildRangeReference(parsed.sheetName, parsed.rangePart),
        activeSheetName: getActiveSheetName(),
        activeSelectionA1,
        nameBoxStillFocused,
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

  const findGridAnchorElement = () => {
    for (const selector of providerGridSelectors) {
      for (const node of queryAllSafe(selector)) {
        if (isVisible(node)) return node;
      }
    }

    return null;
  };

  const mutateStructure = async (params) => {
    const context = detectContext();
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

      // Excel: try Home tab + ribbon button
      if (typeof ensureHomeTabSelected !== 'undefined') {
        await ensureHomeTabSelected();
      }

      let clicked = false;
      if (typeof findRibbonStructureButton !== 'undefined') {
        const ribbonButton = findRibbonStructureButton(action);
        if (ribbonButton) {
          clicked = clickElement(ribbonButton);
          if (clicked) {
            await wait(140);
          }
        }
      }

      // Context menu fallback (shared)
      if (!clicked) {
        try {
          if (document.activeElement && typeof document.activeElement.blur === 'function') {
            document.activeElement.blur();
          }
        } catch {}

        const anchor = findSelectedHeader(kind) || findGridAnchorElement() || document.body;
        openContextMenuForElement(anchor);
        await wait(120);
        clicked = clickStructureAction(kind, action);
        if (!clicked && context.provider === 'google_sheets' && action === 'delete') {
          clicked = clickMenuItemByKeywords(['delete']);
          if (clicked) {
            await wait(120);
          }
        }
      }

      // Google: try menu bar
      if (!clicked && typeof clickGoogleMenuStructureAction !== 'undefined') {
        clicked = await clickGoogleMenuStructureAction(kind, action);
      }

      // Google: try Ctrl+- keyboard shortcut for delete
      if (!clicked && context.provider === 'google_sheets' && action === 'delete') {
        const target = document.activeElement || findGridAnchorElement() || document.body;
        const eventOptions = {
          bubbles: true,
          cancelable: true,
          key: '-',
          code: 'Minus',
          ctrlKey: true,
          metaKey: false,
          altKey: false,
          shiftKey: false,
        };
        try {
          target.dispatchEvent(new KeyboardEvent('keydown', eventOptions));
          target.dispatchEvent(new KeyboardEvent('keypress', eventOptions));
          target.dispatchEvent(new KeyboardEvent('keyup', eventOptions));
          await wait(160);
          clicked = true;
        } catch {
          // keep clicked=false
        }
      }

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
`;

function buildBridgeScript(providerCode: string): string {
  return `(() => {
  const version = ${JSON.stringify(BRIDGE_VERSION)};
  const globalName = ${JSON.stringify(BRIDGE_GLOBAL)};

  if (
    globalThis[globalName] &&
    typeof globalThis[globalName] === 'object' &&
    globalThis[globalName].version === version
  ) {
    return;
  }

${SHARED_BRIDGE_HELPERS}

${providerCode}

${COMMON_GLUE}
})();`;
}

export const GOOGLE_SHEETS_BRIDGE_SCRIPT = buildBridgeScript(GOOGLE_SHEETS_BRIDGE_CODE);
export const EXCEL_WEB_BRIDGE_SCRIPT = buildBridgeScript(EXCEL_WEB_BRIDGE_CODE);

export function getBridgeScriptForProvider(
  provider: ReturnType<typeof getSpreadsheetProvider> | null | undefined,
): string {
  return provider === 'google_sheets' ? GOOGLE_SHEETS_BRIDGE_SCRIPT : EXCEL_WEB_BRIDGE_SCRIPT;
}

export function getBridgeScriptForUrl(
  url: string | null | undefined,
  fallbackProvider?: ReturnType<typeof getSpreadsheetProvider> | null,
): string {
  if (typeof url !== 'string' || url.length === 0) {
    return getBridgeScriptForProvider(fallbackProvider ?? null);
  }
  return getBridgeScriptForProvider(getSpreadsheetProvider(url) ?? fallbackProvider ?? null);
}

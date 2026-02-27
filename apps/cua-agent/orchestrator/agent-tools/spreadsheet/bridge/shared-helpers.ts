/**
 * Injectable JavaScript string containing shared DOM/clipboard/range utilities
 * used by both Google Sheets and Excel Web bridge scripts.
 */

export const SHARED_BRIDGE_HELPERS = `
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

  const isVisible = (node) => {
    if (!node || typeof node.getBoundingClientRect !== 'function') return false;
    const rect = node.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(node);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };

  const normalizeText = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();

  const normalizeSheetName = (value) => {
    if (!value) return '';
    const trimmed = value.trim();
    if (!trimmed) return '';
    if (trimmed === '+' || trimmed === 'Add sheet' || trimmed === 'Add Sheet') return '';
    return trimmed;
  };

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

  const wait = (ms) =>
    new Promise((resolve) => setTimeout(resolve, Number.isFinite(ms) ? Math.max(0, ms) : 0));

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

  const openContextMenuForElement = (node) => {
    if (!node) return false;
    const rect = node.getBoundingClientRect?.();
    const viewportWidth = Number.isFinite(window.innerWidth) && window.innerWidth > 0 ? window.innerWidth : 1280;
    const viewportHeight = Number.isFinite(window.innerHeight) && window.innerHeight > 0 ? window.innerHeight : 720;
    const rawX = rect ? Math.round(rect.left + Math.max(8, Math.min(80, rect.width / 4))) : 40;
    const rawY = rect ? Math.round(rect.top + Math.max(8, Math.min(80, rect.height / 4))) : 40;
    const clientX = Math.max(2, Math.min(viewportWidth - 2, rawX));
    const clientY = Math.max(2, Math.min(viewportHeight - 2, rawY));

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

  const parseTsv = (tsv) => {
    const rawTsv = typeof tsv === 'string' ? tsv : '';
    if (!rawTsv) {
      return { values: [], rawTsv };
    }
    const normalized = rawTsv.replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');
    const rows = [];
    let row = [];
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
      if (ch === '\\t') {
        row.push(field);
        field = '';
        i += 1;
        continue;
      }
      if (ch === '\\n') {
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
    return { values: rows, rawTsv };
  };
`;

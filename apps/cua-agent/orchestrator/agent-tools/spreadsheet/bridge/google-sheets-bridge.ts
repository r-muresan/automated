/**
 * Injectable JavaScript string containing Google Sheets-specific bridge code.
 * Defines provider selectors, detection, and Google-specific helper functions.
 */

export const GOOGLE_SHEETS_BRIDGE_CODE = `
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
    const isGoogleSheet =
      (host === 'docs.google.com' || host === 'sheets.google.com') &&
      /^\\/spreadsheets\\/d\\/[^/]+(?:\\/|$)/i.test(path);
    return isGoogleSheet ? 'google_sheets' : null;
  };

  const providerSheetTabSelectors = [
    '.docs-sheet-tab[role="tab"]',
    '.docs-sheet-tab',
  ];

  const providerSelectionFallbackSelectors = [
    'input[aria-label*="range"]',
    'input[aria-label*="Range"]',
  ];

  const providerGridSelectors = [
    '#waffle-grid-container',
    '.grid-container',
    '.cell-input',
  ];

  const getWorkbookTitle = (provider) => {
    const title = (document.title || '').trim();
    if (!title) return '';
    return title.replace(/\\s*-\\s*Google Sheets.*$/i, '').trim();
  };

  const findTopMenuButton = (menuLabel) => {
    const wanted = normalizeText(menuLabel);
    if (!wanted) return null;
    const selectors = [
      '[role="menubar"] [role="menuitem"]',
      '.menu-button[role="menuitem"]',
      '.menu-button',
    ];

    for (const selector of selectors) {
      for (const node of queryAllSafe(selector)) {
        if (!isVisible(node)) continue;
        const label = normalizeText(textOf(node) || node.getAttribute?.('aria-label') || '');
        if (!label) continue;
        if (label === wanted || label.startsWith(wanted + ' ')) {
          return node;
        }
      }
    }

    return null;
  };

  const collectPopupMenuItems = () => {
    const selectors = [
      '.goog-menuitem',
      '[role="menu"] [role="menuitem"]',
      '[role="menu"] [role="menuitemradio"]',
      '[role="menu"] [role="menuitemcheckbox"]',
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

  const clickPopupMenuItemByKeywords = (required, excluded = []) => {
    const requiredNormalized = required.map((entry) => normalizeText(entry)).filter(Boolean);
    const excludedNormalized = excluded.map((entry) => normalizeText(entry)).filter(Boolean);
    if (requiredNormalized.length === 0) return false;

    for (const node of collectPopupMenuItems()) {
      const label = nodeLabel(node);
      if (!label) continue;
      if (!requiredNormalized.every((term) => label.includes(term))) continue;
      if (excludedNormalized.some((term) => label.includes(term))) continue;
      if (clickElement(node)) return true;
    }

    return false;
  };

  const clickGoogleMenuStructureAction = async (kind, action) => {
    const menuLabel = action === 'delete' ? 'Edit' : 'Insert';
    const menuButton = findTopMenuButton(menuLabel);
    if (!menuButton) return false;

    if (!clickElement(menuButton)) return false;
    await wait(120);

    const candidateSets = [];
    if (action === 'insert' && kind === 'row') {
      candidateSets.push({ required: ['insert', 'row'], excluded: ['column'] });
      candidateSets.push({ required: ['row'], excluded: ['column'] });
    }
    if (action === 'insert' && kind === 'column') {
      candidateSets.push({ required: ['insert', 'column'], excluded: ['row'] });
      candidateSets.push({ required: ['column'], excluded: ['row'] });
    }
    if (action === 'delete' && kind === 'row') {
      candidateSets.push({ required: ['delete', 'row'], excluded: ['column'] });
    }
    if (action === 'delete' && kind === 'column') {
      candidateSets.push({ required: ['delete', 'column'], excluded: ['row'] });
    }

    for (const entry of candidateSets) {
      if (clickPopupMenuItemByKeywords(entry.required, entry.excluded)) {
        await wait(120);
        return true;
      }
    }

    try {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }),
      );
      document.dispatchEvent(
        new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }),
      );
    } catch {}
    return false;
  };
`;

/**
 * Injectable JavaScript string containing Excel Web-specific bridge code.
 * Defines provider selectors, detection, and Excel-specific helper functions.
 */

export const EXCEL_WEB_BRIDGE_CODE = `
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

    const isExcelHost =
      host === 'excel.office.com' ||
      host === 'excel.officeapps.live.com' ||
      /^excel\\.[a-z0-9.-]*officeapps\\.live\\.com$/i.test(host) ||
      host === 'excel.cloud.microsoft' ||
      host === 'office.live.com' ||
      host === 'www.office.com' ||
      host === 'office.com';
    if (!isExcelHost) {
      return null;
    }

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

  const providerSheetTabSelectors = [
    '#m_excelWebRenderer_ewaCtl_m_sheetTabBar [role="tab"]',
    '#m_excelWebRenderer_ewaCtl_m_sheetTabBar .tab-anchor-text',
    '#m_excelWebRenderer_ewaCtl_m_sheetTabBar a',
    '[role="tab"][data-automationid*="SheetTab"]',
    '[role="tab"][id*="sheet-tab"]',
    '[role="tab"][id*="SheetTab"]',
    '[role="tab"][aria-label*="sheet"]',
  ];

  const providerSelectionFallbackSelectors = [];

  const providerGridSelectors = [
    '#m_excelWebRenderer_ewaCtl_canvasdiv',
    '#m_excelWebRenderer_ewaCtl_gridDiv',
    '#m_excelWebRenderer_ewaCtl_rowHeadersDiv',
    '#m_excelWebRenderer_ewaCtl_colHeadersDiv',
    '[role="grid"]',
    '.ewa-gridcontrol',
  ];

  const getWorkbookTitle = (provider) => {
    const title = (document.title || '').trim();
    if (!title) return '';
    return title.replace(/\\s*-\\s*Excel.*$/i, '').trim();
  };

  const ensureHomeTabSelected = async () => {
    const selectors = [
      'button[role="tab"]#Home',
      '[role="tab"]#Home',
      'button[role="tab"][aria-label="Home"]',
      '[role="tab"][aria-label="Home"]',
      '[role="tab"][aria-label^="Home"]',
    ];

    for (const selector of selectors) {
      const candidate = queryAllSafe(selector).find((node) => isVisible(node));
      if (!candidate) continue;
      const ariaSelected = String(candidate.getAttribute?.('aria-selected') || '').toLowerCase();
      if (ariaSelected === 'true') return true;
      if (clickElement(candidate)) {
        await wait(120);
        return true;
      }
    }

    return false;
  };

  const findRibbonStructureButton = (action) => {
    const label = action === 'insert' ? 'Insert' : 'Delete';
    const selectors = [
      'button.fui-SplitButton__primaryActionButton[aria-label="' + label + '"]',
      'button[aria-label="' + label + '"]',
      '[role="button"][aria-label="' + label + '"]',
    ];

    for (const selector of selectors) {
      for (const node of queryAllSafe(selector)) {
        if (isVisible(node)) return node;
      }
    }

    return null;
  };
`;

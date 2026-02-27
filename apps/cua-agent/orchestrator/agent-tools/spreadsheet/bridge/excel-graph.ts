/**
 * Excel Web API-based reader.
 * Reads spreadsheet data via Microsoft's OneDrive/Graph API using MSAL tokens,
 * eliminating the need for clipboard-based reads.
 */

import type { Protocol } from 'devtools-protocol';
import type { CdpPageLike } from '../../types';

function extractExcelDocMetadata(
  url: string,
): { driveId: string; itemId: string } | null {
  try {
    const parsed = new URL(url);
    const params = parsed.searchParams;

    const docId = params.get('docId') || params.get('sourcedoc');
    const driveId = params.get('driveId');
    if (driveId && docId) {
      return { driveId, itemId: decodeURIComponent(docId) };
    }

    const resid = params.get('resid');
    if (resid) {
      const match = /^([^!]+)!(.+)$/.exec(resid);
      if (match) {
        return { driveId: match[1].toLowerCase(), itemId: resid };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract ALL valid MSAL access tokens from localStorage/sessionStorage,
 * since different tokens are scoped for different APIs:
 * - graph.microsoft.com tokens for Graph API
 * - onedrive.readwrite tokens for my.microsoftpersonalcontent.com
 */
async function extractAllMsalAccessTokens(page: CdpPageLike): Promise<string[]> {
  const expression = `(async () => {
    try {
      function findTokensInStorage(storage) {
        if (!storage) return [];
        const tokens = [];
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (!key) continue;
          if (key.toLowerCase().includes('accesstoken')) {
            try {
              const entry = JSON.parse(storage.getItem(key));
              if (entry && entry.secret && (entry.credentialType === 'AccessToken' || entry.credential_type === 'AccessToken')) {
                const expiresOn = parseInt(entry.expires_on || entry.expiresOn || '0', 10);
                const now = Math.floor(Date.now() / 1000);
                if (expiresOn > now) {
                  const target = (entry.target || key || '').toLowerCase();
                  tokens.push({ token: entry.secret, target, expiresOn });
                }
              }
            } catch { /* not JSON */ }
          }
        }
        return tokens;
      }
      const allTokens = [
        ...findTokensInStorage(localStorage),
        ...findTokensInStorage(sessionStorage),
      ];
      // Sort: onedrive tokens first (for personal API), then graph tokens, then others
      allTokens.sort((a, b) => {
        const aOneDrive = a.target.includes('onedrive') ? 1 : 0;
        const bOneDrive = b.target.includes('onedrive') ? 1 : 0;
        if (aOneDrive !== bOneDrive) return bOneDrive - aOneDrive;
        const aGraph = a.target.includes('graph.microsoft.com') ? 1 : 0;
        const bGraph = b.target.includes('graph.microsoft.com') ? 1 : 0;
        if (aGraph !== bGraph) return bGraph - aGraph;
        return b.expiresOn - a.expiresOn;
      });
      return { ok: true, tokens: allTokens.map(t => t.token) };
    } catch (error) {
      return { ok: false, tokens: [] };
    }
  })()`;

  try {
    const response = await page.sendCDP<Protocol.Runtime.EvaluateResponse>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.exceptionDetails) return [];
    const result = response.result?.value as
      | { ok?: boolean; tokens?: string[] }
      | undefined;
    if (!result?.ok || !Array.isArray(result.tokens)) return [];
    return result.tokens.filter((t): t is string => typeof t === 'string');
  } catch {
    return [];
  }
}

async function evalInPage(
  page: CdpPageLike,
  expression: string,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await page.sendCDP<Protocol.Runtime.EvaluateResponse>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.exceptionDetails) return null;
    const val = response.result?.value;
    return val && typeof val === 'object' ? (val as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Try to find a working workbook endpoint + token combination by testing
 * multiple API bases with multiple tokens.
 */
async function findWorkingWorkbookEndpoint(
  page: CdpPageLike,
  driveId: string,
  itemId: string,
  tokens: string[],
): Promise<{ workbookUrl: string; token: string } | null> {
  const encodedDrive = encodeURIComponent(driveId);
  const encodedItem = encodeURIComponent(itemId);

  // Also try without the 's' prefix in the item ID
  const altItemId = itemId.replace(/!s/, '!');
  const encodedAltItem = encodeURIComponent(altItemId);

  const bases = [
    // Personal OneDrive content API (what Excel Web actually uses)
    `https://my.microsoftpersonalcontent.com/_api/v2.0/drives/${encodedDrive}/items/${encodedItem}/workbook`,
    // Graph API with original item ID
    `https://graph.microsoft.com/v1.0/drives/${encodedDrive}/items/${encodedItem}/workbook`,
    // Graph API with alt item ID (without 's' prefix)
    ...(altItemId !== itemId
      ? [`https://graph.microsoft.com/v1.0/drives/${encodedDrive}/items/${encodedAltItem}/workbook`]
      : []),
    // Personal API with alt item ID
    ...(altItemId !== itemId
      ? [`https://my.microsoftpersonalcontent.com/_api/v2.0/drives/${encodedDrive}/items/${encodedAltItem}/workbook`]
      : []),
  ];

  for (const token of tokens) {
    for (const base of bases) {
      const testUrl = `${base}/worksheets`;
      const expr = `(async () => {
        try {
          const response = await fetch(${JSON.stringify(testUrl)}, {
            headers: { 'Authorization': 'Bearer ' + ${JSON.stringify(token)} },
          });
          return { ok: response.ok, status: response.status };
        } catch { return { ok: false, status: 0 }; }
      })()`;

      const result = await evalInPage(page, expr);
      if (result?.ok === true) {
        console.log(`[ORCHESTRATOR] Excel Graph: found working endpoint: ${base.substring(0, 80)}...`);
        return { workbookUrl: base, token };
      }
    }
  }

  // Step 2: Try resolving canonical item ID from personal content API metadata
  for (const token of tokens) {
    const metaUrl =
      `https://my.microsoftpersonalcontent.com/_api/v2.0/drives/${encodedDrive}` +
      `/items/${encodedItem}?$select=id,parentReference`;

    const metaExpr = `(async () => {
      try {
        const response = await fetch(${JSON.stringify(metaUrl)}, {
          headers: { 'Authorization': 'Bearer ' + ${JSON.stringify(token)} },
        });
        if (!response.ok) return { ok: false };
        const data = await response.json();
        return { ok: true, id: data.id, driveId: data.parentReference ? data.parentReference.driveId : null };
      } catch { return { ok: false }; }
    })()`;

    const metaResult = await evalInPage(page, metaExpr);
    if (metaResult?.ok === true && typeof metaResult.id === 'string') {
      const resolvedId = metaResult.id;
      const resolvedDrive = typeof metaResult.driveId === 'string' ? metaResult.driveId : driveId;
      console.log(`[ORCHESTRATOR] Excel Graph: resolved canonical ID: ${resolvedId}`);

      // Try Graph and personal API with resolved ID
      const resolvedBases = [
        `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(resolvedDrive)}/items/${encodeURIComponent(resolvedId)}/workbook`,
        `https://my.microsoftpersonalcontent.com/_api/v2.0/drives/${encodeURIComponent(resolvedDrive)}/items/${encodeURIComponent(resolvedId)}/workbook`,
      ];

      for (const resolvedToken of tokens) {
        for (const base of resolvedBases) {
          const testUrl = `${base}/worksheets`;
          const expr = `(async () => {
            try {
              const response = await fetch(${JSON.stringify(testUrl)}, {
                headers: { 'Authorization': 'Bearer ' + ${JSON.stringify(resolvedToken)} },
              });
              return { ok: response.ok, status: response.status };
            } catch { return { ok: false, status: 0 }; }
          })()`;

          const result = await evalInPage(page, expr);
          if (result?.ok === true) {
            console.log(`[ORCHESTRATOR] Excel Graph: found working resolved endpoint: ${base.substring(0, 80)}...`);
            return { workbookUrl: base, token: resolvedToken };
          }
        }
      }
    }
  }

  return null;
}

/**
 * Read a range from Excel via the Microsoft API.
 */
export async function readRangeViaExcelGraph(
  page: CdpPageLike,
  sheetName: string,
  rangeA1: string,
): Promise<{ ok: true; values: string[][] } | { ok: false; message: string }> {
  const metadata = extractExcelDocMetadata(page.url());
  if (!metadata) {
    return { ok: false, message: 'Could not extract Excel document metadata from URL.' };
  }

  const tokens = await extractAllMsalAccessTokens(page);
  if (tokens.length === 0) {
    return { ok: false, message: 'Could not extract any MSAL access tokens from page storage.' };
  }

  const endpoint = await findWorkingWorkbookEndpoint(page, metadata.driveId, metadata.itemId, tokens);
  if (!endpoint) {
    return { ok: false, message: 'Could not find a working workbook API endpoint.' };
  }

  // Step 1: Get worksheet list to resolve the sheet ID (avoids name encoding issues)
  const targetSheetName = sheetName || 'Sheet1';
  const sheetsExpr = `(async () => {
    try {
      const response = await fetch(${JSON.stringify(endpoint.workbookUrl + '/worksheets')}, {
        headers: { 'Authorization': 'Bearer ' + ${JSON.stringify(endpoint.token)} },
      });
      if (!response.ok) return { ok: false, message: 'worksheets list failed: HTTP ' + response.status };
      const data = await response.json();
      return { ok: true, sheets: (data.value || []).map(s => ({ id: s.id, name: s.name })) };
    } catch (error) {
      return { ok: false, message: error && error.message ? String(error.message) : 'worksheets list failed' };
    }
  })()`;

  const sheetsResult = await evalInPage(page, sheetsExpr);
  if (!sheetsResult || sheetsResult.ok !== true || !Array.isArray(sheetsResult.sheets)) {
    return { ok: false, message: `Failed to list worksheets: ${(sheetsResult as any)?.message || 'unknown'}` };
  }

  const sheets = sheetsResult.sheets as Array<{ id: string; name: string }>;
  const matchedSheet = sheets.find(
    (s) => s.name.toLowerCase() === targetSheetName.toLowerCase(),
  ) || sheets[0];

  if (!matchedSheet) {
    return { ok: false, message: `No worksheets found in workbook.` };
  }

  // Step 2: Use worksheet ID for the range read
  const sheetId = matchedSheet.id;
  const rangeUrl = `${endpoint.workbookUrl}/worksheets/${encodeURIComponent(sheetId)}/range(address='${rangeA1}')`;

  const expression = `(async () => {
    try {
      const response = await fetch(${JSON.stringify(rangeUrl)}, {
        headers: {
          'Authorization': 'Bearer ' + ${JSON.stringify(endpoint.token)},
          'Content-Type': 'application/json',
        },
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return { ok: false, message: 'API request failed: HTTP ' + response.status + ' ' + text.slice(0, 200) };
      }
      const data = await response.json();
      return { ok: true, values: data.values || data.text || [] };
    } catch (error) {
      return { ok: false, message: error && error.message ? String(error.message) : 'API fetch failed' };
    }
  })()`;

  try {
    const response = await page.sendCDP<Protocol.Runtime.EvaluateResponse>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });

    if (response.exceptionDetails) {
      return { ok: false, message: response.exceptionDetails.text || 'API evaluation failed' };
    }

    const result = response.result?.value as
      | { ok?: boolean; values?: unknown[][]; message?: string }
      | undefined;
    if (!result || result.ok !== true || !Array.isArray(result.values)) {
      return { ok: false, message: result?.message || 'API returned invalid response' };
    }

    const stringValues: string[][] = result.values.map((row: unknown[]) =>
      Array.isArray(row) ? row.map((cell) => (cell == null ? '' : String(cell))) : [],
    );

    return { ok: true, values: stringValues };
  } catch (error: any) {
    return { ok: false, message: error?.message ?? 'API fetch failed' };
  }
}

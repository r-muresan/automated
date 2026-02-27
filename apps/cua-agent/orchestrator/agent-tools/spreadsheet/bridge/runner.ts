/**
 * Bridge runtime: injection, version checking, frame scanning, and execution.
 * Moved from the monolithic bridge.ts.
 */

import type { Protocol } from 'devtools-protocol';
import type { Stagehand } from '../../../../stagehand/v3';
import { getSpreadsheetProvider } from '../detection';
import { getActivePage, getPageUrl } from '../../page-utils';
import type {
  BridgeRunResult,
  CdpPageLike,
  SpreadsheetErrorCode,
  SpreadsheetPageState,
  SpreadsheetToolError,
} from '../../types';
import {
  BRIDGE_VERSION,
  BRIDGE_GLOBAL,
  getBridgeScriptForProvider,
  getBridgeScriptForUrl,
} from './build-bridge-script';

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
      expression: `globalThis.${BRIDGE_GLOBAL}?.version ?? null`,
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
  // Grant clipboard permissions for reliability
  try {
    const origin = new URL(page.url()).origin;
    await page.sendCDP('Browser.grantPermissions', {
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
      origin,
    });
  } catch {
    // Non-fatal: clipboard may still work in some contexts
  }

  const currentVersion = await readBridgeVersion(page);
  if (currentVersion === BRIDGE_VERSION) {
    console.log('[ORCHESTRATOR] Spreadsheet bridge: already ready');
    return;
  }

  const pageProvider = getSpreadsheetProvider(page.url());
  const bridgeScript = getBridgeScriptForUrl(page.url(), pageProvider);
  console.log('[ORCHESTRATOR] Spreadsheet bridge: injecting CDP script');
  await page.sendCDP('Page.addScriptToEvaluateOnNewDocument', {
    source: bridgeScript,
  });

  const injectionResult = await page.sendCDP<Protocol.Runtime.EvaluateResponse>('Runtime.evaluate', {
    expression: bridgeScript,
    returnByValue: true,
    awaitPromise: true,
  });

  if (injectionResult.exceptionDetails) {
    throw new Error(injectionResult.exceptionDetails.text || 'Bridge runtime evaluation failed');
  }

  const injectedVersion = await readBridgeVersion(page);
  if (injectedVersion !== BRIDGE_VERSION) {
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
  const pageProvider = getSpreadsheetProvider(page.url());
  const expression = `(() => {
    try {
      const bridge = globalThis.${BRIDGE_GLOBAL};
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
  const workbookInfoExpression = `(() => {
    try {
      const bridge = globalThis.${BRIDGE_GLOBAL};
      if (!bridge || typeof bridge.getWorkbookInfo !== 'function') {
        return {
          ok: false,
          error: {
            code: 'UNSUPPORTED_PROVIDER_STATE',
            message: 'Spreadsheet bridge method is unavailable: getWorkbookInfo'
          }
        };
      }
      return Promise.resolve(bridge.getWorkbookInfo())
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
  const nameBoxProbeExpression = `(() => {
    try {
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
        '[role="textbox"][aria-label*="Name Box"]'
      ];
      const isVisible = (node) => {
        if (!node || typeof node.getBoundingClientRect !== 'function') return false;
        const rect = node.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(node);
        return style.visibility !== 'hidden' && style.display !== 'none';
      };
      let hasVisibleNameBox = false;
      for (const selector of selectors) {
        const nodes = Array.from(document.querySelectorAll(selector));
        for (const node of nodes) {
          if (isVisible(node)) {
            hasVisibleNameBox = true;
            break;
          }
        }
        if (hasVisibleNameBox) break;
      }
      return { ok: true, value: { hasVisibleNameBox } };
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

  const parseBridgePayload = (value: unknown): BridgeRunResult => {
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
  };

  const parseBridgeResponse = (response: Protocol.Runtime.EvaluateResponse): BridgeRunResult => {
    if (response.exceptionDetails) {
      return {
        ok: false,
        error: {
          code: 'UNSUPPORTED_PROVIDER_STATE',
          message: response.exceptionDetails.text || `Bridge call "${method}" failed`,
        },
      };
    }
    return parseBridgePayload(response.result?.value);
  };

  const readContextUrl = async (contextId: number): Promise<string | null> => {
    try {
      const response = await page.sendCDP<Protocol.Runtime.EvaluateResponse>('Runtime.evaluate', {
        expression: 'window.location.href',
        contextId,
        returnByValue: true,
        awaitPromise: true,
      });
      if (response.exceptionDetails) return null;
      const value = response.result?.value;
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  };

  const executeBridgeExpressionInContext = async (
    expressionToRun: string,
    contextId?: number,
  ): Promise<BridgeRunResult> => {
    if (typeof contextId === 'number') {
      const contextUrl = await readContextUrl(contextId);
      const bridgeScript = getBridgeScriptForUrl(contextUrl, pageProvider);
      const bootstrap = await page.sendCDP<Protocol.Runtime.EvaluateResponse>('Runtime.evaluate', {
        expression: bridgeScript,
        contextId,
        returnByValue: true,
        awaitPromise: true,
      });
      if (bootstrap.exceptionDetails) {
        return {
          ok: false,
          error: {
            code: 'UNSUPPORTED_PROVIDER_STATE',
            message:
              bootstrap.exceptionDetails.text ||
              `Bridge bootstrap failed in frame context for "${method}"`,
          },
        };
      }
    }

    const params: Protocol.Runtime.EvaluateRequest = {
      expression: expressionToRun,
      returnByValue: true,
      awaitPromise: true,
      ...(typeof contextId === 'number' ? { contextId } : {}),
    };
    const response = await page.sendCDP<Protocol.Runtime.EvaluateResponse>('Runtime.evaluate', params);
    return parseBridgeResponse(response);
  };
  const executeInContext = async (contextId?: number): Promise<BridgeRunResult> => {
    return await executeBridgeExpressionInContext(expression, contextId);
  };
  const executeWorkbookInfoInContext = async (contextId?: number): Promise<BridgeRunResult> => {
    return await executeBridgeExpressionInContext(workbookInfoExpression, contextId);
  };

  const isSuccessfulPayload = (result: BridgeRunResult): boolean => {
    if (!('value' in result)) return false;
    if (!result.value || typeof result.value !== 'object') return true;
    if (!('success' in (result.value as Record<string, unknown>))) return true;
    return (result.value as { success?: unknown }).success === true;
  };

  const workbookScore = (result: BridgeRunResult): number => {
    if (!('value' in result)) return -1;
    const payload = result.value && typeof result.value === 'object' ? (result.value as Record<string, unknown>) : {};
    const totalSheets =
      typeof payload.total_sheets === 'number'
        ? payload.total_sheets
        : typeof payload.totalSheets === 'number'
          ? payload.totalSheets
          : 0;
    const activeSelection = typeof payload.activeSelectionA1 === 'string' ? payload.activeSelectionA1 : '';
    const activeSheet = typeof payload.active_sheet === 'string' ? payload.active_sheet : '';
    return totalSheets * 10 + (activeSelection ? 2 : 0) + (activeSheet ? 1 : 0);
  };

  const collectFrameIds = async (): Promise<string[]> => {
    try {
      const frameTreeResponse = await page.sendCDP<Protocol.Page.GetFrameTreeResponse>('Page.getFrameTree');
      const frameIds: string[] = [];
      const visit = (node?: Protocol.Page.FrameTree): void => {
        if (!node || !node.frame?.id) return;
        frameIds.push(node.frame.id);
        const children = Array.isArray(node.childFrames) ? node.childFrames : [];
        for (const child of children) {
          visit(child);
        }
      };
      visit(frameTreeResponse.frameTree);
      return frameIds;
    } catch {
      return [];
    }
  };
  const collectExecutionContextIds = async (): Promise<number[]> => {
    const frameIds = await collectFrameIds();
    if (frameIds.length <= 1) return [];
    const executionContextIds: number[] = [];
    for (const frameId of frameIds.slice(1)) {
      let isolatedWorld: Protocol.Page.CreateIsolatedWorldResponse | null = null;
      try {
        isolatedWorld = await page.sendCDP<Protocol.Page.CreateIsolatedWorldResponse>(
          'Page.createIsolatedWorld',
          {
            frameId,
            worldName: `cuaSpreadsheetBridge:${method}`,
          },
        );
      } catch {
        continue;
      }
      const executionContextId = isolatedWorld?.executionContextId;
      if (typeof executionContextId === 'number') {
        executionContextIds.push(executionContextId);
      }
    }
    return executionContextIds;
  };

  const executeViaFrameEvaluate = async (): Promise<BridgeRunResult | null> => {
    const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
      return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Frame evaluation timeout after ${ms}ms`));
        }, ms);
        promise
          .then((value) => {
            clearTimeout(timer);
            resolve(value);
          })
          .catch((error) => {
            clearTimeout(timer);
            reject(error);
          });
      });
    };

    const pageWithFrames = page as unknown as {
      evaluate?: (expression: string) => Promise<unknown>;
      frames?: () => unknown[];
    };
    const frameCandidates: unknown[] = [];
    if (typeof pageWithFrames.evaluate === 'function') {
      frameCandidates.push(pageWithFrames);
    }
    if (typeof pageWithFrames.frames === 'function') {
      try {
        const frames = pageWithFrames.frames();
        if (Array.isArray(frames)) {
          frameCandidates.push(...frames);
        }
      } catch {
        // ignore
      }
    }

    if (frameCandidates.length === 0) return null;

    const entries: Array<{
      result: BridgeRunResult;
      workbookScore: number;
      hasVisibleNameBox: boolean;
      rankOrder: number;
    }> = [];
    let rankOrder = 0;
    for (const frameCandidate of frameCandidates) {
      const frameLike = frameCandidate as {
        evaluate?: (expression: string) => Promise<unknown>;
        url?: (() => string) | string;
      };
      if (typeof frameLike.evaluate !== 'function') continue;
      const frameUrl =
        typeof frameLike.url === 'function'
          ? frameLike.url()
          : typeof frameLike.url === 'string'
            ? frameLike.url
            : null;
      const bridgeScript = getBridgeScriptForUrl(frameUrl ?? page.url(), pageProvider);

      try {
        await withTimeout(frameLike.evaluate(bridgeScript), 2500);
      } catch {
        continue;
      }

      let score = -1;
      try {
        const workbookPayload = await withTimeout(frameLike.evaluate(workbookInfoExpression), 2500);
        score = workbookScore(parseBridgePayload(workbookPayload));
      } catch {
        // keep default score
      }

      let hasVisibleNameBox = false;
      try {
        const nameBoxPayload = await withTimeout(frameLike.evaluate(nameBoxProbeExpression), 2500);
        const parsed = parseBridgePayload(nameBoxPayload);
        hasVisibleNameBox = Boolean(
          'value' in parsed &&
            parsed.value &&
            typeof parsed.value === 'object' &&
            (parsed.value as { hasVisibleNameBox?: unknown }).hasVisibleNameBox === true,
        );
      } catch {
        // keep default false
      }

      try {
        const payload = await withTimeout(frameLike.evaluate(expression), 2500);
        entries.push({
          result: parseBridgePayload(payload),
          workbookScore: score,
          hasVisibleNameBox,
          rankOrder: rankOrder++,
        });
      } catch {
        // ignore and continue
      }
    }

    if (entries.length === 0) return null;
    if (method !== 'getWorkbookInfo') {
      const ranked = entries.slice().sort((left, right) => {
        if (left.hasVisibleNameBox !== right.hasVisibleNameBox) {
          return left.hasVisibleNameBox ? -1 : 1;
        }
        if (right.workbookScore !== left.workbookScore) return right.workbookScore - left.workbookScore;
        return right.rankOrder - left.rankOrder;
      });
      const successful = ranked.find((entry) => isSuccessfulPayload(entry.result));
      if (successful) return successful.result;
      return ranked[0]?.result ?? null;
    }

    let best = entries[0].result;
    let bestScore = workbookScore(best);
    for (const entry of entries.slice(1)) {
      const score = workbookScore(entry.result);
      if (score > bestScore) {
        best = entry.result;
        bestScore = score;
      }
    }
    return best;
  };

  try {
    const frameEvalResult = await executeViaFrameEvaluate();
    if (frameEvalResult && isSuccessfulPayload(frameEvalResult)) {
      return frameEvalResult;
    }
    if (method === 'getWorkbookInfo' && frameEvalResult) {
      return frameEvalResult;
    }

    const contextIds = await collectExecutionContextIds();

    if (method !== 'getWorkbookInfo') {
      const rankedCandidates: Array<{
        contextId?: number;
        workbookScore: number;
        hasVisibleNameBox: boolean;
        rankOrder: number;
      }> = [];
      const topWorkbookInfo = await executeWorkbookInfoInContext();
      const topNameBoxProbe = await executeBridgeExpressionInContext(nameBoxProbeExpression);
      const topHasVisibleNameBox = Boolean(
        'value' in topNameBoxProbe &&
          topNameBoxProbe.value &&
          typeof topNameBoxProbe.value === 'object' &&
          (topNameBoxProbe.value as { hasVisibleNameBox?: unknown }).hasVisibleNameBox === true,
      );
      rankedCandidates.push({
        contextId: undefined,
        workbookScore: workbookScore(topWorkbookInfo),
        hasVisibleNameBox: topHasVisibleNameBox,
        rankOrder: 0,
      });
      contextIds.forEach((contextId, index) => {
        rankedCandidates.push({
          contextId,
          workbookScore: -1,
          hasVisibleNameBox: false,
          rankOrder: index + 1,
        });
      });
      for (const candidate of rankedCandidates) {
        if (typeof candidate.contextId !== 'number') continue;
        const workbookInfo = await executeWorkbookInfoInContext(candidate.contextId);
        candidate.workbookScore = workbookScore(workbookInfo);
        const nameBoxProbe = await executeBridgeExpressionInContext(
          nameBoxProbeExpression,
          candidate.contextId,
        );
        candidate.hasVisibleNameBox = Boolean(
          'value' in nameBoxProbe &&
            nameBoxProbe.value &&
            typeof nameBoxProbe.value === 'object' &&
            (nameBoxProbe.value as { hasVisibleNameBox?: unknown }).hasVisibleNameBox === true,
        );
      }
      rankedCandidates.sort((left, right) => {
        if (left.hasVisibleNameBox !== right.hasVisibleNameBox) {
          return left.hasVisibleNameBox ? -1 : 1;
        }
        if (right.workbookScore !== left.workbookScore) return right.workbookScore - left.workbookScore;
        return right.rankOrder - left.rankOrder;
      });

      let firstFailureResult: BridgeRunResult | null = null;
      for (const candidate of rankedCandidates) {
        const candidateResult = await executeInContext(candidate.contextId);
        if (isSuccessfulPayload(candidateResult)) {
          return candidateResult;
        }
        if (!firstFailureResult) {
          firstFailureResult = candidateResult;
        }
      }
      if (firstFailureResult) {
        return firstFailureResult;
      }
    }

    const topResult = await executeInContext();
    if (method !== 'getWorkbookInfo' && isSuccessfulPayload(topResult)) {
      return topResult;
    }

    if (contextIds.length === 0) {
      return topResult;
    }

    let bestWorkbookInfoResult = topResult;
    let bestWorkbookInfoScore = method === 'getWorkbookInfo' ? workbookScore(topResult) : -1;
    let firstFrameFailureResult: BridgeRunResult | null = null;

    for (const executionContextId of contextIds) {
      const frameResult = await executeInContext(executionContextId);
      if (method !== 'getWorkbookInfo') {
        if (isSuccessfulPayload(frameResult)) {
          return frameResult;
        }
        if (!firstFrameFailureResult) {
          firstFrameFailureResult = frameResult;
        }
        continue;
      }

      const score = workbookScore(frameResult);
      if (score > bestWorkbookInfoScore) {
        bestWorkbookInfoResult = frameResult;
        bestWorkbookInfoScore = score;
      }
    }

    return method === 'getWorkbookInfo' ? bestWorkbookInfoResult : firstFrameFailureResult ?? topResult;
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

import 'dotenv/config';
import axios from 'axios';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page as PlaywrightPage,
} from 'playwright-core';
import { PrismaClient } from '../libs/prisma/generated/prisma/client';
import { createBrowserTabTools } from '../apps/cua-agent/orchestrator/agent-tools';
import { EXCEL_TOOL_NAMES } from '../apps/cua-agent/orchestrator/agent-tools/spreadsheet/constants';
import { getSpreadsheetProvider } from '../apps/cua-agent/orchestrator/agent-tools/spreadsheet/detection';
import type { CdpPageLike } from '../apps/cua-agent/orchestrator/agent-tools/types';
import {
  acquireBrowserbaseSessionCreateLease,
  releaseBrowserbaseSession,
} from '../apps/cua-agent/browserbase-session-limiter';

const DEFAULT_EMAIL = 'robert.victor.muresan@gmail.com';
const DEFAULT_EXCEL_HOME_URL = 'https://excel.office.com/';
const DEFAULT_TEST_CELL_A1 = 'ZZ1000';
const BROWSERBASE_API_URL = 'https://api.browserbase.com/v1';

type CliArgs = {
  email: string;
  workbookUrl?: string;
  help: boolean;
};

type ToolLike = {
  execute?: (args: Record<string, unknown>, context?: unknown) => Promise<unknown> | unknown;
};

type ToolTest = {
  toolName: string;
  args: Record<string, unknown>;
  expect?: (result: unknown) => string | null;
};

type ToolRunResult = {
  toolName: string;
  args: Record<string, unknown>;
  ok: boolean;
  output?: unknown;
  error?: string;
};

type BrowserbaseSessionInfo = {
  id: string;
  connectUrl?: string;
};

const NAME_BOX_SELECTORS = [
  '#t-name-box',
  '#FormulaBar-NameBox-input',
  'input[aria-label="Name box"]',
  'input[aria-label*="Name box"]',
  'input[aria-label*="Name Box"]',
  'input[role="combobox"][aria-label*="Name box"]',
  'input[role="combobox"][aria-label*="Name Box"]',
  'input[id*="NameBox"]',
  'input[id*="NameBox-input"]',
  'input[data-automationid*="NameBox"]',
  '[data-automationid*="NameBox"] input',
  '[role="textbox"][aria-label*="Name box"]',
  '[role="textbox"][aria-label*="Name Box"]',
] as const;

class PlaywrightCdpPageAdapter implements CdpPageLike {
  constructor(
    public readonly playwrightPage: PlaywrightPage,
    private readonly cdpSession: CDPSession,
  ) {}

  url(): string {
    return this.playwrightPage.url();
  }

  async title(): Promise<string> {
    return await this.playwrightPage.title();
  }

  async waitForLoadState(
    state: 'load' | 'domcontentloaded' | 'networkidle',
    timeoutMs?: number,
  ): Promise<void> {
    await this.playwrightPage.waitForLoadState(state, {
      timeout: typeof timeoutMs === 'number' ? timeoutMs : undefined,
    });
  }

  async keyPress(key: string, options?: { delay?: number }): Promise<void> {
    await this.playwrightPage.keyboard.press(key, options);
  }

  async sendCDP<T = unknown>(method: string, params?: object): Promise<T> {
    return await this.cdpSession.send(method as any, params as any);
  }

  evaluate(expression: string): Promise<unknown> {
    return this.playwrightPage.evaluate(expression);
  }

  frames(): unknown[] {
    return this.playwrightPage.frames();
  }

  async dispose(): Promise<void> {
    try {
      await this.cdpSession.detach();
    } catch {
      // ignore detach errors
    }
  }
}

class StagehandContextAdapter {
  private readonly adapters = new Map<PlaywrightPage, PlaywrightCdpPageAdapter>();
  private active: PlaywrightCdpPageAdapter | null = null;

  constructor(private readonly browserContext: BrowserContext) {}

  private async getOrCreateAdapter(page: PlaywrightPage): Promise<PlaywrightCdpPageAdapter> {
    const existing = this.adapters.get(page);
    if (existing) return existing;

    const session = await this.browserContext.newCDPSession(page);
    const adapter = new PlaywrightCdpPageAdapter(page, session);
    this.adapters.set(page, adapter);
    return adapter;
  }

  async refresh(): Promise<void> {
    const rawPages = this.browserContext.pages();
    for (const page of rawPages) {
      await this.getOrCreateAdapter(page);
    }

    for (const [page, adapter] of this.adapters.entries()) {
      if (!rawPages.includes(page)) {
        await adapter.dispose();
        this.adapters.delete(page);
      }
    }

    const pages = this.pages();
    if (!this.active && pages.length > 0) this.active = pages[0];
  }

  pages(): PlaywrightCdpPageAdapter[] {
    const rawPages = this.browserContext.pages();
    return rawPages
      .map((page) => this.adapters.get(page))
      .filter((adapter): adapter is PlaywrightCdpPageAdapter => !!adapter);
  }

  activePage(): PlaywrightCdpPageAdapter | null {
    const pages = this.pages();
    if (this.active && pages.includes(this.active)) return this.active;
    this.active = pages[0] ?? null;
    return this.active;
  }

  setActivePage(page: CdpPageLike): void {
    if (page instanceof PlaywrightCdpPageAdapter) {
      this.active = page;
    }
  }

  setActivePlaywrightPage(page: PlaywrightPage): void {
    const adapter = this.adapters.get(page);
    if (adapter) {
      this.active = adapter;
    }
  }

  async dispose(): Promise<void> {
    const all = Array.from(this.adapters.values());
    await Promise.all(all.map((adapter) => adapter.dispose()));
    this.adapters.clear();
    this.active = null;
  }
}

function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    email: DEFAULT_EMAIL,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
    if (token === '--email' && i + 1 < argv.length) {
      args.email = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--workbook-url' && i + 1 < argv.length) {
      args.workbookUrl = argv[i + 1];
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function printHelp(): void {
  console.log(`Excel tool smoke test

Usage:
  npx tsx scripts/test-excel-tools.ts [--email <user-email>] [--workbook-url <url>]

Flags:
  --email         User email used to resolve browserbaseContextId (default: ${DEFAULT_EMAIL})
  --workbook-url  Workbook URL to open directly. If omitted, script opens ${DEFAULT_EXCEL_HOME_URL} and tries to open a workbook from the UI.
  --help          Show this help.

Required env vars:
  BROWSERBASE_API_KEY
  BROWSERBASE_PROJECT_ID

Optional env vars:
  EXCEL_WORKBOOK_URL (used if --workbook-url is not provided)
`);
}

function assertRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function shortJson(value: unknown, max = 500): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max)}...`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return await new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(fallback);
      });
  });
}

async function waitForExcelWorkbookPage(page: PlaywrightPage, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getSpreadsheetProvider(page.url()) === 'excel_web') return true;
    await wait(300);
  }
  return getSpreadsheetProvider(page.url()) === 'excel_web';
}

async function tryOpenWorkbookFromExcelHome(page: PlaywrightPage): Promise<void> {
  const clickRecentWorkbook = await page.evaluate(() => {
    const doc = (globalThis as any).document;
    if (!doc) return false;
    const selectors = [
      'a[href*="docid="]',
      'a[href*="resid="]',
      'a[href*="/open/onedrive/"]',
      'a[href*="/open/sharepoint/"]',
      'a[href*="/x/"]',
      'a[href*="xlviewer"]',
      'a[href*="/workbook"]',
    ];
    const links: any[] = [];
    for (const selector of selectors) {
      for (const node of Array.from(doc.querySelectorAll(selector))) {
        if (!node || typeof (node as any).click !== 'function') continue;
        links.push(node);
      }
      if (links.length > 0) break;
    }
    const target = links.find((link) => {
      const rect = link.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (!target) return false;
    target.click();
    return true;
  });

  if (clickRecentWorkbook) {
    await page.waitForTimeout(500);
    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
    if (getSpreadsheetProvider(page.url()) === 'excel_web') return;
  }

  const clickBlankWorkbook = await page.evaluate(() => {
    const doc = (globalThis as any).document;
    if (!doc) return false;
    const candidates = Array.from(doc.querySelectorAll('button, [role="button"], a')) as any[];
    const wanted = ['blank workbook', 'new blank workbook', 'empty workbook'];
    for (const candidate of candidates) {
      const text = `${candidate.textContent || ''} ${candidate.getAttribute('aria-label') || ''}`
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      if (!wanted.some((needle) => text.includes(needle))) continue;
      const rect = candidate.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      candidate.click();
      return true;
    }
    return false;
  });

  if (clickBlankWorkbook) {
    await page.waitForTimeout(500);
    await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {});
  }
}

type FrameLike = {
  evaluate: <T>(fn: (...args: any[]) => T | Promise<T>, arg?: unknown) => Promise<T>;
};

async function hasNameBoxInFrame(frame: FrameLike): Promise<boolean> {
  return await frame.evaluate((selectors: readonly string[]) => {
    const doc = (globalThis as any).document;
    if (!doc) return false;
    for (const selector of selectors) {
      const nodes = Array.from(doc.querySelectorAll(selector)) as any[];
      for (const node of nodes) {
        if (!node || typeof node.getBoundingClientRect !== 'function') continue;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        return true;
      }
    }
    return false;
  }, NAME_BOX_SELECTORS);
}

async function hasWorkbookNameBox(page: PlaywrightPage): Promise<boolean> {
  if (await withTimeout(hasNameBoxInFrame(page as unknown as FrameLike), 1_500, false)) return true;
  const frames = page.frames();
  for (const frame of frames) {
    const frameUrl = frame.url().toLowerCase();
    const isWorkbookLikeFrame =
      frameUrl.includes('excel.officeapps.live.com') ||
      frameUrl.includes('excel.cloud.microsoft/open/');
    if (!isWorkbookLikeFrame) continue;
    try {
      if (await withTimeout(hasNameBoxInFrame(frame as unknown as FrameLike), 1_500, false)) return true;
    } catch {
      // Ignore inaccessible/transitioning frames.
    }
  }
  return false;
}

async function findWorkbookReadyPage(browserContext: BrowserContext): Promise<PlaywrightPage | null> {
  for (const candidate of browserContext.pages()) {
    if (getSpreadsheetProvider(candidate.url()) !== 'excel_web') continue;
    if (await hasWorkbookNameBox(candidate)) return candidate;
  }
  return null;
}

function ensureSuccessResult(result: unknown): string | null {
  if (!result || typeof result !== 'object') return 'Tool returned non-object response.';
  if (!('success' in result)) return null;
  return (result as { success?: unknown }).success === true ? null : 'Tool returned success=false.';
}

async function invokeTool(
  tools: Record<string, ToolLike>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = tools[toolName];
  if (!tool || typeof tool.execute !== 'function') {
    throw new Error(`Tool "${toolName}" is unavailable in createBrowserTabTools.`);
  }
  return await tool.execute(args, {
    toolCallId: `manual-${toolName}-${Date.now()}`,
    messages: [],
  });
}

async function runToolTests(
  tools: Record<string, ToolLike>,
  tests: ToolTest[],
): Promise<ToolRunResult[]> {
  const results: ToolRunResult[] = [];
  for (const test of tests) {
    console.log(`\n[TEST] ${test.toolName}(${shortJson(test.args, 160)})`);
    try {
      const output = await invokeTool(tools, test.toolName, test.args);
      const successError = ensureSuccessResult(output);
      const customError = test.expect ? test.expect(output) : null;
      const error = successError ?? customError;
      const ok = !error;
      console.log(`[RESULT] ${ok ? 'PASS' : 'FAIL'} ${test.toolName}`);
      console.log(`[OUTPUT] ${shortJson(output, 700)}`);
      results.push({
        toolName: test.toolName,
        args: test.args,
        ok,
        output,
        ...(error ? { error } : {}),
      });
    } catch (error: any) {
      const message = error?.message ?? String(error);
      console.log(`[RESULT] FAIL ${test.toolName}`);
      console.log(`[ERROR] ${message}`);
      results.push({
        toolName: test.toolName,
        args: test.args,
        ok: false,
        error: message,
      });
    }
  }
  return results;
}

function extractWorkbookSheetCount(result: unknown): number {
  if (!result || typeof result !== 'object') return 0;
  const payload = result as Record<string, unknown>;
  if (payload.success !== true) return 0;
  if (typeof payload.total_sheets === 'number') return payload.total_sheets;
  if (typeof payload.totalSheets === 'number') return payload.totalSheets;
  return 0;
}

async function createBrowserbaseSession(
  apiKey: string,
  projectId: string,
  contextId: string,
): Promise<BrowserbaseSessionInfo> {
  const response = await axios.post(
    `${BROWSERBASE_API_URL}/sessions`,
    {
      projectId,
      keepAlive: true,
      browserSettings: {
        recordSession: true,
        timeout: 3600,
        blockAds: true,
        context: {
          id: contextId,
          persist: true,
        },
      },
    },
    {
      headers: {
        'x-bb-api-key': apiKey,
        'Content-Type': 'application/json',
      },
    },
  );

  const data = response.data as BrowserbaseSessionInfo;
  if (!data?.id) {
    throw new Error('Browserbase session response missing id.');
  }
  return data;
}

async function requestReleaseBrowserbaseSession(
  apiKey: string,
  projectId: string,
  sessionId: string,
): Promise<void> {
  await axios.post(
    `${BROWSERBASE_API_URL}/sessions/${sessionId}`,
    {
      status: 'REQUEST_RELEASE',
      projectId,
    },
    {
      headers: {
        'x-bb-api-key': apiKey,
        'Content-Type': 'application/json',
      },
    },
  );
}

function resolveBrowserbaseCdpUrl(apiKey: string, session: BrowserbaseSessionInfo): string {
  if (
    session.connectUrl &&
    typeof session.connectUrl === 'string' &&
    session.connectUrl.length > 0
  ) {
    return session.connectUrl;
  }
  return `wss://connect.browserbase.com?apiKey=${apiKey}&sessionId=${session.id}`;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const browserbaseApiKey = assertRequiredEnv('BROWSERBASE_API_KEY');
  const projectId = assertRequiredEnv('BROWSERBASE_PROJECT_ID');

  const prisma = new PrismaClient();
  let browser: Browser | null = null;
  let stagehandContext: StagehandContextAdapter | null = null;
  let sessionId: string | null = null;
  let leaseConfirmed = false;
  const createLease = await acquireBrowserbaseSessionCreateLease('scripts:test-excel-tools');

  try {
    const user = await prisma.user.findUnique({
      where: { email: args.email },
      include: { userContext: true },
    });
    if (!user) {
      throw new Error(`No user found for email: ${args.email}`);
    }
    if (!user.userContext?.browserbaseContextId) {
      throw new Error(`No browserbaseContextId found for user: ${args.email}`);
    }

    const contextId = user.userContext.browserbaseContextId;
    console.log(`[INFO] Using user=${args.email} contextId=${contextId}`);

    const session = await createBrowserbaseSession(browserbaseApiKey, projectId, contextId);
    sessionId = session.id;
    createLease.confirmCreated(session.id);
    leaseConfirmed = true;

    const liveViewUrl = `https://browserbase.com/sessions/${session.id}`;
    const cdpUrl = resolveBrowserbaseCdpUrl(browserbaseApiKey, session);
    console.log(`[INFO] Browserbase session: ${session.id}`);
    console.log(`[INFO] Live view: ${liveViewUrl}`);
    console.log(`[INFO] CDP URL: ${cdpUrl}`);

    browser = await chromium.connectOverCDP(cdpUrl);
    const browserContext = browser.contexts()[0] ?? (await browser.newContext());
    let page = browserContext.pages()[0] ?? (await browserContext.newPage());

    const workbookUrl = args.workbookUrl || process.env.EXCEL_WORKBOOK_URL;
    if (workbookUrl) {
      console.log(`[INFO] Navigating to workbook URL: ${workbookUrl}`);
      await page.goto(workbookUrl, { waitUntil: 'domcontentloaded' });
    } else {
      console.log(`[INFO] Navigating to Excel home: ${DEFAULT_EXCEL_HOME_URL}`);
      await page.goto(DEFAULT_EXCEL_HOME_URL, { waitUntil: 'domcontentloaded' });
      await tryOpenWorkbookFromExcelHome(page);
    }

    const onWorkbookPage = await waitForExcelWorkbookPage(page, 30_000);
    if (!onWorkbookPage) {
      throw new Error(
        `Could not reach an Excel workbook page. Current URL: ${page.url()}. ` +
          'Pass --workbook-url or set EXCEL_WORKBOOK_URL for deterministic execution.',
      );
    }
    console.log(`[INFO] Workbook page detected: ${page.url()}`);

    stagehandContext = new StagehandContextAdapter(browserContext);
    await stagehandContext.refresh();
    stagehandContext.setActivePlaywrightPage(page);

    const tools = createBrowserTabTools({
      context: {
        pages: (): CdpPageLike[] => stagehandContext!.pages(),
        activePage: (): CdpPageLike | null => stagehandContext!.activePage(),
        setActivePage: (page: CdpPageLike) => stagehandContext!.setActivePage(page),
      },
    } as any) as unknown as Record<string, ToolLike>;

    const missingTools = EXCEL_TOOL_NAMES.filter((toolName) => !(toolName in tools));
    if (missingTools.length > 0) {
      throw new Error(`Missing Excel tools in createBrowserTabTools: ${missingTools.join(', ')}`);
    }

    let workbookInfo: unknown = null;
    let totalSheets = 0;
    const readinessDeadline = Date.now() + 120_000;
    let lastOpenAttemptAt = 0;
    while (Date.now() < readinessDeadline) {
      await stagehandContext.refresh();

      const readyPage = await findWorkbookReadyPage(browserContext);
      if (readyPage && readyPage !== page) {
        page = readyPage;
        await page.bringToFront().catch(() => {});
        stagehandContext.setActivePlaywrightPage(page);
        console.log(`[INFO] Switched to workbook tab: ${page.url()}`);
      }

      workbookInfo = await invokeTool(tools, 'excel_get_workbook_info', {});
      totalSheets = extractWorkbookSheetCount(workbookInfo);
      if (totalSheets > 0) break;

      const now = Date.now();
      if (now - lastOpenAttemptAt > 8_000) {
        await tryOpenWorkbookFromExcelHome(page).catch(() => {});
        lastOpenAttemptAt = now;
      }
      await wait(1_000);
    }

    if (totalSheets < 1) {
      throw new Error(
        `Workbook surface is still not usable (excel_get_workbook_info.total_sheets=${totalSheets}). ` +
          `Current URL: ${page.url()}`,
      );
    }
    console.log(`[INFO] Workbook tool surface ready (total_sheets=${totalSheets}).`);

    const baselineValueResult = await invokeTool(tools, 'excel_read_cell', {
      cell_a1: DEFAULT_TEST_CELL_A1,
    });
    const baselineValue =
      baselineValueResult &&
      typeof baselineValueResult === 'object' &&
      'value' in baselineValueResult &&
      typeof (baselineValueResult as { value?: unknown }).value === 'string'
        ? (baselineValueResult as { value: string }).value
        : '';

    const writeValue = `excel-tool-test-${Date.now()}`;

    const tests: ToolTest[] = [
      { toolName: 'excel_get_workbook_info', args: {} },
      { toolName: 'excel_select_cell', args: { cell_a1: 'A1' } },
      { toolName: 'excel_read_cell', args: { cell_a1: 'A1' } },
      { toolName: 'excel_set_cell', args: { cell_a1: DEFAULT_TEST_CELL_A1, value: writeValue } },
      {
        toolName: 'excel_read_cell',
        args: { cell_a1: DEFAULT_TEST_CELL_A1 },
        expect: (result) => {
          if (!result || typeof result !== 'object') return 'Read result is not an object.';
          const value = (result as { value?: unknown }).value;
          return value === writeValue
            ? null
            : `Expected ${DEFAULT_TEST_CELL_A1}="${writeValue}", got "${String(value ?? '')}".`;
        },
      },
      { toolName: 'excel_set_cell', args: { cell_a1: DEFAULT_TEST_CELL_A1, value: baselineValue } },
      { toolName: 'excel_read_sheet', args: { start_row: 1, width: 220 } },
      { toolName: 'excel_insert_rows', args: { position: 1000, count: 1 } },
      { toolName: 'excel_delete_row', args: { position: 1000 } },
      { toolName: 'excel_insert_columns', args: { position: 50, count: 1 } },
      { toolName: 'excel_delete_column', args: { position: 50 } },
    ];

    const results = await runToolTests(tools, tests);
    const passCount = results.filter((entry) => entry.ok).length;
    const failCount = results.length - passCount;

    console.log('\n=== Excel Tool Test Summary ===');
    console.log(`Total: ${results.length}`);
    console.log(`Passed: ${passCount}`);
    console.log(`Failed: ${failCount}`);

    if (failCount > 0) {
      console.log('\nFailed tests:');
      for (const entry of results.filter((result) => !result.ok)) {
        console.log(`- ${entry.toolName}: ${entry.error ?? 'unknown error'}`);
      }
      process.exitCode = 1;
    }
  } finally {
    try {
      if (stagehandContext) {
        await stagehandContext.dispose();
      }
    } catch (error: any) {
      console.warn(`[WARN] Failed to dispose context adapters: ${error?.message ?? error}`);
    }
    try {
      if (browser) {
        await browser.close();
      }
    } catch (error: any) {
      console.warn(`[WARN] Failed to close browser: ${error?.message ?? error}`);
    }
    if (sessionId) {
      try {
        await requestReleaseBrowserbaseSession(browserbaseApiKey, projectId, sessionId);
      } catch (error: any) {
        console.warn(
          `[WARN] Failed to request Browserbase release for ${sessionId}: ${error?.message ?? error}`,
        );
      }
      releaseBrowserbaseSession(sessionId);
    } else if (!leaseConfirmed) {
      createLease.cancel();
    }
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('[FATAL]', error?.message ?? error);
  process.exit(1);
});

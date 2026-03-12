import { Injectable, NotFoundException } from '@nestjs/common';
import { Hyperbrowser } from '@hyperbrowser/sdk';
import type { SessionRegion } from '@hyperbrowser/sdk/types';
import { chromium, type Browser } from 'playwright-core';
import {
  BrowserProvider,
  CreateBrowserSessionOptions,
  BrowserSessionResult,
  InitSessionOptions,
  InitSessionResult,
  PageInfo,
  SessionDebugInfoResult,
  SessionUploadFile,
} from './browser-provider.interface';

type HyperbrowserRegion = SessionRegion;

const DEFAULT_HYPERBROWSER_REGION: HyperbrowserRegion = 'us-east';
const DEFAULT_INITIAL_PAGE_URL = 'https://duckduckgo.com';
const DEFAULT_INITIAL_PAGE_TITLE = 'DuckDuckGo';
const HYPERBROWSER_DOWNLOAD_PATH = '/tmp/downloads';
const REGION_UTC_OFFSET_HOURS: Record<HyperbrowserRegion, number> = {
  'us-east': -5,
  'us-west': -8,
  'europe-west': 1,
  'asia-south': 5.5,
  'us-central': -6,
  'us-dev': -8,
};

function circularOffsetDistanceHours(a: number, b: number): number {
  const raw = Math.abs(a - b);
  return Math.min(raw, 24 - raw);
}

function extractUtcOffsetHours(timezone: string): number | null {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(now);

    const getPart = (type: Intl.DateTimeFormatPartTypes): number => {
      const value = parts.find((part) => part.type === type)?.value;
      return value ? Number(value) : Number.NaN;
    };

    const year = getPart('year');
    const month = getPart('month');
    const day = getPart('day');
    const hour = getPart('hour');
    const minute = getPart('minute');
    const second = getPart('second');
    if ([year, month, day, hour, minute, second].some(Number.isNaN)) {
      return null;
    }

    const tzTimestampAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    return (tzTimestampAsUtc - now.getTime()) / 3_600_000;
  } catch {
    return null;
  }
}

function resolveClosestRegion(timezone?: string): HyperbrowserRegion {
  const trimmedTimezone = timezone?.trim();
  if (!trimmedTimezone) {
    return DEFAULT_HYPERBROWSER_REGION;
  }

  const utcOffsetHours = extractUtcOffsetHours(trimmedTimezone);
  if (utcOffsetHours === null) {
    return DEFAULT_HYPERBROWSER_REGION;
  }

  let selectedRegion = DEFAULT_HYPERBROWSER_REGION;
  let smallestDistance = Number.POSITIVE_INFINITY;

  for (const [region, offset] of Object.entries(REGION_UTC_OFFSET_HOURS) as Array<
    [HyperbrowserRegion, number]
  >) {
    const distance = circularOffsetDistanceHours(utcOffsetHours, offset);
    if (distance < smallestDistance) {
      smallestDistance = distance;
      selectedRegion = region;
    }
  }

  return selectedRegion;
}

function getErrorStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const maybeStatusCode = (error as { statusCode?: unknown }).statusCode;
  if (typeof maybeStatusCode === 'number') return maybeStatusCode;

  const maybeStatus = (error as { status?: unknown }).status;
  if (typeof maybeStatus === 'number') return maybeStatus;

  return undefined;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function tryParseUrl(value?: string | null): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function extractTokenFromUrl(value?: string | null): string | null {
  const url = tryParseUrl(value);
  if (!url) return null;

  return (
    url.searchParams.get('vncAuthToken') ||
    url.searchParams.get('token') ||
    url.searchParams.get('authToken')
  );
}

function extractConnectHostFromUrl(value?: string | null): string | null {
  const url = tryParseUrl(value);
  if (!url) return null;

  return /^connect(?:[-.][a-z0-9-]+)?\.hyperbrowser\.ai$/i.test(url.host) ? url.host : null;
}

function extractConnectHostFromLiveUrl(value?: string | null): string | null {
  const url = tryParseUrl(value);
  if (!url) return null;

  const liveDomain = url.searchParams.get('liveDomain');
  return extractConnectHostFromUrl(liveDomain);
}

function buildVncUrl(connectHost: string, token: string): string {
  return `wss://${connectHost}/websockify?vncAuthToken=${encodeURIComponent(token)}`;
}

function extractVncUrl(session: {
  liveUrl?: string | null;
  wsEndpoint?: string | null;
  computerActionEndpoint?: string | null;
  token?: string | null;
}): string | null {
  const liveUrl = session.liveUrl;
  const cdpUrl = session.wsEndpoint ?? session.computerActionEndpoint;
  const tokenCandidates = new Set<string>();
  const hostCandidates = new Set<string>();

  const addToken = (value?: string | null) => {
    const token = value?.trim();
    if (token) tokenCandidates.add(token);
  };

  const addHost = (value?: string | null) => {
    const host = value?.trim();
    if (host) hostCandidates.add(host);
  };

  const htmlTokenMatch = extractTokenFromUrl(liveUrl);
  const htmlHostMatch = extractConnectHostFromUrl(cdpUrl);
  const cdpTokenMatch = extractTokenFromUrl(cdpUrl);
  const vncToken = htmlTokenMatch ?? cdpTokenMatch ?? session.token;
  const wsMatch = htmlHostMatch && vncToken ? buildVncUrl(htmlHostMatch, vncToken) : null;

  addToken(htmlTokenMatch);
  addToken(extractTokenFromUrl(session.wsEndpoint));
  addToken(extractTokenFromUrl(session.computerActionEndpoint));
  addToken(session.token);

  addHost(htmlHostMatch);
  addHost(extractConnectHostFromLiveUrl(liveUrl));
  addHost(extractConnectHostFromUrl(session.wsEndpoint));
  addHost(extractConnectHostFromUrl(session.computerActionEndpoint));

  if (wsMatch) {
    return wsMatch;
  }

  const connectHost = Array.from(hostCandidates)[0];
  const token = Array.from(tokenCandidates)[0];
  return connectHost && token ? buildVncUrl(connectHost, token) : null;
}

@Injectable()
export class HyperbrowserBrowserProvider extends BrowserProvider {
  private readonly apiKey = process.env.HYPERBROWSER_API_KEY;
  private readonly client = this.apiKey ? new Hyperbrowser({ apiKey: this.apiKey }) : null;

  async createSession(options: CreateBrowserSessionOptions): Promise<BrowserSessionResult> {
    const client = this.requireClient();
    const { width, height, contextId, timezone } = options;

    const region = resolveClosestRegion(timezone);
    const profileId = await this.resolveProfileId(contextId);

    const session = await client.sessions.create({
      region,
      timeoutMinutes: 60,
      screen: {
        width: width ? Math.round(width) : 1280,
        height: height ? Math.round(height) : 800,
      },
      profile: profileId
        ? {
            id: profileId,
            persistChanges: true,
          }
        : undefined,
      saveDownloads: true,
      enableWebRecording: true,
      enableVideoWebRecording: true,
      useStealth: true,
      solveCaptchas: true,
      extensionIds: process.env.HYPERBROWSER_EXTENSION_IDS
        ? process.env.HYPERBROWSER_EXTENSION_IDS.split(',')
        : undefined,
      adblock: true,
      trackers: true,
      annoyances: true,
    });

    const connectUrl = session.wsEndpoint
      ? `${session.wsEndpoint}${session.wsEndpoint.includes('?') ? '&' : '?'}keepAlive=true`
      : session.wsEndpoint;

    return {
      ...session,
      connectUrl,
      wsEndpoint: connectUrl,
      profileId,
    };
  }

  async stopSession(sessionId: string): Promise<boolean> {
    const client = this.requireClient();

    try {
      await client.sessions.stop(sessionId);
      return true;
    } catch (error) {
      if (getErrorStatusCode(error) === 404) {
        return true;
      }
      console.error(`[HyperbrowserBrowserProvider] Error stopping session ${sessionId}:`, error);
      return false;
    }
  }

  async getSession(sessionId: string): Promise<any> {
    const client = this.requireClient();

    try {
      return await client.sessions.get(sessionId, { liveViewTtlSeconds: 3600 });
    } catch {
      return null;
    }
  }

  async getSessionDebugInfo(sessionId: string): Promise<SessionDebugInfoResult> {
    const client = this.requireClient();

    try {
      const session = await client.sessions.get(sessionId, { liveViewTtlSeconds: 3600 });

      return {
        session,
        debugInfo: {
          ...session,
          pages: [],
          cdpWsUrlTemplate: session.wsEndpoint,
          liveViewUrl: session.liveUrl,
          vncUrl: extractVncUrl(session),
        },
      };
    } catch {
      return {
        session: null,
        debugInfo: null,
      };
    }
  }

  async getDebugInfo(sessionId: string): Promise<any> {
    const client = this.requireClient();

    try {
      const session = await client.sessions.get(sessionId, { liveViewTtlSeconds: 3600 });

      const vncUrl = extractVncUrl(session);

      return {
        ...session,
        pages: [],
        cdpWsUrlTemplate: '',
        liveViewUrl: session.liveUrl,
        vncUrl: vncUrl ?? undefined,
      };
    } catch {
      throw new NotFoundException('Session not found');
    }
  }

  async initializeSession(
    sessionId: string,
    options?: InitSessionOptions,
  ): Promise<InitSessionResult> {
    const client = this.requireClient();
    const { width, height, connectUrl } = options ?? {};

    try {
      console.log(`[HyperbrowserBrowserProvider] Initializing session ${sessionId}...`);

      const session = await client.sessions.get(sessionId);
      const wsUrl = connectUrl ?? session.wsEndpoint;

      const browser = await chromium.connectOverCDP(wsUrl);
      this.enableDownloadBehavior(browser);

      const defaultContext = browser.contexts()[0];
      if (!defaultContext) {
        return { pages: [] };
      }

      const page = defaultContext.pages()[0] || (await defaultContext.newPage());

      const [tabId] = await Promise.all([this.getTargetId(page)]);

      page.goto(DEFAULT_INITIAL_PAGE_URL, { waitUntil: 'commit' }).catch(() => {});

      const vncUrl = extractVncUrl(session);

      console.log(`[HyperbrowserBrowserProvider] Session ${sessionId} initialized successfully`);
      return {
        pages: [
          {
            id: tabId ?? 'page-0',
            url: DEFAULT_INITIAL_PAGE_URL,
            title: DEFAULT_INITIAL_PAGE_TITLE,
          },
        ],
        cdpWsUrlTemplate: session.wsEndpoint
          ? `${session.wsEndpoint}${session.wsEndpoint.includes('?') ? '&' : '?'}keepAlive=true`
          : session.wsEndpoint,
        liveViewUrl: session.liveUrl,
        vncUrl: vncUrl ?? undefined,
      };
    } catch (error) {
      console.error('[HyperbrowserBrowserProvider] Error initializing session:', error);
      return { pages: [] };
    }
  }

  async uploadSessionFile(
    sessionId: string,
    file: SessionUploadFile,
  ): Promise<{ filePath: string }> {
    const client = this.requireClient();

    if (!file?.buffer?.length) {
      throw new Error('Uploaded file is empty');
    }

    const result = await client.sessions.uploadFile(sessionId, {
      fileInput: file.buffer,
      fileName: file.originalname || 'upload.bin',
    });

    return {
      filePath: (result as any).filePath || `/tmp/uploads/${file.originalname || 'upload.bin'}`,
    };
  }

  async createContext({ name }: { name: string }): Promise<string> {
    const client = this.requireClient();
    const profile = await client.profiles.create({
      name,
    });
    return profile.id;
  }

  private requireClient(): Hyperbrowser {
    if (!this.client) {
      throw new Error('Hyperbrowser API key is not configured');
    }
    return this.client;
  }

  private async resolveProfileId(contextId?: string): Promise<string | undefined> {
    if (!contextId) return undefined;

    const client = this.requireClient();

    // Browserbase context IDs were sometimes persisted as non-UUID values.
    // Hyperbrowser profile IDs must be UUIDs.
    if (!isUuid(contextId)) {
      const profile = await client.profiles.create({ name: `user-${contextId}` });
      return profile.id;
    }

    try {
      await client.profiles.get(contextId);
      return contextId;
    } catch (error) {
      const statusCode = getErrorStatusCode(error);
      if (statusCode === 404 || statusCode === 400) {
        const profile = await client.profiles.create({ name: `user-${contextId}` });
        return profile.id;
      }
      throw error;
    }
  }

  private async enableDownloadBehavior(browser: Browser): Promise<void> {
    const cdp = await browser.newBrowserCDPSession();
    try {
      await cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: HYPERBROWSER_DOWNLOAD_PATH,
        eventsEnabled: true,
      });
    } finally {
      await cdp.detach().catch(() => {});
    }
  }

  private async getTargetId(page: any): Promise<string | undefined> {
    try {
      const cdpSession = await page.context().newCDPSession(page);
      const { targetInfo } = await cdpSession.send('Target.getTargetInfo');
      await cdpSession.detach().catch(() => {});
      return targetInfo.targetId;
    } catch {
      return undefined;
    }
  }
}

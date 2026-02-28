import { Injectable, NotFoundException } from '@nestjs/common';
import { Hyperbrowser } from '@hyperbrowser/sdk';
import type { SessionRegion } from '@hyperbrowser/sdk/types';
import { chromium } from 'playwright-core';
import {
  BrowserProvider,
  BrowserHandle,
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
const DEFAULT_INITIAL_PAGE_URL = 'https://www.google.com';
const DEFAULT_INITIAL_PAGE_TITLE = 'Google';
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
    });

    return {
      ...session,
      connectUrl: session.wsEndpoint,
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

      return {
        ...session,
        pages: [],
        cdpWsUrlTemplate: '',
        liveViewUrl: session.liveUrl,
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
      const defaultContext = browser.contexts()[0];
      if (!defaultContext) {
        return { pages: [] };
      }

      await this.injectInitScript(defaultContext);

      const page = defaultContext.pages()[0] || (await defaultContext.newPage());

      const [tabId] = await Promise.all([
        this.getTargetId(page),
        (async () => {
          if (width && height) {
            await page.setViewportSize({ width: Math.round(width), height: Math.round(height) });
          }
        })(),
      ]);

      page.goto(DEFAULT_INITIAL_PAGE_URL, { waitUntil: 'commit' }).catch(() => {});

      console.log(`[HyperbrowserBrowserProvider] Session ${sessionId} initialized successfully`);
      return {
        pages: [
          {
            id: tabId ?? 'page-0',
            url: DEFAULT_INITIAL_PAGE_URL,
            title: DEFAULT_INITIAL_PAGE_TITLE,
          },
        ],
        cdpWsUrlTemplate: session.wsEndpoint,
        liveViewUrl: session.liveUrl,
      };
    } catch (error) {
      console.error('[HyperbrowserBrowserProvider] Error initializing session:', error);
      return { pages: [] };
    }
  }

  async connectForKeepalive(sessionId: string, connectUrl?: string): Promise<BrowserHandle | null> {
    const client = this.requireClient();

    try {
      const session = await client.sessions.get(sessionId);
      const wsUrl = connectUrl ?? session.wsEndpoint;
      return await chromium.connectOverCDP(wsUrl);
    } catch (error) {
      console.error(
        `[HyperbrowserBrowserProvider] Failed to connect for keepalive: ${sessionId}`,
        error,
      );
      return null;
    }
  }

  async uploadSessionFile(sessionId: string, file: SessionUploadFile): Promise<void> {
    const client = this.requireClient();

    if (!file?.buffer?.length) {
      throw new Error('Uploaded file is empty');
    }

    await client.sessions.uploadFile(sessionId, {
      fileInput: file.buffer,
      fileName: file.originalname || 'upload.bin',
    });
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

  private async injectInitScript(context: any): Promise<void> {
    await context.addInitScript(INIT_SCRIPT);
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

// Injected into every new document to report user interactions back via window.__cdpEvent.
const INIT_SCRIPT = `
(function() {
  if (window.__bbEventListenerInjected) return;
  window.__bbEventListenerInjected = true;

  function reportEvent(data) {
    var json = JSON.stringify(data);
    if (typeof window.__cdpEvent === 'function') {
      try { window.__cdpEvent(json); } catch(e) {}
    }
  }

  function getElementSelector(element) {
    if (!element) return '';
    if (element.id) return '#' + element.id;
    var path = [];
    while (element && element.nodeType === Node.ELEMENT_NODE) {
      var selector = element.nodeName.toLowerCase();
      if (element.className && typeof element.className === 'string') {
        selector += '.' + element.className.trim().split(/\\s+/).join('.');
      }
      path.unshift(selector);
      element = element.parentNode;
      if (path.length > 3) break;
    }
    return path.join(' > ');
  }

  function getElementInfo(element) {
    if (!element) return null;
    return {
      tagName: element.tagName || 'unknown',
      id: element.id || '',
      className: element.className || '',
      selector: getElementSelector(element),
      text: (element.textContent || '').substring(0, 200),
      value: element.value || '',
      href: element.href || '',
      type: element.type || '',
      name: element.name || ''
    };
  }

  document.addEventListener('click', function(e) {
    reportEvent({ type: 'click', x: e.clientX, y: e.clientY, target: getElementInfo(e.target), timestamp: Date.now() });
  }, true);

  document.addEventListener('keydown', function(e) {
    reportEvent({ type: 'keydown', key: e.key, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, target: getElementInfo(e.target), timestamp: Date.now() });
  }, true);
})();
`;

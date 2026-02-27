import { Injectable, NotFoundException } from '@nestjs/common';
import WebSocket from 'ws';
import { Hyperbrowser } from '@hyperbrowser/sdk';
import type { SessionRegion } from '@hyperbrowser/sdk/types';
import {
  BrowserProvider,
  BrowserHandle,
  CreateBrowserSessionOptions,
  BrowserSessionResult,
  InitSessionOptions,
  PageInfo,
  SessionUploadFile,
} from './browser-provider.interface';

type HyperbrowserRegion = SessionRegion;

const DEFAULT_HYPERBROWSER_REGION: HyperbrowserRegion = 'us-east';
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

  async getDebugInfo(sessionId: string): Promise<any> {
    const client = this.requireClient();

    try {
      const session = await client.sessions.get(sessionId, { liveViewTtlSeconds: 3600 });
      // fetchPages may fail if the session is still starting up — don't let it block the proxy URL.
      const pages = await this.fetchPages(session.wsEndpoint, sessionId).catch(() => []);

      const wsBase = (
        process.env.BACKEND_WS_URL || `ws://localhost:${process.env.PORT || 8080}`
      ).replace(/\/$/, '');

      return {
        ...session,
        pages,
        cdpWsUrlTemplate: `${wsBase}/api/cdp-proxy/${sessionId}`,
        liveViewUrl: session.liveUrl,
      };
    } catch {
      throw new NotFoundException('Session not found');
    }
  }

  async initializeSession(sessionId: string, options?: InitSessionOptions): Promise<PageInfo[]> {
    const client = this.requireClient();
    const { width, height, connectUrl } = options ?? {};

    try {
      console.log(`[HyperbrowserBrowserProvider] Initializing session ${sessionId}...`);

      const session = await client.sessions.get(sessionId);
      const wsUrl = connectUrl ?? session.wsEndpoint;

      console.log(`[HyperbrowserBrowserProvider] Session ${sessionId} initialized successfully`);
      return [];
    } catch (error) {
      console.error('[HyperbrowserBrowserProvider] Error initializing session:', error);
      return [];
    }
  }

  async connectForKeepalive(sessionId: string, connectUrl?: string): Promise<BrowserHandle | null> {
    return null;
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

  async createContext(): Promise<string> {
    const client = this.requireClient();
    const profile = await client.profiles.create();
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

  /**
   * Fetch pages by sending Target.getTargets over a temporary raw WebSocket.
   * The keepalive WS keeps the session alive while this temporary connection exists.
   */
  private async fetchPages(connectUrl: string, sessionId?: string): Promise<PageInfo[]> {
    return [];
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

import { Injectable, NotFoundException } from '@nestjs/common';
import axios from 'axios';
import { chromium } from 'playwright-core';
import { Browserbase, toFile } from '@browserbasehq/sdk';
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

type BrowserbaseRegion = 'us-west-2' | 'us-east-1' | 'eu-central-1' | 'ap-southeast-1';

const DEFAULT_BROWSERBASE_REGION: BrowserbaseRegion = 'us-west-2';
const REGION_UTC_OFFSET_HOURS: Record<BrowserbaseRegion, number> = {
  'us-west-2': -8,
  'us-east-1': -5,
  'eu-central-1': 1,
  'ap-southeast-1': 8,
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

function resolveClosestRegion(timezone?: string): BrowserbaseRegion {
  const trimmedTimezone = timezone?.trim();
  if (!trimmedTimezone) {
    return DEFAULT_BROWSERBASE_REGION;
  }

  const utcOffsetHours = extractUtcOffsetHours(trimmedTimezone);
  if (utcOffsetHours === null) {
    return DEFAULT_BROWSERBASE_REGION;
  }

  let selectedRegion = DEFAULT_BROWSERBASE_REGION;
  let smallestDistance = Number.POSITIVE_INFINITY;

  for (const [region, offset] of Object.entries(REGION_UTC_OFFSET_HOURS) as Array<
    [BrowserbaseRegion, number]
  >) {
    const distance = circularOffsetDistanceHours(utcOffsetHours, offset);
    if (distance < smallestDistance) {
      smallestDistance = distance;
      selectedRegion = region;
    }
  }

  return selectedRegion;
}

@Injectable()
export class BrowserbaseBrowserProvider extends BrowserProvider {
  private readonly apiKey = process.env.BROWSERBASE_API_KEY;
  private readonly projectId = process.env.BROWSERBASE_PROJECT_ID;
  private readonly apiUrl = 'https://api.browserbase.com/v1';
  private readonly client = this.apiKey ? new Browserbase({ apiKey: this.apiKey }) : null;

  async createSession(options: CreateBrowserSessionOptions): Promise<BrowserSessionResult> {
    const { colorScheme, width, height, contextId, timezone } = options;
    const region = resolveClosestRegion(timezone);

    const response = await axios.post(
      `${this.apiUrl}/sessions`,
      {
        projectId: this.projectId,
        region,
        keepAlive: true,
        browserSettings: {
          recordSession: true,
          timeout: 3600,
          ...(contextId && {
            context: {
              id: contextId,
              persist: true,
            },
          }),
          viewport: {
            width: width ? Math.round(width) : 1280,
            height: height ? Math.round(height) : 800,
          },
          colorScheme: colorScheme || 'light',
        },
      },
      {
        headers: {
          'x-bb-api-key': this.apiKey,
          'Content-Type': 'application/json',
        },
      },
    );

    return response.data;
  }

  async stopSession(sessionId: string): Promise<boolean> {
    try {
      await axios.post(
        `${this.apiUrl}/sessions/${sessionId}`,
        {
          status: 'REQUEST_RELEASE',
          projectId: this.projectId,
        },
        {
          headers: {
            'x-bb-api-key': this.apiKey,
            'Content-Type': 'application/json',
          },
        },
      );
      return true;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return true;
      }
      console.error(`[BrowserbaseBrowserProvider] Error stopping session ${sessionId}:`, error);
      return false;
    }
  }

  async getSession(sessionId: string): Promise<any> {
    try {
      const response = await axios.get(`${this.apiUrl}/sessions/${sessionId}`, {
        headers: {
          'x-bb-api-key': this.apiKey,
        },
      });
      return response.data;
    } catch (error) {
      return null;
    }
  }

  async getSessionDebugInfo(sessionId: string): Promise<SessionDebugInfoResult> {
    const [session, debugInfo] = await Promise.all([
      this.getSession(sessionId),
      this.getDebugInfo(sessionId),
    ]);

    return { session, debugInfo };
  }

  async getDebugInfo(sessionId: string): Promise<any> {
    try {
      const response = await axios.get(`${this.apiUrl}/sessions/${sessionId}/debug`, {
        headers: {
          'x-bb-api-key': this.apiKey,
        },
      });
      const data = response.data;
      return {
        ...data,
        cdpWsUrlTemplate: `wss://connect.browserbase.com/debug/${sessionId}/devtools/page/{pageId}`,
      };
    } catch (error) {
      throw new NotFoundException('Session not found');
    }
  }

  async initializeSession(
    sessionId: string,
    options?: InitSessionOptions,
  ): Promise<InitSessionResult> {
    try {
      const { colorScheme, width, height, connectUrl } = options ?? {};
      console.log(`[BrowserbaseBrowserProvider] Initializing session ${sessionId}...`);

      const wsUrl =
        connectUrl ?? `wss://connect.browserbase.com?apiKey=${this.apiKey}&sessionId=${sessionId}`;
      const browser = await chromium.connectOverCDP(wsUrl);
      const defaultContext = browser.contexts()[0];
      if (!defaultContext) {
        return { pages: [] };
      }

      await this.injectInitScript(defaultContext);

      const page = defaultContext.pages()[0] || (await defaultContext.newPage());

      const [tabId] = await Promise.all([
        (async () => {
          const cdpSession = await page.context().newCDPSession(page);
          const { targetInfo } = await cdpSession.send('Target.getTargetInfo');
          cdpSession.detach();
          return targetInfo.targetId;
        })(),
        (async () => {
          if (width && height) {
            await page.setViewportSize({ width: Math.round(width), height: Math.round(height) });
          }
        })(),
      ]);

      page.goto('https://www.google.com', { waitUntil: 'commit' }).catch(() => {});

      console.log(`[BrowserbaseBrowserProvider] Session ${sessionId} initialized successfully`);
      return {
        pages: [{ id: tabId, url: 'https://www.google.com', title: 'Google' }],
        cdpWsUrlTemplate: `wss://connect.browserbase.com/debug/${sessionId}/devtools/page/{pageId}`,
      };
    } catch (error) {
      console.error('[BrowserbaseBrowserProvider] Error initializing session:', error);
      return { pages: [] };
    }
  }

  async connectForKeepalive(sessionId: string, connectUrl?: string): Promise<BrowserHandle | null> {
    try {
      const wsUrl =
        connectUrl ?? `wss://connect.browserbase.com?apiKey=${this.apiKey}&sessionId=${sessionId}`;
      return await chromium.connectOverCDP(wsUrl);
    } catch (error) {
      console.error(
        `[BrowserbaseBrowserProvider] Failed to connect for keepalive: ${sessionId}`,
        error,
      );
      return null;
    }
  }

  async uploadSessionFile(sessionId: string, file: SessionUploadFile): Promise<void> {
    if (!this.client) {
      throw new Error('Browserbase API key is not configured');
    }
    if (!file?.buffer?.length) {
      throw new Error('Uploaded file is empty');
    }

    const uploadFile = await toFile(file.buffer, file.originalname || 'upload.bin', {
      type: file.mimetype || 'application/octet-stream',
      lastModified: Date.now(),
    });

    await this.client.sessions.uploads.create(sessionId, { file: uploadFile });
  }

  async createContext(): Promise<string> {
    const response = await axios.post(
      `${this.apiUrl}/contexts`,
      { projectId: this.projectId },
      {
        headers: {
          'x-bb-api-key': this.apiKey,
          'Content-Type': 'application/json',
        },
      },
    );
    return response.data.id;
  }

  private async injectInitScript(context: any): Promise<void> {
    await context.addInitScript(`
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
              selector += '.' + element.className.trim().split(/\\\\s+/).join('.');
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
          reportEvent({
            type: 'click',
            x: e.clientX,
            y: e.clientY,
            target: getElementInfo(e.target),
            timestamp: Date.now()
          });
        }, true);

        document.addEventListener('keydown', function(e) {
          reportEvent({
            type: 'keydown',
            key: e.key,
            ctrlKey: e.ctrlKey,
            shiftKey: e.shiftKey,
            altKey: e.altKey,
            metaKey: e.metaKey,
            target: getElementInfo(e.target),
            timestamp: Date.now()
          });
        }, true);
      })();
    `);
  }
}

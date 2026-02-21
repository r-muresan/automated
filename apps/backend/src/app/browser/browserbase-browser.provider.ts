import { Injectable, NotFoundException } from '@nestjs/common';
import axios from 'axios';
import { chromium } from 'playwright-core';
import {
  BrowserProvider,
  BrowserHandle,
  CreateBrowserSessionOptions,
  BrowserSessionResult,
  InitSessionOptions,
  PageInfo,
} from './browser-provider.interface';

@Injectable()
export class BrowserbaseBrowserProvider extends BrowserProvider {
  private readonly apiKey = process.env.BROWSERBASE_API_KEY;
  private readonly projectId = process.env.BROWSERBASE_PROJECT_ID;
  private readonly apiUrl = 'https://api.browserbase.com/v1';

  async createSession(options: CreateBrowserSessionOptions): Promise<BrowserSessionResult> {
    const { colorScheme, width, height, contextId } = options;

    const response = await axios.post(
      `${this.apiUrl}/sessions`,
      {
        projectId: this.projectId,
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
        inspectorUrlTemplate: `/api/local-screencast?ws=connect.browserbase.com/debug/${sessionId}/devtools/page/{pageId}&secure=1`,
      };
    } catch (error) {
      throw new NotFoundException('Session not found');
    }
  }

  async initializeSession(sessionId: string, options?: InitSessionOptions): Promise<PageInfo[]> {
    try {
      const { colorScheme, width, height } = options ?? {};
      console.log(`[BrowserbaseBrowserProvider] Initializing session ${sessionId}...`);

      const browser = await chromium.connectOverCDP(
        `wss://connect.browserbase.com?apiKey=${this.apiKey}&sessionId=${sessionId}`,
      );
      const defaultContext = browser.contexts()[0];

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
      return [{ id: tabId, url: 'https://www.google.com', title: 'Google' }];
    } catch (error) {
      console.error('[BrowserbaseBrowserProvider] Error initializing session:', error);
      return [];
    }
  }

  async connectForKeepalive(sessionId: string): Promise<BrowserHandle | null> {
    try {
      return await chromium.connectOverCDP(
        `wss://connect.browserbase.com?apiKey=${this.apiKey}&sessionId=${sessionId}`,
      );
    } catch (error) {
      console.error(`[BrowserbaseBrowserProvider] Failed to connect for keepalive: ${sessionId}`, error);
      return null;
    }
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

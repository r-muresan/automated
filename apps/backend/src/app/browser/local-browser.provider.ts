import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { chromium, BrowserContext, Page } from 'patchright';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as net from 'net';
import axios from 'axios';
import {
  BrowserProvider,
  BrowserHandle,
  CreateBrowserSessionOptions,
  BrowserSessionResult,
  InitSessionOptions,
  PageInfo,
  SessionUploadFile,
} from './browser-provider.interface';
import { LocalStorageService } from '../storage/local-storage.service';

interface LocalSession {
  context: BrowserContext;
  page: Page;
  userDataDir: string;
  userId?: string;
  debugPort: number;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

@Injectable()
export class LocalBrowserProvider extends BrowserProvider {
  private sessions = new Map<string, LocalSession>();

  constructor(private readonly storage: LocalStorageService) {
    super();
  }

  async createSession(options: CreateBrowserSessionOptions): Promise<BrowserSessionResult> {
    const sessionId = randomUUID();
    const { colorScheme, width, height, userAgent } = options;

    const userDataDir = join(tmpdir(), `cua-browser-${sessionId}`);
    mkdirSync(userDataDir, { recursive: true });

    // Restore existing user data if available
    if (options.contextId) {
      try {
        await this.storage.downloadUserData(options.contextId, userDataDir);
      } catch (error) {
        console.warn(`[LocalBrowserProvider] Could not restore user data, starting fresh:`, error);
      }
    }

    const debugPort = await getFreePort();

    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      ignoreDefaultArgs: ['--enable-automation', '--enable-blink-features=AutomationControlled'],
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        `--remote-debugging-port=${debugPort}`,
        '--remote-debugging-address=127.0.0.1',
        '--remote-allow-origins=*',

        // Stealth flags
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-breakpad',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--disable-features=TranslateUI',
        '--disable-hang-monitor',
        '--disable-ipc-flooding-protection',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--disable-renderer-backgrounding',
        '--disable-sync',
        '--disable-translate',
        '--force-color-profile=srgb',

        // Use real GPU via ANGLE instead of SwiftShader (major headless signal)
        '--use-gl=angle',
        '--use-angle=default',
        '--metrics-recording-only',
        '--no-first-run',
        '--password-store=basic',
        '--use-mock-keychain',
        '--window-size=1920,1080',
      ],
      colorScheme: colorScheme || 'light',
      viewport: {
        width: width ? Math.round(width) : 1280,
        height: height ? Math.round(height) : 800,
      },
      userAgent:
        userAgent ||
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    });

    const page = context.pages()[0] || (await context.newPage());

    this.sessions.set(sessionId, {
      context,
      page,
      userDataDir,
      userId: options.contextId,
      debugPort,
    });

    return { id: sessionId };
  }

  async stopSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return true;

    try {
      // Close browser first so Chrome flushes profile data to disk
      await session.context.close().catch(() => {});

      // Upload user data after browser is closed
      if (session.userId) {
        await this.storage
          .uploadUserData(session.userId, session.userDataDir)
          .catch((err) => console.error(`[LocalBrowserProvider] Failed to upload user data:`, err));
      }

      // Clean up temp dir
      try {
        rmSync(session.userDataDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }

      this.sessions.delete(sessionId);
      console.log(`[LocalBrowserProvider] Session ${sessionId} stopped`);
      return true;
    } catch (error) {
      console.error(`[LocalBrowserProvider] Error stopping session ${sessionId}:`, error);
      this.sessions.delete(sessionId);
      return false;
    }
  }

  async getSession(sessionId: string): Promise<any> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    return {
      id: sessionId,
      status: session.context.browser()?.isConnected() ? 'RUNNING' : 'DISCONNECTED',
    };
  }

  async getDebugInfo(sessionId: string): Promise<any> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        debuggerFullscreenUrl: '',
        debuggerUrl: '',
        wsUrl: '',
        pages: [],
        cdpWsUrlTemplate: '',
      };
    }

    const { debugPort } = session;
    let pages: { id: string; url: string; title: string }[] = [];

    try {
      // Query Chrome's /json endpoint for real target info
      const response = await axios.get(`http://127.0.0.1:${debugPort}/json`, { timeout: 3000 });
      const targets = response.data;
      pages = targets
        .filter((t: any) => t.type === 'page')
        .map((t: any) => ({
          id: t.id,
          url: t.url || '',
          title: t.title || '',
        }));
    } catch (error) {
      console.warn(`[LocalBrowserProvider] Could not query /json for session ${sessionId}:`, error);
      // Fallback to Playwright's page list
      pages = session.context.pages().map((p, i) => ({
        id: `page-${i}`,
        url: p.url(),
        title: '',
      }));
    }

    const cdpWsUrlTemplate = `ws://localhost:${debugPort}/devtools/page/{pageId}`;

    // Get browser-level CDP WebSocket URL
    let browserWsUrl = '';
    try {
      const versionResponse = await axios.get(`http://127.0.0.1:${debugPort}/json/version`, { timeout: 3000 });
      browserWsUrl = versionResponse.data?.webSocketDebuggerUrl ?? '';
    } catch {
      // fallback: not critical for non-orchestrator usage
    }

    return {
      debuggerFullscreenUrl: '',
      debuggerUrl: '',
      wsUrl: `ws://127.0.0.1:${debugPort}`,
      browserWsUrl,
      pages,
      cdpWsUrlTemplate,
    };
  }

  async initializeSession(sessionId: string, options?: InitSessionOptions): Promise<PageInfo[]> {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    try {
      await this.injectInitScript(session.context);

      if (options?.width && options?.height) {
        await session.page.setViewportSize({
          width: Math.round(options.width),
          height: Math.round(options.height),
        });
      }

      // Navigate to Google
      session.page.goto('https://www.google.com', { waitUntil: 'commit' }).catch(() => {});

      // Wait briefly for navigation to register, then get the real target ID
      await new Promise((resolve) => setTimeout(resolve, 500));

      const { debugPort } = session;
      try {
        const response = await axios.get(`http://127.0.0.1:${debugPort}/json`, { timeout: 3000 });
        const targets = response.data;
        const mainPage = targets.find((t: any) => t.type === 'page');
        if (mainPage) {
          console.log(
            `[LocalBrowserProvider] Session ${sessionId} initialized with target ${mainPage.id}`,
          );
          return [{ id: mainPage.id, url: 'https://www.google.com', title: 'Google' }];
        }
      } catch (error) {
        console.warn(`[LocalBrowserProvider] Could not query /json during init:`, error);
      }

      console.log(`[LocalBrowserProvider] Session ${sessionId} initialized (fallback)`);
      return [{ id: 'page-0', url: 'https://www.google.com', title: 'Google' }];
    } catch (error) {
      console.error('[LocalBrowserProvider] Error initializing session:', error);
      return [];
    }
  }

  async connectForKeepalive(sessionId: string, _connectUrl?: string): Promise<BrowserHandle | null> {
    const session = this.sessions.get(sessionId);
    return session?.context.browser() ?? null;
  }

  async uploadSessionFile(_sessionId: string, _file: SessionUploadFile): Promise<void> {
    throw new Error('File uploads are only supported for Browserbase sessions');
  }

  /** Get the debug port for a session (used by CDP proxy) */
  getDebugPort(sessionId: string): number | null {
    const session = this.sessions.get(sessionId);
    return session?.debugPort ?? null;
  }

  private async injectInitScript(context: BrowserContext): Promise<void> {
    // Stealth patches - hide automation signals
    await context.addInitScript(`
      (function() {
        // navigator.webdriver is handled natively by Patchright +
        // --disable-blink-features=AutomationControlled. Do NOT override
        // it here — a JS getter is detectable as non-native code.

        // Override navigator.plugins on the prototype to avoid own-property detection.
        // Detection compares Object.getOwnPropertyDescriptor(navigator, 'plugins')
        // against Navigator.prototype — own properties indicate tampering.
        const origPluginsDesc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'plugins');
        const origPluginsGet = origPluginsDesc && origPluginsDesc.get;
        if (origPluginsGet) {
          // Get the real (empty) PluginArray reference first to preserve its identity
          const realPlugins = origPluginsGet.call(navigator);
          if (realPlugins && realPlugins.length === 0) {
            // Build fake plugins using the real PluginArray object
            const pluginData = [
              { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
              { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
              { name: 'Chromium PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
              { name: 'Chromium PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
              { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
            ];
            const fakePlugins = Object.create(PluginArray.prototype);
            pluginData.forEach((p, i) => {
              const plugin = Object.create(Plugin.prototype);
              Object.defineProperties(plugin, {
                name: { value: p.name, enumerable: true },
                filename: { value: p.filename, enumerable: true },
                description: { value: p.description, enumerable: true },
                length: { value: 0, enumerable: true },
              });
              Object.defineProperty(fakePlugins, i, { value: plugin, enumerable: true });
              Object.defineProperty(fakePlugins, p.name, { value: plugin, enumerable: false });
            });
            Object.defineProperty(fakePlugins, 'length', { value: pluginData.length, enumerable: true });
            fakePlugins.item = function(index) { return this[index] || null; };
            fakePlugins.namedItem = function(name) { return this[name] || null; };
            fakePlugins.refresh = function() {};

            Object.defineProperty(Navigator.prototype, 'plugins', {
              get: () => fakePlugins,
              configurable: true,
            });
          }
        }

        // Do NOT override navigator.languages — the browser already reports
        // the correct value and overriding creates a detectable own-property.

        // Remove automation-related Chrome properties
        if (window.chrome) {
          window.chrome.runtime = undefined;
        }

        // Override permissions query for notifications
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) =>
          parameters.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(parameters);
      })();
    `);

    // Event tracking script — uses __cdpEvent binding (set up by frontend via
    // Runtime.addBinding) to communicate without requiring Runtime.enable.
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

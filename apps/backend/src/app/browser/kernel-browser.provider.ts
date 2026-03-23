import { Injectable, NotFoundException } from '@nestjs/common';
import { Kernel } from '@onkernel/sdk';
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

const DEFAULT_INITIAL_PAGE_URL = 'https://duckduckgo.com';
const DEFAULT_INITIAL_PAGE_TITLE = 'DuckDuckGo';
const KERNEL_DOWNLOAD_PATH = '/tmp/downloads';

const WINDOWS_PLATFORM = 'Win32';

function buildWindowsUserAgent(chromeVersion: string): string {
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
}

function buildWindowsAppVersion(chromeVersion: string): string {
  return `5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
}

function buildBrands(majorVersion: string) {
  return [
    { brand: 'Chromium', version: majorVersion },
    { brand: 'Google Chrome', version: majorVersion },
    { brand: 'Not/A)Brand', version: '24' },
  ];
}

function buildFullVersionList(fullVersion: string) {
  return [
    { brand: 'Chromium', version: fullVersion },
    { brand: 'Google Chrome', version: fullVersion },
    { brand: 'Not/A)Brand', version: '24.0.0.0' },
  ];
}

@Injectable()
export class KernelBrowserProvider extends BrowserProvider {
  private readonly apiKey = process.env.KERNEL_API_KEY;
  private readonly client = this.apiKey ? new Kernel({ apiKey: this.apiKey }) : null;

  // Cache CDP URLs and live view URLs by session ID since Kernel only returns
  // them at creation time.
  private readonly sessionCdpUrls = new Map<string, string>();
  private readonly sessionLiveViewUrls = new Map<string, string>();
  // Cache replay IDs by session ID for stopping recordings on session cleanup.
  private readonly sessionReplayIds = new Map<string, string>();

  async createSession(options: CreateBrowserSessionOptions): Promise<BrowserSessionResult> {
    const client = this.requireClient();
    const { width, height, contextId } = options;

    const browser = await client.browsers.create({
      stealth: true,
      timeout_seconds: 120,
      viewport: {
        width: width ? Math.round(width) : 1280,
        height: height ? Math.round(height) : 800,
      },
      profile: contextId ? { id: contextId, save_changes: true } : undefined,
    });

    const sessionId = browser.session_id;
    const cdpWsUrl = browser.cdp_ws_url;
    const liveViewUrl = browser.browser_live_view_url;

    this.sessionCdpUrls.set(sessionId, cdpWsUrl);
    if (liveViewUrl) {
      this.sessionLiveViewUrls.set(sessionId, liveViewUrl);
    }

    // Hide the browser cursor
    client.browsers.computer
      .setCursorVisibility(sessionId, { hidden: true })
      .catch((err) =>
        console.error(`[KernelBrowserProvider] Failed to hide cursor for ${sessionId}:`, err),
      );

    // Start a replay recording
    client.browsers.replays
      .start(sessionId)
      .then((replay) => {
        console.log(
          `[KernelBrowserProvider] Started recording for session ${sessionId}: replayId=${replay.replay_id}`,
        );
        this.sessionReplayIds.set(sessionId, replay.replay_id);
      })
      .catch((err) =>
        console.error(`[KernelBrowserProvider] Failed to start recording for ${sessionId}:`, err),
      );

    return {
      id: sessionId,
      cdpWsUrl,
      liveViewUrl,
      connectUrl: cdpWsUrl,
      wsEndpoint: cdpWsUrl,
    };
  }

  async stopSession(sessionId: string): Promise<boolean> {
    const client = this.requireClient();

    try {
      // Stop the replay recording if one is active
      const replayId = this.sessionReplayIds.get(sessionId);
      if (replayId) {
        await client.browsers.replays
          .stop(replayId, { id: sessionId })
          .catch((err) =>
            console.warn(`[KernelBrowserProvider] Failed to stop recording for ${sessionId}:`, err),
          );
        this.sessionReplayIds.delete(sessionId);
      }

      await client.browsers.deleteByID(sessionId);
      this.sessionCdpUrls.delete(sessionId);
      this.sessionLiveViewUrls.delete(sessionId);
      return true;
    } catch (error) {
      const status = (error as any)?.status ?? (error as any)?.statusCode;
      if (status === 404) {
        this.sessionCdpUrls.delete(sessionId);
        this.sessionLiveViewUrls.delete(sessionId);
        this.sessionReplayIds.delete(sessionId);
        return true;
      }
      console.error(`[KernelBrowserProvider] Error stopping session ${sessionId}:`, error);
      return false;
    }
  }

  async getSession(sessionId: string): Promise<any> {
    const client = this.requireClient();

    try {
      return await client.browsers.retrieve(sessionId);
    } catch {
      return null;
    }
  }

  async getSessionDebugInfo(sessionId: string): Promise<SessionDebugInfoResult> {
    const client = this.requireClient();

    try {
      const session = await client.browsers.retrieve(sessionId);
      const liveViewUrl = session.browser_live_view_url ?? this.sessionLiveViewUrls.get(sessionId);

      return {
        session,
        debugInfo: {
          ...session,
          pages: [],
          cdpWsUrlTemplate: session.cdp_ws_url,
          liveViewUrl,
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
      const session = await client.browsers.retrieve(sessionId);
      const liveViewUrl = session.browser_live_view_url ?? this.sessionLiveViewUrls.get(sessionId);

      return {
        ...session,
        pages: [],
        cdpWsUrlTemplate: '',
        liveViewUrl,
      };
    } catch {
      throw new NotFoundException('Session not found');
    }
  }

  async initializeSession(
    sessionId: string,
    options?: InitSessionOptions,
  ): Promise<InitSessionResult> {
    const cdpWsUrl = options?.connectUrl ?? this.sessionCdpUrls.get(sessionId);

    if (!cdpWsUrl) {
      console.error(`[KernelBrowserProvider] No CDP URL for session ${sessionId}`);
      return { pages: [] };
    }

    try {
      console.log(`[KernelBrowserProvider] Initializing session ${sessionId}...`);

      const browser = await chromium.connectOverCDP(cdpWsUrl);

      // await this.spoofUserAgent(browser);

      const defaultContext = browser.contexts()[0];
      if (!defaultContext) {
        return { pages: [] };
      }

      const existingPages = defaultContext.pages();

      // Close all extra tabs from previous sessions (profile restore), keeping
      // only the first page which we'll navigate to the default URL.
      const page = existingPages[0] || (await defaultContext.newPage());
      if (existingPages.length > 1) {
        await Promise.all(existingPages.slice(1).map((p) => p.close().catch(() => {})));
      }

      // await this.warmUpProfile(page);

      page.goto(DEFAULT_INITIAL_PAGE_URL, { waitUntil: 'commit' }).catch(() => {});

      const liveViewUrl = this.sessionLiveViewUrls.get(sessionId);

      console.log(`[KernelBrowserProvider] Session ${sessionId} initialized successfully`);
      return {
        pages: [
          {
            id: 'page-0',
            url: DEFAULT_INITIAL_PAGE_URL,
            title: DEFAULT_INITIAL_PAGE_TITLE,
          },
        ],
        cdpWsUrlTemplate: cdpWsUrl,
        liveViewUrl,
      };
    } catch (error) {
      console.error('[KernelBrowserProvider] Error initializing session:', error);
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

    const filename = file.originalname || 'upload.bin';
    const remotePath = `/tmp/uploads/${filename}`;

    await client.browsers.fs.writeFile(sessionId, file.buffer, { path: remotePath });

    return { filePath: remotePath };
  }

  /**
   * Create a Kernel profile for persistent browser state.
   */
  async createProfile(name: string): Promise<string> {
    const client = this.requireClient();

    // Profile names must match ^[a-zA-Z0-9._-]+$ — sanitize email addresses
    const isDev = process.env.NODE_ENV === 'development';
    const sanitizedName = name.replace(/[^a-zA-Z0-9._-]/g, '_') + (isDev ? '_DEV' : '');

    const profile = await client.profiles.create({ name: sanitizedName });
    console.log(`[KernelBrowserProvider] Created profile: ${profile.id} (name=${sanitizedName})`);
    return profile.id;
  }

  /**
   * Retrieve a Kernel profile by ID or name. Returns null if not found.
   */
  async getProfile(idOrName: string): Promise<any> {
    const client = this.requireClient();
    try {
      return await client.profiles.retrieve(idOrName);
    } catch {
      return null;
    }
  }

  /**
   * Warm up the browser by visiting common sites to build up
   * cookies/history/localStorage so the profile looks like a real user.
   */
  private async warmUpProfile(page: import('playwright-core').Page): Promise<void> {
    const warmUpUrls = [
      'https://www.google.com',
      'https://www.wikipedia.org',
      'https://www.weather.com',
      'https://www.reddit.com',
      'https://www.youtube.com',
    ];

    console.log('[KernelBrowserProvider] Warming up profile...');

    const context = page.context();
    await Promise.all(
      warmUpUrls.map(async (url) => {
        const p = await context.newPage();
        try {
          await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
        } catch {
        } finally {
          await p.close().catch(() => {});
        }
      }),
    );

    console.log('[KernelBrowserProvider] Profile warmed up successfully');
  }

  /**
   * Spoof the browser user agent to appear as a Windows machine via CDP.
   * Uses per-page CDP sessions for Network.setUserAgentOverride (with Client Hints)
   * and Page.addScriptToEvaluateOnNewDocument for navigator JS overrides.
   * Also hooks into context 'page' events to apply to future pages.
   */
  private async spoofUserAgent(browser: Browser): Promise<void> {
    try {
      const defaultContext = browser.contexts()[0];
      if (!defaultContext) return;

      // Detect the real Chrome version from the browser so we don't mismatch
      let chromeFullVersion = '145.0.0.0';
      const pages = defaultContext.pages();
      if (pages.length > 0) {
        const realUA: string = await pages[0].evaluate(() => navigator.userAgent).catch(() => '');
        const match = realUA.match(/Chrome\/([\d.]+)/);
        if (match) chromeFullVersion = match[1];
      } else {
        const ver = browser.version();
        if (ver) chromeFullVersion = ver;
      }
      const chromeMajor = chromeFullVersion.split('.')[0];

      // Apply to all existing pages
      for (const page of defaultContext.pages()) {
        await this.spoofPage(defaultContext, page, chromeFullVersion, chromeMajor);
      }

      // Apply to all future pages
      defaultContext.on('page', (page) => {
        this.spoofPage(defaultContext, page, chromeFullVersion, chromeMajor).catch((err) =>
          console.error('[KernelBrowserProvider] Failed to spoof new page UA:', err),
        );
      });

      console.log(
        `[KernelBrowserProvider] User agent spoofed to Windows (Chrome/${chromeFullVersion})`,
      );
    } catch (error) {
      console.error('[KernelBrowserProvider] Failed to spoof user agent:', error);
    }
  }

  /**
   * Apply user agent spoofing to a single page via its CDP session.
   */
  private async spoofPage(
    context: import('playwright-core').BrowserContext,
    page: import('playwright-core').Page,
    chromeFullVersion: string,
    chromeMajor: string,
  ): Promise<void> {
    const cdpSession = await context.newCDPSession(page);
    const windowsUA = buildWindowsUserAgent(chromeFullVersion);
    const windowsAppVersion = buildWindowsAppVersion(chromeFullVersion);

    // Override HTTP User-Agent header + Client Hints (userAgentData)
    await cdpSession.send('Network.setUserAgentOverride', {
      userAgent: windowsUA,
      platform: WINDOWS_PLATFORM,
      userAgentMetadata: {
        brands: buildBrands(chromeMajor),
        fullVersionList: buildFullVersionList(chromeFullVersion),
        platform: 'Windows',
        platformVersion: '10.0.0',
        architecture: 'x86',
        model: '',
        mobile: false,
        bitness: '64',
        wow64: false,
        fullVersion: chromeFullVersion,
      },
    });

    // Override navigator JS properties on the prototype (not the instance)
    // so fingerprinting tools like CreepJS don't detect own-property overrides.
    // Also make getters look like native code via toString spoofing.
    await cdpSession.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        (function() {
          const spoofedUA = '${windowsUA}';
          const spoofedPlatform = '${WINDOWS_PLATFORM}';
          const spoofedAppVersion = '${windowsAppVersion}';

          // Helper: define a getter on the prototype that looks native
          function nativeDefine(proto, prop, value) {
            const getter = function() { return value; };
            // Make toString() return "function get userAgent() { [native code] }" etc.
            getter.toString = function() { return 'function get ' + prop + '() { [native code] }'; };
            Object.defineProperty(getter, 'name', { value: 'get ' + prop, configurable: true });
            Object.defineProperty(proto, prop, {
              get: getter,
              configurable: true,
              enumerable: true,
            });
          }

          nativeDefine(Navigator.prototype, 'userAgent', spoofedUA);
          nativeDefine(Navigator.prototype, 'platform', spoofedPlatform);
          nativeDefine(Navigator.prototype, 'appVersion', spoofedAppVersion);
          nativeDefine(Navigator.prototype, 'oscpu', undefined);

          // Override userAgentData on NavigatorUAData prototype
          if (navigator.userAgentData) {
            const brands = ${JSON.stringify(buildBrands(chromeMajor))};
            const fullVersionList = ${JSON.stringify(buildFullVersionList(chromeFullVersion))};
            const highEntropyData = {
              brands: brands,
              mobile: false,
              platform: 'Windows',
              platformVersion: '10.0.0',
              architecture: 'x86',
              bitness: '64',
              model: '',
              uaFullVersion: '${chromeFullVersion}',
              fullVersionList: fullVersionList,
              wow64: false,
            };

            const uaData = navigator.userAgentData;
            const proto = Object.getPrototypeOf(uaData);

            // Override brands
            nativeDefine(proto, 'brands', brands);
            nativeDefine(proto, 'mobile', false);
            nativeDefine(proto, 'platform', 'Windows');

            // Override getHighEntropyValues
            const origGHEV = proto.getHighEntropyValues;
            proto.getHighEntropyValues = function(hints) {
              return Promise.resolve(highEntropyData);
            };
            proto.getHighEntropyValues.toString = function() { return 'function getHighEntropyValues() { [native code] }'; };
            Object.defineProperty(proto.getHighEntropyValues, 'name', { value: 'getHighEntropyValues', configurable: true });

            // Override toJSON
            proto.toJSON = function() {
              return { brands: brands, mobile: false, platform: 'Windows' };
            };
            proto.toJSON.toString = function() { return 'function toJSON() { [native code] }'; };
          }
        })();
      `,
    });
  }

  private requireClient(): Kernel {
    if (!this.client) {
      throw new Error('Kernel API key is not configured');
    }
    return this.client;
  }

  private async enableDownloadBehavior(browser: Browser): Promise<void> {
    const cdp = await browser.newBrowserCDPSession();
    try {
      await cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: KERNEL_DOWNLOAD_PATH,
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

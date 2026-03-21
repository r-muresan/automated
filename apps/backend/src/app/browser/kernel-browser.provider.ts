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
      timeout_seconds: 3600,
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
      // Skip CDP interactions (enableDownloadBehavior, getTargetId) to reduce
      // bot-detection fingerprinting. Downloads and target IDs are non-essential
      // for the Kernel iframe-based flow.

      const defaultContext = browser.contexts()[0];
      if (!defaultContext) {
        return { pages: [] };
      }

      const page = defaultContext.pages()[0] || (await defaultContext.newPage());

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
    const sanitizedName = name.replace(/[^a-zA-Z0-9._-]/g, '_');
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

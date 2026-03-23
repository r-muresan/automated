import OpenAI from 'openai';
import { Stagehand } from '../stagehand/v3';
import { HyperbrowserScreenController } from '../stagehand/v3/screen/HyperbrowserScreenController.js';
import { Hyperbrowser } from '@hyperbrowser/sdk';
import { Kernel } from '@onkernel/sdk';
import { DEFAULT_SESSION_DOWNLOAD_PATH } from './session-file-manager';
import {
  acquireBrowserSessionCreateLease,
  releaseBrowserSession,
} from '../browser-session-limiter';
import { OPENROUTER_BASE_URL, type OrchestratorContext } from './orchestrator-context';
import { wrapOpenAIWithTracking } from './llm-tracking';
import type { ScreenController } from '../stagehand/v3/types/public/screen.js';

// ---------------------------------------------------------------------------
// Session lifecycle — extracted from OrchestratorAgent
// ---------------------------------------------------------------------------

export interface SessionState {
  hyperbrowserClient: Hyperbrowser | null;
  hyperbrowserSessionId: string | null;
  kernelClient: Kernel | null;
  kernelSessionId: string | null;
  kernelReplayId: string | null;
  activeSessionId: string | null;
}

export async function initSession(
  ctx: OrchestratorContext,
  session: SessionState,
  startingUrl?: string,
): Promise<void> {
  ctx.assertNotAborted();
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('Missing OPENROUTER_API_KEY for OpenRouter');
  ctx.openai = wrapOpenAIWithTracking(new OpenAI({ baseURL: OPENROUTER_BASE_URL, apiKey }));

  if (ctx.options.localCdpUrl) {
    await initLocalSession(ctx, session, startingUrl);
  } else if (process.env.KERNEL_API_KEY) {
    await initKernelSession(ctx, session, startingUrl);
  } else {
    await initHyperbrowserSession(ctx, session, startingUrl);
  }
}

export async function initLocalSession(
  ctx: OrchestratorContext,
  session: SessionState,
  startingUrl?: string,
): Promise<void> {
  const cdpUrl = ctx.options.localCdpUrl!;
  const models = ctx.resolveModels();
  console.log(`[ORCHESTRATOR] Using local browser via CDP: ${cdpUrl}`);

  ctx.stagehand = new Stagehand({
    env: 'LOCAL',
    verbose: 0,
    model: {
      modelName: models.extract,
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: OPENROUTER_BASE_URL,
    },
    localBrowserLaunchOptions: {
      cdpUrl,
      acceptDownloads: true,
      downloadsPath: DEFAULT_SESSION_DOWNLOAD_PATH,
    },
    experimental: true,
    disableAPI: true,
  });

  await ctx.stagehand.init();

  // For local sessions, attach an external screen controller if provided
  if (ctx.options.screenController) {
    await ctx.options.screenController.connect();
    ctx.stagehand.setScreenController(ctx.options.screenController);
  }

  await ctx.sessionFiles.attach(ctx.stagehand, ctx.openai!);
  const sessionId = ctx.options.localSessionId ?? 'local';
  session.activeSessionId = sessionId;

  ctx.assertNotAborted();
  ctx.emit({ type: 'session:ready', sessionId, liveViewUrl: '' });

  if (startingUrl) {
    const page = ctx.stagehand.context.pages()[0];
    await page.goto(startingUrl, { waitUntil: 'domcontentloaded' });
    console.log(`[ORCHESTRATOR] Navigated to ${startingUrl}`);
  }
}

export async function initKernelSession(
  ctx: OrchestratorContext,
  session: SessionState,
  startingUrl?: string,
): Promise<void> {
  const models = ctx.resolveModels();
  const kernelApiKey = process.env.KERNEL_API_KEY;
  if (!kernelApiKey) {
    throw new Error('Missing KERNEL_API_KEY for Kernel');
  }

  const screenSize = ctx.options.screenSize ?? { width: 1280, height: 720 };

  const createLease = await acquireBrowserSessionCreateLease('orchestrator:init');
  let leaseConfirmed = false;

  try {
    session.kernelClient = new Kernel({ apiKey: kernelApiKey });

    const kernelProfileId = ctx.options.kernelProfileId ?? process.env.KERNEL_PROFILE_ID;

    const kernelBrowser = await session.kernelClient.browsers.create({
      stealth: true,
      timeout_seconds: 3600,
      viewport: {
        width: screenSize.width,
        height: screenSize.height,
      },
      profile: kernelProfileId ? { id: kernelProfileId, save_changes: true } : undefined,
    });

    // Hide the browser cursor
    session.kernelClient.browsers.computer
      .setCursorVisibility(kernelBrowser.session_id, { hidden: true })
      .catch((err) => console.warn('[ORCHESTRATOR] Failed to hide Kernel cursor:', err));

    // Start a replay recording
    session.kernelClient.browsers.replays
      .start(kernelBrowser.session_id)
      .then((replay) => {
        console.log(`[ORCHESTRATOR] Started Kernel recording: replayId=${replay.replay_id}`);
        session.kernelReplayId = replay.replay_id;
      })
      .catch((err) => console.warn('[ORCHESTRATOR] Failed to start Kernel recording:', err));

    ctx.stagehand = new Stagehand({
      env: 'LOCAL',
      verbose: 1,
      model: {
        modelName: models.extract,
        apiKey: process.env.OPENROUTER_API_KEY,
        baseURL: OPENROUTER_BASE_URL,
      },
      localBrowserLaunchOptions: {
        cdpUrl: kernelBrowser.cdp_ws_url,
        acceptDownloads: true,
        downloadsPath: DEFAULT_SESSION_DOWNLOAD_PATH,
      },
      experimental: true,
      disableAPI: true,
    });

    await ctx.stagehand.init();

    // Attach screen controller if externally provided
    if (ctx.options.screenController) {
      await ctx.options.screenController.connect();
      ctx.stagehand.setScreenController(ctx.options.screenController);
    }

    await ctx.sessionFiles.attach(ctx.stagehand, ctx.openai!);
    const sessionId = kernelBrowser.session_id;
    createLease.confirmCreated(sessionId);
    leaseConfirmed = true;
    session.activeSessionId = sessionId;
    session.kernelSessionId = sessionId;

    ctx.assertNotAborted();
    const liveViewUrl = kernelBrowser.browser_live_view_url ?? '';
    ctx.emit({ type: 'session:ready', sessionId, liveViewUrl });

    if (startingUrl) {
      const page = ctx.stagehand.context.pages()[0];
      await page.goto(startingUrl, { waitUntil: 'domcontentloaded' });
      console.log(`[ORCHESTRATOR] Navigated to ${startingUrl}`);
    }
  } catch (error) {
    if (!leaseConfirmed) {
      createLease.cancel();
    }
    throw error;
  }
}

export async function initHyperbrowserSession(
  ctx: OrchestratorContext,
  session: SessionState,
  startingUrl?: string,
): Promise<void> {
  const models = ctx.resolveModels();
  const hyperbrowserApiKey = process.env.HYPERBROWSER_API_KEY;
  if (!hyperbrowserApiKey) {
    throw new Error('Missing HYPERBROWSER_API_KEY for Hyperbrowser');
  }

  const profileId = ctx.options.hyperbrowserProfileId ?? process.env.HYPERBROWSER_PROFILE_ID;

  const screenSize = ctx.options.screenSize ?? { width: 1280, height: 720 };

  const createLease = await acquireBrowserSessionCreateLease('orchestrator:init');
  let leaseConfirmed = false;

  try {
    session.hyperbrowserClient = new Hyperbrowser({ apiKey: hyperbrowserApiKey });
    const hyperbrowserSession = await session.hyperbrowserClient.sessions.create({
      timeoutMinutes: 60,
      screen: screenSize,
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
    });

    ctx.stagehand = new Stagehand({
      env: 'LOCAL',
      verbose: 1,
      model: {
        modelName: models.extract,
        apiKey: process.env.OPENROUTER_API_KEY,
        baseURL: OPENROUTER_BASE_URL,
      },
      localBrowserLaunchOptions: {
        cdpUrl: hyperbrowserSession.wsEndpoint,
        acceptDownloads: true,
        downloadsPath: DEFAULT_SESSION_DOWNLOAD_PATH,
      },
      experimental: true,
      disableAPI: true,
    });

    await ctx.stagehand.init();

    // Attach screen controller — use externally-provided one, or default to
    // the Hyperbrowser Computer Actions API.
    const screenController: ScreenController =
      ctx.options.screenController ??
      new HyperbrowserScreenController({
        client: session.hyperbrowserClient,
        sessionId: hyperbrowserSession.id,
        screenSize,
      });

    await screenController.connect();
    ctx.stagehand.setScreenController(screenController);

    await ctx.sessionFiles.attach(ctx.stagehand, ctx.openai!);
    const sessionId = hyperbrowserSession.id;
    createLease.confirmCreated(sessionId);
    leaseConfirmed = true;
    session.activeSessionId = sessionId;
    session.hyperbrowserSessionId = sessionId;

    ctx.assertNotAborted();
    const liveViewUrl = hyperbrowserSession.liveUrl ?? '';
    ctx.emit({ type: 'session:ready', sessionId, liveViewUrl });

    if (startingUrl) {
      const page = ctx.stagehand.context.pages()[0];
      await page.goto(startingUrl, { waitUntil: 'domcontentloaded' });
      console.log(`[ORCHESTRATOR] Navigated to ${startingUrl}`);
    }
  } catch (error) {
    if (!leaseConfirmed) {
      createLease.cancel();
    }
    throw error;
  }
}

export async function closeSession(ctx: OrchestratorContext, session: SessionState): Promise<void> {
  const sessionId =
    session.kernelSessionId ?? session.hyperbrowserSessionId ?? session.activeSessionId;
  const isLocal = !!ctx.options.localCdpUrl;
  ctx.sessionFiles.reset();

  if (ctx.stagehand) {
    try {
      await ctx.stagehand.close();
    } catch {
      console.log('[ORCHESTRATOR] Error closing stagehand');
    }
    ctx.stagehand = null;
  }

  if (sessionId && !isLocal) {
    if (session.kernelClient && session.kernelSessionId) {
      // Stop the replay recording before deleting the session
      if (session.kernelReplayId) {
        await session.kernelClient.browsers.replays
          .stop(session.kernelReplayId, { id: session.kernelSessionId })
          .catch((err) => console.warn('[ORCHESTRATOR] Failed to stop Kernel recording:', err));
        session.kernelReplayId = null;
      }
      await session.kernelClient.browsers.deleteByID(session.kernelSessionId).catch((error) => {
        console.warn(
          `[ORCHESTRATOR] Failed to delete Kernel session ${session.kernelSessionId}:`,
          error,
        );
      });
    } else if (session.hyperbrowserClient) {
      await session.hyperbrowserClient.sessions.stop(sessionId).catch((error) => {
        console.warn(`[ORCHESTRATOR] Failed to stop Hyperbrowser session ${sessionId}:`, error);
      });
    }
    releaseBrowserSession(sessionId);
  }
  session.activeSessionId = null;
  session.hyperbrowserSessionId = null;
  session.hyperbrowserClient = null;
  session.kernelClient = null;
  session.kernelSessionId = null;
  session.kernelReplayId = null;
}

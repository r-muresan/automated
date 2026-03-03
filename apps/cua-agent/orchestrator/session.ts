import OpenAI from 'openai';
import { Stagehand } from '../stagehand/v3';
import { Hyperbrowser } from '@hyperbrowser/sdk';
import { DEFAULT_SESSION_DOWNLOAD_PATH } from './session-file-manager';
import {
  acquireBrowserSessionCreateLease,
  releaseBrowserSession,
} from '../browser-session-limiter';
import { OPENROUTER_BASE_URL, type OrchestratorContext } from './orchestrator-context';

// ---------------------------------------------------------------------------
// Session lifecycle — extracted from OrchestratorAgent
// ---------------------------------------------------------------------------

export interface SessionState {
  hyperbrowserClient: Hyperbrowser | null;
  hyperbrowserSessionId: string | null;
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
  ctx.openai = new OpenAI({ baseURL: OPENROUTER_BASE_URL, apiKey });

  if (ctx.options.localCdpUrl) {
    await initLocalSession(ctx, session, startingUrl);
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

  const createLease = await acquireBrowserSessionCreateLease('orchestrator:init');
  let leaseConfirmed = false;

  try {
    session.hyperbrowserClient = new Hyperbrowser({ apiKey: hyperbrowserApiKey });
    const hyperbrowserSession = await session.hyperbrowserClient.sessions.create({
      timeoutMinutes: 60,
      saveDownloads: true,
      enableWebRecording: true,
      profile: profileId
        ? {
            id: profileId,
            persistChanges: true,
          }
        : undefined,
      adblock: true,
      acceptCookies: true,
      useStealth: true,
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
  const sessionId = session.hyperbrowserSessionId ?? session.activeSessionId;
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
    if (session.hyperbrowserClient) {
      await session.hyperbrowserClient.sessions.stop(sessionId).catch((error) => {
        console.warn(`[ORCHESTRATOR] Failed to stop Hyperbrowser session ${sessionId}:`, error);
      });
    }
    releaseBrowserSession(sessionId);
  }
  session.activeSessionId = null;
  session.hyperbrowserSessionId = null;
  session.hyperbrowserClient = null;
}

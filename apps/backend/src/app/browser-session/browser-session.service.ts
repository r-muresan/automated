import { Injectable, ForbiddenException, OnModuleInit, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {
  BrowserProvider,
  BrowserHandle,
  SessionUploadFile,
} from '../browser/browser-provider.interface';
import { HyperbrowserBrowserProvider } from '../browser/hyperbrowser-browser.provider';
import { acquireBrowserSessionCreateLease, releaseBrowserSession } from 'apps/cua-agent';

const BROWSER_MINUTES_CAP = 10000;
const isUsingManagedBrowser = !!process.env.HYPERBROWSER_API_KEY;

function buildCdpWsUrlTemplate(
  connectUrl: string | null | undefined,
  sessionId: string,
): string | undefined {
  if (!connectUrl) return undefined;

  // Hyperbrowser provides a browser-level endpoint that requires auth headers the browser
  // WebSocket API can't supply. Route through the local CDP proxy instead.
  if (!connectUrl.includes('browserbase.com')) {
    const wsBase = (
      process.env.BACKEND_WS_URL || `ws://localhost:${process.env.PORT || 8080}`
    ).replace(/\/$/, '');
    return `${wsBase}/api/cdp-proxy/${sessionId}`;
  }

  try {
    const url = new URL(connectUrl);
    return `${url.protocol}//${url.host}/debug/${sessionId}/devtools/page/{pageId}`;
  } catch {
    return connectUrl;
  }
}

interface RecordingSession {
  sessionId: string;
  startTime: number;
  browser: BrowserHandle | null;
  lastPingTime: number;
  connectUrl?: string;
}

@Injectable()
export class BrowserSessionService implements OnModuleInit {
  private activeRecordingSessions = new Map<string, RecordingSession>();
  private readonly RECORDING_MAX_DURATION_MS = 5 * 60 * 1000;
  private readonly RECORDING_PING_INTERVAL_MS = 10 * 1000;

  constructor(
    private prisma: PrismaService,
    private browserProvider: BrowserProvider,
  ) {}

  onModuleInit() {
    setInterval(() => {
      this.cleanupExpiredSessions().catch((err) =>
        console.error('Error in cleanupExpiredSessions:', err),
      );
    }, 10000);

    setInterval(() => {
      this.pingActiveRecordingSessions().catch((err) =>
        console.error('Error in pingActiveRecordingSessions:', err),
      );
    }, this.RECORDING_PING_INTERVAL_MS);
  }

  async assertBrowserMinutesRemaining(userId: string) {
    if (!isUsingManagedBrowser) return;
    const user = await this.prisma.user.findUnique({ where: { email: userId } });
    if (user && user.browserMinutesUsed >= BROWSER_MINUTES_CAP) {
      throw new ForbiddenException(
        `Browser minutes cap reached (${BROWSER_MINUTES_CAP} minutes). Please upgrade your plan.`,
      );
    }
  }

  async addBrowserMinutesForSession(sessionId: string) {
    if (!isUsingManagedBrowser) return;
    const session = await this.prisma.browserSession.findFirst({
      where: { browserbaseSessionId: sessionId },
      include: { user: true },
    });
    if (!session?.user) return;

    const minutesUsed = (Date.now() - session.createdAt.getTime()) / 60_000;
    if (minutesUsed <= 0) return;

    await this.prisma.user
      .update({
        where: { email: session.user.email },
        data: { browserMinutesUsed: { increment: minutesUsed } },
      })
      .catch((err) => console.error('Error updating browser minutes:', err));
  }

  async getSession(sessionId: string) {
    const data = await this.browserProvider.getSession(sessionId);

    // Update lastUsedAt in background
    this.updateLastUsed(sessionId).catch((err) => console.error('Error updating lastUsedAt:', err));

    return data;
  }

  async getOrCreateUserContext(email: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) return null;

    let userContext = await this.prisma.userContext.findUnique({
      where: { userId: user.id },
    });

    if (!userContext) {
      // Only create managed-browser profile context when using Hyperbrowser provider
      if (this.browserProvider instanceof HyperbrowserBrowserProvider) {
        const contextId = await (
          this.browserProvider as HyperbrowserBrowserProvider
        ).createContext();

        userContext = await this.prisma.userContext.upsert({
          where: { userId: user.id },
          update: { browserbaseContextId: contextId },
          create: { userId: user.id, browserbaseContextId: contextId },
        });
      } else {
        // For local provider, use user ID as context identifier
        userContext = await this.prisma.userContext.upsert({
          where: { userId: user.id },
          update: {},
          create: { userId: user.id, browserbaseContextId: String(user.id) },
        });
      }
    }

    return userContext.browserbaseContextId;
  }

  async createSession(
    userId: string,
    colorScheme?: 'light' | 'dark',
    width?: number,
    height?: number,
    reuseExisting = false,
    userAgent?: string,
    timezone?: string,
  ) {
    await this.assertBrowserMinutesRemaining(userId);

    const [contextId, createLease] = await Promise.all([
      this.getOrCreateUserContext(userId),
      acquireBrowserSessionCreateLease('backend:createSession'),
    ]);

    let leaseConfirmed = false;
    let createdSessionId: string | undefined;

    try {
      if (reuseExisting) {
        console.log(
          '[BrowserSessionService] Ignoring reuseExisting and recreating browser session',
        );
      }

      await this.stopExistingUserSessions(userId);

      const session = await this.browserProvider.createSession({
        colorScheme,
        width,
        height,
        contextId: contextId ?? undefined,
        userAgent,
        timezone,
      });

      createdSessionId = session.id;
      createLease.confirmCreated(session.id);
      leaseConfirmed = true;

      const resolvedConnectUrl = session.connectUrl ?? session.wsEndpoint ?? null;

      this.prisma.browserSession
        .create({
          data: {
            user: { connect: { email: userId } },
            browserbaseSessionId: session.id,
            connectUrl: resolvedConnectUrl,
            lastUsedAt: new Date(),
          },
        })
        .catch((err) => console.error('Error storing session in DB:', err));

      if (typeof session.profileId === 'string' && session.profileId.length > 0) {
        await this.updateUserContextId(userId, session.profileId);
      }

      const initResult = await this.browserProvider.initializeSession(session.id, {
        colorScheme,
        width,
        height,
        connectUrl: resolvedConnectUrl ?? undefined,
      });

      return {
        ...session,
        pages: initResult.pages,
        cdpWsUrlTemplate:
          session.cdpWsUrlTemplate ??
          initResult.cdpWsUrlTemplate ??
          buildCdpWsUrlTemplate(resolvedConnectUrl, session.id),
        liveViewUrl: session.liveUrl ?? session.liveViewUrl ?? initResult.liveViewUrl,
      };
    } catch (error) {
      if (!leaseConfirmed) {
        createLease.cancel();
      } else if (createdSessionId) {
        await this.stopSession(createdSessionId, false);
      }
      throw error;
    }
  }

  async getDebugUrl(sessionId: string) {
    this.updateLastUsed(sessionId).catch((err) => console.error('Error updating lastUsedAt:', err));
    return this.browserProvider.getDebugInfo(sessionId);
  }

  private async updateUserContextId(email: string, contextId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) return;

    await this.prisma.userContext.upsert({
      where: { userId: user.id },
      update: { browserbaseContextId: contextId },
      create: { userId: user.id, browserbaseContextId: contextId },
    });
  }

  private async stopExistingUserSessions(userId: string): Promise<void> {
    const existingSessions = await this.prisma.browserSession.findMany({
      where: {
        user: { email: userId },
        workflowId: null,
      },
      select: { browserbaseSessionId: true },
    });

    for (const existingSession of existingSessions) {
      console.log(
        `[BrowserSessionService] Recreating session, stopping existing session ${existingSession.browserbaseSessionId}`,
      );
      this.stopRecordingKeepalive(existingSession.browserbaseSessionId);
      this.stopSession(existingSession.browserbaseSessionId);
    }
  }

  async stopSession(sessionId: string, deleteFromDb = true) {
    try {
      console.log(`[BrowserSessionService] Stopping session ${sessionId}`);
      await this.addBrowserMinutesForSession(sessionId);
      const result = await this.browserProvider.stopSession(sessionId);

      if (deleteFromDb) {
        await this.prisma.browserSession.deleteMany({
          where: { browserbaseSessionId: sessionId },
        });
      }

      releaseBrowserSession(sessionId);
      console.log(`[BrowserSessionService] Session ${sessionId} stopped successfully`);
      return result;
    } catch (error) {
      console.error(`[BrowserSessionService] Error stopping session ${sessionId}:`, error);
      return false;
    }
  }

  async updateLastUsed(sessionId: string) {
    await this.prisma.browserSession.updateMany({
      where: { browserbaseSessionId: sessionId },
      data: { lastUsedAt: new Date() },
    });
  }

  async cleanupExpiredSessions() {
    const sixtySecondsAgo = new Date(Date.now() - 60 * 1000);

    const expiredSessions = await this.prisma.browserSession.findMany({
      where: { lastUsedAt: { lt: sixtySecondsAgo } },
    });

    for (const session of expiredSessions) {
      console.log(`Terminating expired session: ${session.browserbaseSessionId}`);
      await this.stopSession(session.browserbaseSessionId);
    }
  }

  async startRecordingKeepalive(sessionId: string) {
    if (this.activeRecordingSessions.has(sessionId)) {
      return { success: true, message: 'Keepalive already active' };
    }

    try {
      console.log(`[BrowserSessionService] Starting recording keepalive for session ${sessionId}`);
      const dbSession = await this.prisma.browserSession.findFirst({
        where: { browserbaseSessionId: sessionId },
        select: { connectUrl: true },
      });
      const connectUrl = dbSession?.connectUrl ?? undefined;
      const browser = await this.browserProvider.connectForKeepalive(sessionId, connectUrl);

      this.activeRecordingSessions.set(sessionId, {
        sessionId,
        startTime: Date.now(),
        browser,
        lastPingTime: Date.now(),
        connectUrl,
      });

      await this.updateLastUsed(sessionId);
      return { success: true, message: 'Keepalive started' };
    } catch (error) {
      console.error(`[BrowserSessionService] Failed to start keepalive for ${sessionId}:`, error);
      return { success: false, message: 'Failed to start keepalive', error: String(error) };
    }
  }

  async stopRecordingKeepalive(sessionId: string) {
    const recordingSession = this.activeRecordingSessions.get(sessionId);
    if (!recordingSession) {
      return { success: true, message: 'No active keepalive' };
    }

    try {
      if (recordingSession.browser) {
        await recordingSession.browser
          .close()
          .catch((err: Error) =>
            console.error(`Error closing browser for session ${sessionId}:`, err),
          );
      }
      this.activeRecordingSessions.delete(sessionId);
      return { success: true, message: 'Keepalive stopped' };
    } catch (error) {
      this.activeRecordingSessions.delete(sessionId);
      return { success: false, message: 'Error stopping keepalive', error: String(error) };
    }
  }

  isRecordingKeepaliveActive(sessionId: string): boolean {
    return this.activeRecordingSessions.has(sessionId);
  }

  async uploadSessionFile(sessionId: string, file: SessionUploadFile) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('A file is required');
    }

    try {
      await this.browserProvider.uploadSessionFile(sessionId, file);
      await this.updateLastUsed(sessionId).catch((err) =>
        console.error('Error updating lastUsedAt after upload:', err),
      );
      return { success: true, message: 'File uploaded to browser session' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to upload file';
      throw new BadRequestException(message);
    }
  }

  private async pingActiveRecordingSessions() {
    const now = Date.now();

    for (const [sessionId, recordingSession] of this.activeRecordingSessions.entries()) {
      if (now - recordingSession.startTime > this.RECORDING_MAX_DURATION_MS) {
        console.log(`Recording session ${sessionId} exceeded max duration, stopping keepalive`);
        await this.stopRecordingKeepalive(sessionId);
        continue;
      }

      try {
        if (recordingSession.browser && recordingSession.browser.isConnected()) {
          const contexts = recordingSession.browser.contexts();
          if (contexts.length > 0) {
            const pages = contexts[0].pages();
            if (pages.length > 0) {
              await pages[0].evaluate(() => 1);
              recordingSession.lastPingTime = now;
            }
          }
        } else {
          // Try to reconnect
          try {
            const browser = await this.browserProvider.connectForKeepalive(
              sessionId,
              recordingSession.connectUrl,
            );
            recordingSession.browser = browser;
            recordingSession.lastPingTime = now;
          } catch (reconnectError) {
            console.error(`Failed to reconnect to session ${sessionId}:`, reconnectError);
            await this.stopRecordingKeepalive(sessionId);
          }
        }

        await this.updateLastUsed(sessionId);
      } catch (error) {
        console.error(`Error pinging recording session ${sessionId}:`, error);
      }
    }
  }
}

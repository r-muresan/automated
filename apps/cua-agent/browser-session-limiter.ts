const DEFAULT_MAX_CREATES_PER_MINUTE = 20;
const DEFAULT_MAX_CONCURRENT_SESSIONS = 25;
const CREATE_WINDOW_MS = 60_000;

function readPositiveIntegerEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readSessionLimiterEnv(
  primary: string,
  legacy: string,
  fallback: number,
): number {
  return readPositiveIntegerEnv(process.env[primary] ?? process.env[legacy], fallback);
}

export interface BrowserSessionCreateLease {
  confirmCreated: (sessionId: string) => void;
  cancel: () => void;
}

type QueueItem = {
  source: string;
  resolve: (lease: BrowserSessionCreateLease) => void;
};

class BrowserSessionLimiter {
  private readonly maxCreatesPerMinute: number;
  private readonly maxConcurrentSessions: number;

  private createTimestamps: number[] = [];
  private activeSessionIds = new Set<string>();
  private pendingReservations = 0;
  private queue: QueueItem[] = [];
  private processTimer: NodeJS.Timeout | null = null;

  constructor(options?: { maxCreatesPerMinute?: number; maxConcurrentSessions?: number }) {
    this.maxCreatesPerMinute =
      options?.maxCreatesPerMinute ??
      readSessionLimiterEnv(
        'BROWSER_MAX_SESSIONS_PER_MINUTE',
        'BROWSERBASE_MAX_SESSIONS_PER_MINUTE',
        DEFAULT_MAX_CREATES_PER_MINUTE,
      );

    this.maxConcurrentSessions =
      options?.maxConcurrentSessions ??
      readSessionLimiterEnv(
        'BROWSER_MAX_CONCURRENT_SESSIONS',
        'BROWSERBASE_MAX_CONCURRENT_SESSIONS',
        DEFAULT_MAX_CONCURRENT_SESSIONS,
      );
  }

  async acquireCreateLease(source: string): Promise<BrowserSessionCreateLease> {
    return await new Promise<BrowserSessionCreateLease>((resolve) => {
      this.queue.push({ source, resolve });
      this.logStats(`Queued create request from ${source}`);
      this.processQueue();
    });
  }

  registerActiveSession(sessionId: string): void {
    if (!sessionId) return;
    this.activeSessionIds.add(sessionId);
    this.processQueue();
  }

  releaseActiveSession(sessionId: string): void {
    if (!sessionId) return;
    const deleted = this.activeSessionIds.delete(sessionId);
    if (deleted) {
      this.processQueue();
    }
  }

  getStats() {
    this.pruneCreateTimestamps();
    return {
      maxCreatesPerMinute: this.maxCreatesPerMinute,
      maxConcurrentSessions: this.maxConcurrentSessions,
      queuedRequests: this.queue.length,
      createsInCurrentWindow: this.createTimestamps.length,
      activeSessions: this.activeSessionIds.size,
      pendingReservations: this.pendingReservations,
      trackedConcurrentSessions: this.activeSessionIds.size + this.pendingReservations,
    };
  }

  private processQueue(): void {
    this.clearProcessTimer();
    this.pruneCreateTimestamps();

    while (this.queue.length > 0 && this.canGrantNextLease()) {
      const queueItem = this.queue.shift();
      if (!queueItem) break;

      this.pendingReservations += 1;
      this.createTimestamps.push(Date.now());
      this.logStats(`Granted create lease to ${queueItem.source}`);
      queueItem.resolve(this.createLease(queueItem.source));
    }

    if (this.queue.length === 0) {
      return;
    }

    if (this.hasConcurrentCapacity()) {
      this.scheduleWhenRateWindowOpens();
    }
  }

  private createLease(source: string): BrowserSessionCreateLease {
    let finalized = false;

    const finalize = (sessionId?: string) => {
      if (finalized) return;
      finalized = true;

      if (this.pendingReservations > 0) {
        this.pendingReservations -= 1;
      }

      if (sessionId) {
        this.activeSessionIds.add(sessionId);
      }

      this.processQueue();
    };

    return {
      confirmCreated: (sessionId: string) => {
        if (!sessionId) {
          console.warn(`[BROWSER_SESSION_LIMITER] Empty session id for source ${source}`);
          finalize();
          return;
        }
        this.logStats(`Session created by ${source}: ${sessionId}`);
        finalize(sessionId);
      },
      cancel: () => finalize(),
    };
  }

  private canGrantNextLease(): boolean {
    return this.hasRateCapacity() && this.hasConcurrentCapacity();
  }

  private hasRateCapacity(): boolean {
    this.pruneCreateTimestamps();
    return this.createTimestamps.length < this.maxCreatesPerMinute;
  }

  private hasConcurrentCapacity(): boolean {
    return this.activeSessionIds.size + this.pendingReservations < this.maxConcurrentSessions;
  }

  private pruneCreateTimestamps(): void {
    const cutoff = Date.now() - CREATE_WINDOW_MS;
    while (this.createTimestamps.length > 0 && this.createTimestamps[0] <= cutoff) {
      this.createTimestamps.shift();
    }
  }

  private scheduleWhenRateWindowOpens(): void {
    if (this.queue.length === 0 || this.createTimestamps.length === 0) {
      return;
    }

    const nextAvailableAt = this.createTimestamps[0] + CREATE_WINDOW_MS;
    const delayMs = Math.max(nextAvailableAt - Date.now(), 50);

    this.processTimer = setTimeout(() => {
      this.processTimer = null;
      this.processQueue();
    }, delayMs);

    this.processTimer.unref?.();
  }

  private clearProcessTimer(): void {
    if (!this.processTimer) return;
    clearTimeout(this.processTimer);
    this.processTimer = null;
  }

  private logStats(message: string): void {
    this.pruneCreateTimestamps();
    const trackedConcurrent = this.activeSessionIds.size + this.pendingReservations;
    console.log(
      `[BROWSER_SESSION_LIMITER] ${message} | createsLast60s=${this.createTimestamps.length}/${this.maxCreatesPerMinute} active=${this.activeSessionIds.size} pending=${this.pendingReservations} trackedConcurrent=${trackedConcurrent}/${this.maxConcurrentSessions} queued=${this.queue.length}`,
    );
  }
}

const GLOBAL_LIMITER_KEY = '__automatedBrowserSessionLimiter__';

type GlobalLimiterHost = typeof globalThis & {
  [GLOBAL_LIMITER_KEY]?: BrowserSessionLimiter;
};

function getLimiter(): BrowserSessionLimiter {
  const host = globalThis as GlobalLimiterHost;
  host[GLOBAL_LIMITER_KEY] ??= new BrowserSessionLimiter();
  return host[GLOBAL_LIMITER_KEY];
}

export async function acquireBrowserSessionCreateLease(
  source: string,
): Promise<BrowserSessionCreateLease> {
  return await getLimiter().acquireCreateLease(source);
}

export function registerBrowserSession(sessionId: string): void {
  getLimiter().registerActiveSession(sessionId);
}

export function releaseBrowserSession(sessionId: string): void {
  getLimiter().releaseActiveSession(sessionId);
  const stats = getLimiter().getStats();
  console.log(
    `[BROWSER_SESSION_LIMITER] Released session ${sessionId} | createsLast60s=${stats.createsInCurrentWindow}/${stats.maxCreatesPerMinute} active=${stats.activeSessions} pending=${stats.pendingReservations} trackedConcurrent=${stats.trackedConcurrentSessions}/${stats.maxConcurrentSessions} queued=${stats.queuedRequests}`,
  );
}

export function getBrowserSessionLimiterStats() {
  return getLimiter().getStats();
}

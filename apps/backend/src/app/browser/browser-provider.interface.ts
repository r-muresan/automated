/** Minimal browser interface shared across playwright-core and patchright providers */
export interface BrowserHandle {
  isConnected(): boolean;
  close(): Promise<void>;
  contexts(): Array<{
    pages(): Array<{
      evaluate<R>(pageFunction: () => R): Promise<R>;
    }>;
  }>;
}

export interface CreateBrowserSessionOptions {
  colorScheme?: 'light' | 'dark';
  width?: number;
  height?: number;
  contextId?: string;
  userAgent?: string;
  timezone?: string;
}

export interface BrowserSessionResult {
  id: string;
  [key: string]: any;
}

export interface PageInfo {
  id: string;
  url: string;
  title: string;
}

export interface InitSessionOptions {
  colorScheme?: 'light' | 'dark';
  width?: number;
  height?: number;
}

export abstract class BrowserProvider {
  abstract createSession(options: CreateBrowserSessionOptions): Promise<BrowserSessionResult>;
  abstract stopSession(sessionId: string): Promise<boolean>;
  abstract getSession(sessionId: string): Promise<any>;
  abstract getDebugInfo(sessionId: string): Promise<any>;
  abstract initializeSession(sessionId: string, options?: InitSessionOptions): Promise<PageInfo[]>;
  abstract connectForKeepalive(sessionId: string): Promise<BrowserHandle | null>;
}

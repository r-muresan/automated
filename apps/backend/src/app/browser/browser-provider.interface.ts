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
  [key: string]: unknown;
}

export interface InitSessionOptions {
  colorScheme?: 'light' | 'dark';
  width?: number;
  height?: number;
  connectUrl?: string;
}

export interface InitSessionResult {
  pages: PageInfo[];
  cdpWsUrlTemplate?: string;
  liveViewUrl?: string;
  debuggerFullscreenUrl?: string;
  debuggerUrl?: string;
  wsUrl?: string;
  browserWsUrl?: string;
}

export interface SessionDebugInfoResult {
  session: any;
  debugInfo: any;
}

export interface SessionUploadFile {
  buffer: Buffer;
  originalname: string;
  mimetype?: string;
  size?: number;
}

export abstract class BrowserProvider {
  abstract createSession(options: CreateBrowserSessionOptions): Promise<BrowserSessionResult>;
  abstract stopSession(sessionId: string): Promise<boolean>;
  abstract getSession(sessionId: string): Promise<any>;
  abstract getSessionDebugInfo(sessionId: string): Promise<SessionDebugInfoResult>;
  abstract getDebugInfo(sessionId: string): Promise<any>;
  abstract initializeSession(
    sessionId: string,
    options?: InitSessionOptions,
  ): Promise<InitSessionResult>;
  abstract uploadSessionFile(sessionId: string, file: SessionUploadFile): Promise<void>;
}

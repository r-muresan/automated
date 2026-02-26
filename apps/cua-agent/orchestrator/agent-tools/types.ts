export type SpreadsheetProvider = 'google_sheets' | 'excel_web';

export type SpreadsheetErrorCode =
  | 'NOT_SPREADSHEET_PAGE'
  | 'BRIDGE_INJECTION_FAILED'
  | 'CLIPBOARD_READ_FAILED'
  | 'UNSUPPORTED_PROVIDER_STATE';

export interface TabSummary {
  index: number;
  title: string;
  url: string;
  isActive: boolean;
}

export interface CredentialHandoffRequest {
  reason: string;
}

export interface CredentialHandoffResult {
  continued: boolean;
  message?: string;
  requestId?: string;
}

export interface BrowserToolOptions {
  onRequestCredentials?: (request: CredentialHandoffRequest) => Promise<CredentialHandoffResult>;
}

export interface CdpPageLike {
  url(): string;
  title(): Promise<string>;
  waitForLoadState(state: 'load' | 'domcontentloaded' | 'networkidle', timeoutMs?: number): Promise<void>;
  keyPress(key: string, options?: { delay?: number }): Promise<void>;
  sendCDP<T = unknown>(method: string, params?: object): Promise<T>;
}

export type SpreadsheetToolError = {
  success: false;
  error: {
    code: SpreadsheetErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
};

export type SpreadsheetPageState =
  | { page: CdpPageLike; url: string; provider: SpreadsheetProvider }
  | { error: SpreadsheetToolError };

export type BridgeRunResult =
  | {
      ok: true;
      value: unknown;
    }
  | {
      ok: false;
      error: {
        code: SpreadsheetErrorCode;
        message: string;
      };
    };

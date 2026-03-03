import { randomUUID } from 'crypto';
import path from 'path';
import OpenAI from 'openai';
import type { Protocol } from 'devtools-protocol';
import type { Stagehand } from '../stagehand/v3';
import type {
  AgentInteractionScope,
  AgentInteractionSync,
  AgentInteractionSyncResult,
  AgentUploadedFileNote,
} from '../stagehand/v3/types/public/agent';
import type { CDPSessionLike } from '../stagehand/v3/understudy/cdp';
import type {
  DownloadedSessionFile,
  LoopContext,
  OrchestratorEvent,
  PendingDownloadedFile,
  Step,
  StepExecutionContext,
  UploadedSessionFileEvent,
} from '../types';
import { selectDownloadedFilesForUpload, type FileSelectionResult } from './session-files';

export const DEFAULT_SESSION_DOWNLOAD_PATH = '/tmp/downloads';
const FILE_CHOOSER_SCOPE_GRACE_MS = 3000;
const FILE_CHOOSER_SCOPE_SETTLE_TIMEOUT_MS = 15000;

interface InteractionScopeState {
  active: boolean;
  taskIds: Set<number>;
  onTaskAdded?: () => void;
}

interface UploadedSessionFileRecord {
  chooserTaskId: number;
  upload: UploadedSessionFileEvent;
}

interface SessionFileManagerDeps {
  emit: (event: OrchestratorEvent) => void;
  getActivePageUrl: () => string;
  getAgentModel: () => string;
}

function waitForTaskWithTimeout(taskPromise: Promise<void>, timeoutMs: number): Promise<void> {
  let timeoutHandle: NodeJS.Timeout | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        new Error(`Timed out waiting for intercepted file upload to finish after ${timeoutMs}ms.`),
      );
    }, timeoutMs);
  });

  return Promise.race([taskPromise, timeoutPromise]).finally(() => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  });
}

export class SessionFileManager {
  private stagehand: Stagehand | null = null;
  private openai: OpenAI | null = null;
  private currentStepContext: StepExecutionContext | null = null;
  private downloadedSessionFiles: DownloadedSessionFile[] = [];
  private uploadedSessionFileRecords: UploadedSessionFileRecord[] = [];
  private pendingDownloadsByGuid: Map<string, PendingDownloadedFile> = new Map();
  private fileChooserQueue: Promise<void> = Promise.resolve();
  private fileChooserTaskPromises: Map<number, Promise<void>> = new Map();
  private nextFileChooserTaskId = 0;
  private fileChooserErrors: Error[] = [];
  private interactionScopes: Map<string, InteractionScopeState> = new Map();
  private restoreCdpEventLogger: (() => void) | null = null;

  constructor(
    private readonly deps: SessionFileManagerDeps,
    private readonly downloadPath: string = DEFAULT_SESSION_DOWNLOAD_PATH,
  ) {}

  beginStep(
    step: Step,
    index: number,
    instruction: string,
    loopContext?: LoopContext,
  ): StepExecutionContext {
    const stepContext = this.buildStepContext(step, index, instruction, loopContext);
    this.currentStepContext = stepContext;
    return stepContext;
  }

  endStep(stepContext: StepExecutionContext): void {
    if (this.currentStepContext === stepContext) {
      this.currentStepContext = null;
    }
  }

  getDownloadedFiles(): DownloadedSessionFile[] {
    return this.downloadedSessionFiles;
  }

  getUploadedFiles(): UploadedSessionFileEvent[] {
    return this.uploadedSessionFileRecords.map((record) => record.upload);
  }

  createAgentInteractionSync(): AgentInteractionSync {
    return {
      beginScope: (): AgentInteractionScope => {
        const scopeId = randomUUID();
        this.interactionScopes.set(scopeId, {
          active: true,
          taskIds: new Set<number>(),
        });

        return {
          settle: async (): Promise<AgentInteractionSyncResult | null> => {
            return this.settleInteractionScope(scopeId);
          },
        };
      },
    };
  }

  async attach(stagehand: Stagehand, openai: OpenAI): Promise<void> {
    this.stagehand = stagehand;
    this.openai = openai;

    await this.enableFileChooserInterceptionForExistingPages();

    const conn = stagehand.context.conn;
    const previousEventLogger = conn.cdpEventLogger;
    const wrappedEventLogger = (info: {
      method: string;
      params?: unknown;
      targetId?: string | null;
    }) => {
      previousEventLogger?.(info);
      void this.handleSessionFileCdpEvent(info);
    };

    conn.cdpEventLogger = wrappedEventLogger;
    this.restoreCdpEventLogger = () => {
      if (conn.cdpEventLogger === wrappedEventLogger) {
        conn.cdpEventLogger = previousEventLogger;
      }
    };
  }

  async waitForSettledChooserWork(): Promise<void> {
    await this.fileChooserQueue.catch(() => {});
    const fileChooserError = this.fileChooserErrors.shift();
    if (fileChooserError) {
      throw fileChooserError;
    }
  }

  reset(): void {
    this.restoreCdpEventLogger?.();
    this.restoreCdpEventLogger = null;
    this.stagehand = null;
    this.openai = null;
    this.currentStepContext = null;
    this.downloadedSessionFiles = [];
    this.uploadedSessionFileRecords = [];
    this.pendingDownloadsByGuid.clear();
    this.fileChooserTaskPromises.clear();
    this.nextFileChooserTaskId = 0;
    this.fileChooserErrors = [];
    this.interactionScopes.clear();
    this.fileChooserQueue = Promise.resolve();
  }

  private cloneLoopItem(item: unknown): unknown {
    if (item === undefined) return undefined;
    try {
      return JSON.parse(JSON.stringify(item));
    } catch {
      return item;
    }
  }

  private cloneStepExecutionContext(
    context: StepExecutionContext | null | undefined,
  ): StepExecutionContext | null {
    if (!context) return null;

    return {
      ...context,
      ...(context.loopItem !== undefined ? { loopItem: this.cloneLoopItem(context.loopItem) } : {}),
    };
  }

  private buildStepContext(
    step: Step,
    index: number,
    instruction: string,
    loopContext?: LoopContext,
  ): StepExecutionContext {
    return {
      stepIndex: index,
      stepType: step.type,
      instruction,
      pageUrl: this.deps.getActivePageUrl() || null,
      startedAt: new Date().toISOString(),
      ...(typeof loopContext?.itemIndex === 'number'
        ? { loopItemIndex: loopContext.itemIndex }
        : {}),
      ...(loopContext?.item !== undefined
        ? { loopItem: this.cloneLoopItem(loopContext.item) }
        : {}),
    };
  }

  private recordFileChooserError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.fileChooserErrors.push(normalized);
  }

  private enqueueFileChooserTask(task: (chooserTaskId: number) => Promise<void>): void {
    const chooserTaskId = ++this.nextFileChooserTaskId;
    for (const scope of this.interactionScopes.values()) {
      if (scope.active) {
        scope.taskIds.add(chooserTaskId);
        scope.onTaskAdded?.();
      }
    }

    const taskPromise = this.fileChooserQueue.catch(() => {}).then(() => task(chooserTaskId));
    this.fileChooserTaskPromises.set(chooserTaskId, taskPromise);
    this.fileChooserQueue = taskPromise.catch((error) => {
      this.recordFileChooserError(error);
    });
  }

  private getPageByTargetId(targetId: string) {
    if (!this.stagehand) return null;
    return this.stagehand.context.pages().find((page) => page.targetId() === targetId) ?? null;
  }

  private async enableFileChooserInterceptionForSession(session: CDPSessionLike): Promise<void> {
    await session
      .send('Page.setInterceptFileChooserDialog', {
        enabled: true,
      })
      .catch((error) => {
        console.warn(
          '[ORCHESTRATOR] Failed to enable file chooser interception on session:',
          error,
        );
      });
  }

  private async enableFileChooserInterceptionForExistingPages(): Promise<void> {
    if (!this.stagehand) return;

    await Promise.all(
      this.stagehand.context.pages().map((page) =>
        page
          .sendCDP('Page.setInterceptFileChooserDialog', {
            enabled: true,
          })
          .catch((error) => {
            console.warn(
              `[ORCHESTRATOR] Failed to enable file chooser interception for target ${page.targetId()}:`,
              error,
            );
          }),
      ),
    );
  }

  private handleDownloadWillBegin(params: Protocol.Browser.DownloadWillBeginEvent): void {
    if (!params.guid) return;

    const filename = params.suggestedFilename || 'download';
    this.pendingDownloadsByGuid.set(params.guid, {
      id: randomUUID(),
      guid: params.guid,
      filename,
      remotePath: `${this.downloadPath}/${filename}`,
      ...(params.url ? { downloadUrl: params.url } : {}),
      sourceStep: this.cloneStepExecutionContext(this.currentStepContext) ?? {
        stepIndex: null,
        stepType: null,
        instruction: null,
        pageUrl: this.deps.getActivePageUrl() || null,
        startedAt: new Date().toISOString(),
      },
    });
  }

  private handleDownloadProgress(params: Protocol.Browser.DownloadProgressEvent): void {
    if (!params.guid) return;

    if (params.state === 'canceled') {
      this.pendingDownloadsByGuid.delete(params.guid);
      return;
    }

    if (params.state !== 'completed') return;

    const pendingFile = this.pendingDownloadsByGuid.get(params.guid);
    if (!pendingFile) return;

    const completedFile: DownloadedSessionFile = {
      ...pendingFile,
      completedAt: new Date().toISOString(),
    };
    this.pendingDownloadsByGuid.delete(params.guid);
    this.downloadedSessionFiles.push(completedFile);
    this.deps.emit({
      type: 'file:downloaded',
      file: completedFile,
    });
  }

  private buildUploadedSessionFileEvent(
    args: {
      chooserMode: UploadedSessionFileEvent['chooserMode'];
      targetStep: StepExecutionContext | null;
    },
    selection: FileSelectionResult,
    pageUrl: string | null,
  ): UploadedSessionFileEvent {
    return {
      selectedFileIds: selection.selectedFileIds,
      selectedRemotePaths: selection.selectedRemotePaths,
      selectedFiles: selection.selectedFiles,
      chooserMode: args.chooserMode,
      targetStep: this.cloneStepExecutionContext(args.targetStep) ?? {
        stepIndex: null,
        stepType: null,
        instruction: null,
        pageUrl,
        startedAt: new Date().toISOString(),
      },
      uploadedAt: new Date().toISOString(),
      reason: selection.reason,
    };
  }

  private async handleFileChooserOpened(args: {
    chooserTaskId: number;
    targetId: string;
    chooserMode: UploadedSessionFileEvent['chooserMode'];
    backendNodeId: number;
    targetStep: StepExecutionContext | null;
  }): Promise<void> {
    if (!this.stagehand || !this.openai) {
      throw new Error('Upload interception is unavailable before the orchestrator is initialized.');
    }

    const page = this.getPageByTargetId(args.targetId);
    if (!page) {
      throw new Error(`Could not resolve target page for upload interception (${args.targetId}).`);
    }

    const pageUrl = page.url() || args.targetStep?.pageUrl || null;
    const selection = await selectDownloadedFilesForUpload({
      openai: this.openai,
      model: this.deps.getAgentModel(),
      chooserMode: args.chooserMode,
      currentStep: args.targetStep,
      pageUrl,
      candidates: [...this.downloadedSessionFiles].reverse(),
    });

    console.log(selection);

    await page.sendCDP('DOM.enable').catch(() => {});
    await page.sendCDP('DOM.setFileInputFiles', {
      backendNodeId: args.backendNodeId,
      files: selection.selectedRemotePaths,
    });

    const upload = this.buildUploadedSessionFileEvent(args, selection, pageUrl);
    this.uploadedSessionFileRecords.push({
      chooserTaskId: args.chooserTaskId,
      upload,
    });
    this.deps.emit({
      type: 'file:uploaded',
      upload,
    });
  }

  private async settleInteractionScope(
    scopeId: string,
  ): Promise<AgentInteractionSyncResult | null> {
    const scope = this.interactionScopes.get(scopeId);
    if (!scope) return null;

    // If there are downloaded files that could be uploaded, wait for a file chooser event
    // (up to the grace period). Otherwise skip the wait since no upload can happen.
    if (this.downloadedSessionFiles.length > 0) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, FILE_CHOOSER_SCOPE_GRACE_MS);
        scope.onTaskAdded = () => {
          clearTimeout(timeout);
          resolve();
        };
      });
      scope.onTaskAdded = undefined;
    }
    scope.active = false;

    try {
      for (const taskId of scope.taskIds) {
        const taskPromise = this.fileChooserTaskPromises.get(taskId);
        if (taskPromise) {
          try {
            await waitForTaskWithTimeout(taskPromise, FILE_CHOOSER_SCOPE_SETTLE_TIMEOUT_MS);
          } catch (error) {
            const normalized = error instanceof Error ? error : new Error(String(error));
            normalized.name = 'AgentInteractionSyncError';
            throw normalized;
          }
        }
      }

      const uploads = this.uploadedSessionFileRecords
        .filter((record) => scope.taskIds.has(record.chooserTaskId))
        .map((record) => record.upload);

      if (uploads.length === 0) {
        return null;
      }

      return this.buildInteractionSyncResult(uploads);
    } finally {
      this.interactionScopes.delete(scopeId);
    }
  }

  private buildInteractionSyncResult(
    uploads: UploadedSessionFileEvent[],
  ): AgentInteractionSyncResult | null {
    const uploadedFiles: AgentUploadedFileNote[] = uploads.flatMap((upload) =>
      upload.selectedFiles.map((file, index) => {
        const remotePath = upload.selectedRemotePaths[index] ?? file.remotePath;
        return {
          fileId: file.id,
          filename: file.filename,
          uploadedAs: path.basename(remotePath),
          remotePath,
        };
      }),
    );

    if (uploadedFiles.length === 0) {
      return null;
    }

    const uploadMessage =
      uploadedFiles.length === 1
        ? `Uploaded ${uploadedFiles[0].filename} as ${uploadedFiles[0].uploadedAs}.`
        : `Uploaded ${uploadedFiles.length} files: ${uploadedFiles
            .map((file) => `${file.filename} as ${file.uploadedAs}`)
            .join('; ')}.`;

    return {
      uploadedFiles,
      uploadMessage,
    };
  }

  private async handleSessionFileCdpEvent(info: {
    method: string;
    params?: unknown;
    targetId?: string | null;
  }): Promise<void> {
    if (info.method === 'Browser.downloadWillBegin') {
      this.handleDownloadWillBegin(info.params as Protocol.Browser.DownloadWillBeginEvent);
      return;
    }

    if (info.method === 'Browser.downloadProgress') {
      this.handleDownloadProgress(info.params as Protocol.Browser.DownloadProgressEvent);
      return;
    }

    if (info.method === 'Target.attachedToTarget') {
      const params = info.params as Protocol.Target.AttachedToTargetEvent;
      const subtype = (params.targetInfo as Protocol.Target.TargetInfo & { subtype?: string })
        .subtype;
      if (params.targetInfo.type === 'page' && subtype !== 'iframe') {
        const session = this.stagehand?.context.conn.getSession(params.sessionId);
        if (session) {
          await this.enableFileChooserInterceptionForSession(session);
        }
      }
      return;
    }

    if (info.method !== 'Page.fileChooserOpened') return;

    const targetId = info.targetId;
    const params = info.params as { mode?: string; backendNodeId?: number } | undefined;
    if (!targetId || typeof params?.backendNodeId !== 'number') return;
    const backendNodeId = params.backendNodeId;
    const targetStep = this.cloneStepExecutionContext(this.currentStepContext);

    console.log(
      `[SESSION_FILES] File chooser intercepted via CDP (mode=${params.mode ?? 'unknown'}, target=${targetId}, downloadedFiles=${this.downloadedSessionFiles.length})`,
    );

    this.enqueueFileChooserTask((chooserTaskId) =>
      this.handleFileChooserOpened({
        chooserTaskId,
        targetId,
        chooserMode: params.mode || 'selectSingle',
        backendNodeId,
        targetStep,
      }),
    );
  }
}

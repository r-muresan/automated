import type {
  AgentInteractionScope,
  AgentInteractionSync,
  AgentInteractionSyncResult,
  AgentUploadedFileNote,
} from "../../types/public/agent.js";

type UploadAwareToolResult = {
  uploadedFiles?: AgentUploadedFileNote[];
  uploadMessage?: string;
};

export function beginInteractionScope(
  interactionSync?: AgentInteractionSync,
): AgentInteractionScope | null {
  return interactionSync?.beginScope() ?? null;
}

export async function settleInteractionScope(
  scope: AgentInteractionScope | null,
): Promise<AgentInteractionSyncResult | null> {
  if (!scope) return null;
  console.log('[INTERACTION_SYNC] Settling interaction scope (waiting for pending file uploads)...');
  const result = await scope.settle();
  console.log(
    `[INTERACTION_SYNC] Interaction scope settled${result ? ` — uploaded ${result.uploadedFiles?.length ?? 0} file(s)` : ' — no uploads'}`,
  );
  return result;
}

export function mergeInteractionSyncResult<T extends object>(
  result: T,
  syncResult: AgentInteractionSyncResult | null,
): T & UploadAwareToolResult {
  if (!syncResult) return result as T & UploadAwareToolResult;

  return {
    ...result,
    uploadedFiles: syncResult.uploadedFiles,
    ...(syncResult.uploadMessage ? { uploadMessage: syncResult.uploadMessage } : {}),
  } as T & UploadAwareToolResult;
}

export function rethrowInteractionSyncError(error: unknown): void {
  if (error instanceof Error && error.name === "AgentInteractionSyncError") {
    throw error;
  }
}

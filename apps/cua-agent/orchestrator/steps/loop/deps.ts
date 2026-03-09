import OpenAI from 'openai';
import type { Stagehand } from '../../../stagehand/v3';
import type { AgentInteractionSync } from '../../../stagehand/v3/types/public/agent';
import type {
  DownloadedSessionFile,
  LoopStep,
  LoopContext,
  OrchestratorEvent,
  SavedFile,
  Step,
  UploadedSessionFileEvent,
} from '../../../types';
import type { CredentialHandoffRequest, CredentialHandoffResult } from '../../agent-tools';

export interface LoopDeps {
  stagehand: Stagehand;
  openai: OpenAI;
  models: { extract: string; agent: string };
  openrouterApiKey: string;
  openrouterBaseUrl: string;
  emit: (event: OrchestratorEvent) => void;
  assertNotAborted: () => void;
  executeSteps: (steps: Step[], context?: LoopContext) => Promise<void>;
  getDownloadedFiles: () => DownloadedSessionFile[];
  getUploadedFiles: () => UploadedSessionFileEvent[];
  getAgentInteractionSync: () => AgentInteractionSync;
  requestCredentialHandoff?: (
    request: CredentialHandoffRequest,
    step: LoopStep,
    index: number,
  ) => Promise<CredentialHandoffResult>;
}

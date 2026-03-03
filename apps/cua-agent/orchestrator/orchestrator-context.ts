import type OpenAI from 'openai';
import type { Stagehand } from '../stagehand/v3';
import type {
  Step,
  StepResult,
  SavedFile,
  OrchestratorOptions,
  OrchestratorEvent,
  LoopContext,
  CredentialRequestResult,
} from '../types';
import type { SessionFileManager } from './session-file-manager';
import type { CredentialHandoffRequest } from './agent-tools';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export const DEFAULT_MODELS = {
  extract: 'google/gemini-2.5-flash',
  agent: 'moonshotai/kimi-k2.5',
  conditional: 'google/gemini-3-flash-preview',
  save: 'google/gemini-3-flash-preview',
};

export interface OrchestratorContext {
  // Mutable state
  stagehand: Stagehand | null;
  openai: OpenAI | null;
  extractedVariables: Record<string, string>;
  globalState: any[];
  savedFiles: SavedFile[];
  stepResults: StepResult[];
  workflowName: string;
  sessionFiles: SessionFileManager;
  options: OrchestratorOptions;

  // Methods
  emit: (event: OrchestratorEvent) => void;
  assertNotAborted: () => void;
  resolveModels: () => { extract: string; agent: string; conditional: string; save: string };
  getActivePageUrl: () => string;
  executeSteps: (steps: Step[], context?: LoopContext, indexOffset?: number) => Promise<void>;
  requestCredentialHandoff: (
    request: CredentialHandoffRequest,
    step: Step,
    index: number,
    instruction: string,
  ) => Promise<CredentialRequestResult>;
  buildPrepareStepForActiveTools: (
    scope: string,
  ) => (opts?: { stepNumber?: number }) => Promise<{ activeTools: any }>;
}

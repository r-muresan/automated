// Shared type definitions for browser agent

// --- Workflow Types ---

export type Step =
  | SingleStep
  | LoopStep
  | ConditionalStep
  | ExtractStep
  | NavigateStep
  | TabNavigateStep
  | SaveStep;

export interface NavigateStep {
  type: 'navigate';
  url: string;
}

export interface TabNavigateStep {
  type: 'tab_navigate';
  url: string;
}

export interface SaveStep {
  type: 'save';
  description: string;
}

export interface SingleStep {
  type: 'step';
  description: string;
}

export interface ExtractStep {
  type: 'extract';
  description: string;
  dataSchema?: string; // Keys to extract
}

export interface LoopStep {
  type: 'loop';
  description: string;
  steps: Step[];
}

export interface ConditionalStep {
  type: 'conditional';
  condition: string;
  trueSteps: Step[];
  falseSteps?: Step[];
}

export interface Workflow {
  name: string;
  startingUrl?: string;
  inputs?: string[];
  steps: Step[];
}

export interface LoopContext {
  item?: unknown;
  itemIndex?: number;
}

// --- Results ---

export interface StepResult {
  instruction: string;
  success: boolean;
  output?: string;
  error?: string;
}

export interface SavedFile {
  output: string;
  outputExtension: string;
}

export interface SaveStepOutput extends SavedFile {
  savedFileIndex: number;
  fallback?: boolean;
}

export interface WorkflowResult {
  workflowName: string;
  stepResults: StepResult[];
  extractedVariables: Record<string, string>;
  globalState: any[];
  savedFiles: SavedFile[];
  success: boolean;
}

// --- Loop Fallback Types ---

export interface LoopElementResult {
  selector: string; // XPath selector
  description: string; // Description of element
}

export interface FallbackAnalysisResult {
  success: boolean;
  elements: LoopElementResult[];
  strategy: 'dom_analysis' | 'agent_fallback' | 'none';
  confidence: 'high' | 'medium' | 'low';
}

// --- Browser State Types ---

export interface TabState {
  url: string;
  index: number;
}

export interface BrowserState {
  tabs: TabState[];
  activeTabIndex: number;
}

export interface CredentialRequest {
  reason: string;
  stepIndex?: number;
  stepType?: Step['type'];
  instruction?: string;
}

export interface CredentialRequestResult {
  continued: boolean;
  message?: string;
  requestId?: string;
}

// --- Orchestrator Events ---

export type OrchestratorEvent =
  | { type: 'workflow:start'; workflow: Workflow }
  | { type: 'workflow:complete'; workflow: Workflow; result: WorkflowResult }
  | { type: 'workflow:error'; workflow: Workflow; error: string }
  | { type: 'session:ready'; sessionId: string; liveViewUrl: string }
  | { type: 'step:start'; step: Step; index: number; instruction: string }
  | {
      type: 'step:end';
      step: Step;
      index: number;
      success: boolean;
      error?: string;
      savedFile?: SaveStepOutput;
    }
  | {
      type: 'loop:iteration:start';
      step: LoopStep;
      index: number;
      iteration: number;
      totalItems: number;
      item: unknown;
    }
  | {
      type: 'loop:iteration:end';
      step: LoopStep;
      index: number;
      iteration: number;
      totalItems: number;
      success: boolean;
      error?: string;
    }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string; data?: any };

export interface OrchestratorModels {
  /** Model for data extraction steps (default: google/gemini-2.5-flash) */
  extract?: string;
  /** Model for agent/browser steps (default: anthropic/claude-sonnet-4.6) */
  agent?: string;
  /** Model for conditional evaluation (default: google/gemini-3-flash-preview) */
  conditional?: string;
  /** Model for save/file-generation steps (default: google/gemini-3-flash-preview) */
  save?: string;
}

export interface OrchestratorOptions {
  onEvent?: (event: OrchestratorEvent) => void;
  onCredentialRequest?: (request: CredentialRequest) => Promise<CredentialRequestResult>;
  models?: OrchestratorModels;
  browserbaseProjectId?: string;
  browserbaseContextId?: string;
  /** CDP WebSocket URL to connect to an existing local browser session instead of Browserbase */
  localCdpUrl?: string;
  /** The local browser session ID (used for session:ready event so frontend can connect) */
  localSessionId?: string;
  verbose?: number;
}

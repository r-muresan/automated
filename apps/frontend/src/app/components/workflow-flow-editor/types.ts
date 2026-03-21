import type { WorkflowStep } from '@automated/api-dtos';
import type { IconType } from 'react-icons';
import {
  FiExternalLink,
  FiGitBranch,
  FiLayers,
  FiMousePointer,
  FiNavigation,
  FiRepeat,
  FiSave,
  FiSearch,
} from 'react-icons/fi';

export type StepType = 'step' | 'extract' | 'loop' | 'conditional' | 'navigate' | 'tab_navigate' | 'switch_tab' | 'save';

export type EditorStep =
  | { id: string; type: 'step'; description: string }
  | { id: string; type: 'extract'; description: string; dataSchema?: string }
  | { id: string; type: 'navigate'; url: string }
  | { id: string; type: 'tab_navigate'; url: string }
  | { id: string; type: 'switch_tab'; tabIndex: number }
  | { id: string; type: 'save'; description: string }
  | { id: string; type: 'loop'; description: string; steps: EditorStep[] }
  | {
      id: string;
      type: 'conditional';
      condition: string;
      trueSteps: EditorStep[];
      falseSteps: EditorStep[];
    };

export type ApiStep = WorkflowStep;

export type BranchLabel = 'main' | 'true' | 'false' | 'loop';

export const STEP_TYPE_OPTIONS: Array<{ type: StepType; label: string; hint: string; icon: IconType }> = [
  { type: 'step', label: 'Step', hint: 'Single action', icon: FiMousePointer },
  { type: 'extract', label: 'Extract', hint: 'Capture data', icon: FiSearch },
  { type: 'loop', label: 'Loop', hint: 'Repeat steps', icon: FiRepeat },
  { type: 'conditional', label: 'Conditional', hint: 'If/else logic', icon: FiGitBranch },
  { type: 'navigate', label: 'Navigate', hint: 'Open URL', icon: FiNavigation },
  { type: 'tab_navigate', label: 'Tab Navigate', hint: 'New tab', icon: FiExternalLink },
  { type: 'switch_tab', label: 'Switch Tab', hint: 'Change active tab', icon: FiLayers },
  { type: 'save', label: 'Save', hint: 'Persist data', icon: FiSave },
];

export const STEP_TYPE_META = STEP_TYPE_OPTIONS.reduce(
  (acc, option) => {
    acc[option.type] = option;
    return acc;
  },
  {} as Record<StepType, (typeof STEP_TYPE_OPTIONS)[number]>,
);

export const TYPE_COLORS: Record<StepType, { bg: string; border: string; accent: string }> = {
  step: { bg: '#EFEFEF', border: '#E4E4E4', accent: '#666666' },
  extract: { bg: '#EEF4FF', border: '#C9D9F4', accent: '#2E6FD0' },
  loop: { bg: '#FFF4E8', border: '#F3D7B8', accent: '#C0702D' },
  conditional: { bg: '#F4EEFF', border: '#DCCEF7', accent: '#7B4BD9' },
  navigate: { bg: '#EAF7EF', border: '#C3E8D1', accent: '#2E9A59' },
  tab_navigate: { bg: '#EAF7EF', border: '#C3E8D1', accent: '#2E9A59' },
  switch_tab: { bg: '#EAF7EF', border: '#C3E8D1', accent: '#2E9A59' },
  save: { bg: '#F3F3F3', border: '#E4E4E4', accent: '#666666' },
};

export function createId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `step-${Math.random().toString(36).slice(2, 10)}`;
}

export function toEditorStep(step: ApiStep): EditorStep {
  const id = createId();
  switch (step.type) {
    case 'loop':
      return {
        id,
        type: 'loop',
        description: step.description ?? '',
        steps: (step.steps ?? []).map(toEditorStep),
      };
    case 'conditional':
      return {
        id,
        type: 'conditional',
        condition: step.condition ?? '',
        trueSteps: (step.trueSteps ?? []).map(toEditorStep),
        falseSteps: (step.falseSteps ?? []).map(toEditorStep),
      };
    case 'extract':
      return {
        id,
        type: 'extract',
        description: step.description ?? '',
        dataSchema: step.dataSchema ?? '',
      };
    case 'navigate':
      return { id, type: 'navigate', url: step.url ?? '' };
    case 'tab_navigate':
      return { id, type: 'tab_navigate', url: step.url ?? '' };
    case 'switch_tab':
      return { id, type: 'switch_tab', tabIndex: (step as any).tabIndex ?? 0 };
    case 'save':
      return { id, type: 'save', description: step.description ?? '' };
    case 'step':
    default:
      return { id, type: 'step', description: step.description ?? '' };
  }
}

export function toApiStep(step: EditorStep): ApiStep {
  switch (step.type) {
    case 'loop':
      return {
        type: 'loop',
        description: step.description,
        steps: step.steps.map(toApiStep),
      };
    case 'conditional':
      return {
        type: 'conditional',
        condition: step.condition,
        trueSteps: step.trueSteps.map(toApiStep),
        falseSteps: step.falseSteps.length > 0 ? step.falseSteps.map(toApiStep) : [],
      };
    case 'extract':
      return {
        type: 'extract',
        description: step.description,
        dataSchema: step.dataSchema || undefined,
      };
    case 'navigate':
      return { type: 'navigate', url: step.url };
    case 'tab_navigate':
      return { type: 'tab_navigate', url: step.url };
    case 'switch_tab':
      return { type: 'switch_tab', tabIndex: step.tabIndex };
    case 'save':
      return { type: 'save', description: step.description };
    case 'step':
    default:
      return { type: 'step', description: step.description };
  }
}

export function createNewStep(type: StepType): EditorStep {
  const id = createId();
  switch (type) {
    case 'loop':
      return { id, type: 'loop', description: '', steps: [] };
    case 'conditional':
      return { id, type: 'conditional', condition: '', trueSteps: [], falseSteps: [] };
    case 'extract':
      return { id, type: 'extract', description: '', dataSchema: '' };
    case 'navigate':
      return { id, type: 'navigate', url: '' };
    case 'tab_navigate':
      return { id, type: 'tab_navigate', url: '' };
    case 'switch_tab':
      return { id, type: 'switch_tab', tabIndex: 0 };
    case 'save':
      return { id, type: 'save', description: '' };
    case 'step':
    default:
      return { id, type: 'step', description: '' };
  }
}

export function changeStepType(step: EditorStep, nextType: StepType): EditorStep {
  if (step.type === nextType) return step;

  const description =
    'description' in step ? step.description : step.type === 'conditional' ? step.condition : '';
  const url = step.type === 'navigate' || step.type === 'tab_navigate' ? step.url : '';
  const tabIndex = step.type === 'switch_tab' ? step.tabIndex : 0;

  const next = createNewStep(nextType);
  // Preserve the original id
  (next as { id: string }).id = step.id;

  if ('description' in next && description) {
    (next as { description: string }).description = description;
  }
  if ('url' in next && url) {
    (next as { url: string }).url = url;
  }
  if (next.type === 'switch_tab') {
    next.tabIndex = tabIndex;
  }
  if (next.type === 'conditional') {
    next.condition = step.type === 'conditional' ? step.condition : description;
  }
  if (next.type === 'extract' && step.type === 'extract') {
    next.dataSchema = step.dataSchema ?? '';
  }

  return next;
}

export function getStepLabel(step: EditorStep): string {
  switch (step.type) {
    case 'step':
    case 'save':
    case 'extract':
      return step.description || `(empty ${step.type})`;
    case 'loop':
      return step.description || '(empty loop)';
    case 'conditional':
      return step.condition || '(empty condition)';
    case 'navigate':
    case 'tab_navigate':
      return step.url || '(no URL)';
    case 'switch_tab':
      return `Tab ${step.tabIndex}`;
  }
}

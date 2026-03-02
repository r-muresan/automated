import OpenAI from 'openai';
import { z } from 'zod';
import type {
  DownloadedSessionFile,
  StepExecutionContext,
  UploadedSessionFileEvent,
} from '../types';

const FILE_SELECTOR_RESPONSE_SCHEMA = z.object({
  selectedFileIds: z.array(z.string()).default([]),
  reason: z.string().min(1).default('Selected the best matching previously downloaded file.'),
  confidence: z.enum(['high', 'medium', 'low']).default('low'),
});

const MAX_SYSTEM_PROMPT_DOWNLOADS = 10;

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable]"';
  }
}

function describeStepContext(context: StepExecutionContext | null | undefined): string {
  if (!context) return 'No current step context.';

  const parts = [
    `stepIndex=${context.stepIndex ?? 'unknown'}`,
    `stepType=${context.stepType ?? 'unknown'}`,
    `instruction=${context.instruction ?? 'unknown'}`,
    `pageUrl=${context.pageUrl ?? 'unknown'}`,
    `startedAt=${context.startedAt}`,
  ];

  if (typeof context.loopItemIndex === 'number') {
    parts.push(`loopItemIndex=${context.loopItemIndex}`);
  }

  if (context.loopItem !== undefined) {
    parts.push(`loopItem=${safeJson(context.loopItem)}`);
  }

  return parts.join(', ');
}

export function buildSessionDownloadedFilesSection(
  downloadedFiles: DownloadedSessionFile[],
  maxFiles = MAX_SYSTEM_PROMPT_DOWNLOADS,
): string {
  if (downloadedFiles.length === 0) return '';

  const lines = downloadedFiles
    .slice(-maxFiles)
    .reverse()
    .map((file) => {
      const origin = [
        `source_step=${file.sourceStep.stepIndex ?? 'unknown'}`,
        `source_type=${file.sourceStep.stepType ?? 'unknown'}`,
        `source_instruction=${file.sourceStep.instruction ?? 'unknown'}`,
      ];

      if (typeof file.sourceStep.loopItemIndex === 'number') {
        origin.push(`loop_item_index=${file.sourceStep.loopItemIndex}`);
      }

      origin.push(`completed_at=${file.completedAt}`);

      return `- id=${file.id}; filename=${file.filename}; ${origin.join('; ')}`;
    });

  return ['## Session Downloaded Files', ...lines].join('\n');
}

export function buildFileSelectionPrompt(args: {
  chooserMode: UploadedSessionFileEvent['chooserMode'];
  currentStep: StepExecutionContext | null;
  pageUrl?: string | null;
  candidates: DownloadedSessionFile[];
}): string {
  const candidatePayload = args.candidates.map((file) => ({
    id: file.id,
    filename: file.filename,
    remotePath: file.remotePath,
    downloadUrl: file.downloadUrl ?? null,
    completedAt: file.completedAt,
    sourceStep: file.sourceStep,
  }));

  return [
    'Choose the best previously downloaded file to upload for the current browser step.',
    'Return JSON only.',
    '',
    `Chooser mode: ${args.chooserMode}`,
    `Target page URL: ${args.pageUrl ?? args.currentStep?.pageUrl ?? 'unknown'}`,
    `Current step: ${describeStepContext(args.currentStep)}`,
    '',
    'Candidate downloaded files (newest first):',
    safeJson(candidatePayload),
    '',
    'Selection rules:',
    '- Match the file to the current step goal and page context.',
    '- Prefer files whose source step instruction or loop item most closely matches the current upload step.',
    '- For selectSingle, choose exactly one file.',
    '- For selectMultiple, choose all files that are clearly needed, ordered by relevance.',
    '- If uncertain but candidates exist, still choose the best guess.',
    '',
    'Return a JSON object with selectedFileIds, reason, confidence.',
  ].join('\n');
}

export type FileSelectionResult = {
  selectedFileIds: string[];
  selectedFiles: DownloadedSessionFile[];
  selectedRemotePaths: string[];
  reason: string;
  confidence: 'high' | 'medium' | 'low';
};

export function normalizeFileSelectionResult(args: {
  chooserMode: UploadedSessionFileEvent['chooserMode'];
  rawSelection: {
    selectedFileIds?: string[];
    reason?: string;
    confidence?: 'high' | 'medium' | 'low';
  };
  candidates: DownloadedSessionFile[];
}): FileSelectionResult {
  const candidateById = new Map(args.candidates.map((file) => [file.id, file]));
  const validSelections = (args.rawSelection.selectedFileIds ?? [])
    .map((id) => candidateById.get(id))
    .filter((file): file is DownloadedSessionFile => Boolean(file));

  const dedupedSelections = validSelections.filter(
    (file, index, files) => files.findIndex((candidate) => candidate.id === file.id) === index,
  );

  const fallbackSelection =
    dedupedSelections.length > 0 ? dedupedSelections : args.candidates.length > 0 ? [args.candidates[0]] : [];

  const selectedFiles =
    args.chooserMode === 'selectMultiple' ? fallbackSelection : fallbackSelection.slice(0, 1);

  if (selectedFiles.length === 0) {
    throw new Error('No previously downloaded files are available for upload.');
  }

  return {
    selectedFileIds: selectedFiles.map((file) => file.id),
    selectedFiles,
    selectedRemotePaths: selectedFiles.map((file) => file.remotePath),
    reason:
      args.rawSelection.reason?.trim() ||
      'Selected the best matching previously downloaded file for the current upload step.',
    confidence: args.rawSelection.confidence ?? 'low',
  };
}

export async function selectDownloadedFilesForUpload(args: {
  openai: OpenAI;
  model: string;
  chooserMode: UploadedSessionFileEvent['chooserMode'];
  currentStep: StepExecutionContext | null;
  pageUrl?: string | null;
  candidates: DownloadedSessionFile[];
}): Promise<FileSelectionResult> {
  if (args.candidates.length === 0) {
    throw new Error('Upload requested, but no previously downloaded files exist in this session.');
  }

  const response = await args.openai.chat.completions.create({
    model: args.model,
    messages: [
      {
        role: 'system',
        content:
          'You select previously downloaded files for browser uploads. ' +
          'Respond with valid JSON only. Always choose from the provided candidate file ids.',
      },
      {
        role: 'user',
        content: buildFileSelectionPrompt(args),
      },
    ],
    response_format: { type: 'json_object' },
  });

  const content = response.choices[0]?.message?.content ?? '{}';
  const parsed = FILE_SELECTOR_RESPONSE_SCHEMA.parse(JSON.parse(content));
  return normalizeFileSelectionResult({
    chooserMode: args.chooserMode,
    rawSelection: parsed,
    candidates: args.candidates,
  });
}

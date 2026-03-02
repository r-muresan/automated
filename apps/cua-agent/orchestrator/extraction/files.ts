import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import type { DownloadedSessionFile } from '../../types';

const downloadedFileLoopItemsSchema = z.object({
  fileIds: z.array(z.string()).default([]),
});

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '"[unserializable]"';
  }
}

export function buildLoopItemFromDownloadedFile(
  file: DownloadedSessionFile,
): Record<string, unknown> {
  return {
    type: 'downloaded_file',
    fileId: file.id,
    filename: file.filename,
    remotePath: file.remotePath,
    downloadUrl: file.downloadUrl ?? null,
    completedAt: file.completedAt,
    sourceStep: file.sourceStep,
  };
}

export function buildLoopItemsFromDownloadedFilesPrompt(args: {
  description: string;
  downloadedFiles: DownloadedSessionFile[];
}): string {
  const filePayload = args.downloadedFiles.map((file) => ({
    id: file.id,
    filename: file.filename,
    remotePath: file.remotePath,
    downloadUrl: file.downloadUrl ?? null,
    completedAt: file.completedAt,
    sourceStep: file.sourceStep,
  }));

  return [
    'You are selecting previously downloaded session files to use as loop items.',
    `Find all downloaded files that match this loop description: "${args.description}".`,
    '',
    'Only select from the provided file ids.',
    'Use the filename, download URL, source step instruction, source step type, page URL, and loop item metadata to decide which files match.',
    'Return every matching file id in the same order the files are provided, unless the description clearly requires a different order.',
    'If no downloaded files match, return an empty fileIds array.',
    '',
    'Downloaded files:',
    safeJson(filePayload),
    '',
    'Return JSON only in the shape {"fileIds":["..."]}.',
  ].join('\n');
}

export function normalizeDownloadedFileLoopSelection(args: {
  fileIds?: string[];
  downloadedFiles: DownloadedSessionFile[];
}): DownloadedSessionFile[] {
  const filesById = new Map(args.downloadedFiles.map((file) => [file.id, file]));
  const selectedIds = Array.isArray(args.fileIds) ? args.fileIds : [];
  const selectedFiles: DownloadedSessionFile[] = [];
  const seen = new Set<string>();

  for (const fileId of selectedIds) {
    if (typeof fileId !== 'string' || seen.has(fileId)) continue;
    const file = filesById.get(fileId);
    if (!file) continue;
    seen.add(fileId);
    selectedFiles.push(file);
  }

  return selectedFiles;
}

export async function extractLoopItemsFromDownloadedFilesWithLlm(params: {
  llmClient: OpenAI;
  model: string;
  description: string;
  downloadedFiles: DownloadedSessionFile[];
}): Promise<Array<Record<string, unknown>>> {
  const { llmClient, model, description, downloadedFiles } = params;
  if (downloadedFiles.length === 0) {
    return [];
  }

  const response = await llmClient.chat.completions.parse({
    model,
    messages: [
      {
        role: 'user',
        content: buildLoopItemsFromDownloadedFilesPrompt({
          description,
          downloadedFiles,
        }),
      },
    ],
    response_format: zodResponseFormat(
      downloadedFileLoopItemsSchema,
      'downloaded_file_loop_items_response',
    ),
  });

  const parsed = response.choices[0]?.message?.parsed;
  if (!parsed) {
    return [];
  }

  return normalizeDownloadedFileLoopSelection({
    fileIds: parsed.fileIds,
    downloadedFiles,
  }).map((file) => buildLoopItemFromDownloadedFile(file));
}

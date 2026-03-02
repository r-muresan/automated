import test from 'node:test';
import assert from 'node:assert/strict';
import type { DownloadedSessionFile, StepExecutionContext } from '../../types';
import {
  buildLoopItemFromDownloadedFile,
  buildLoopItemsFromDownloadedFilesPrompt,
  normalizeDownloadedFileLoopSelection,
} from './files';

function createStepContext(overrides: Partial<StepExecutionContext> = {}): StepExecutionContext {
  return {
    stepIndex: 2,
    stepType: 'step',
    instruction: 'Download monthly invoice PDF',
    pageUrl: 'https://example.com/files',
    startedAt: '2026-03-02T12:00:00.000Z',
    ...overrides,
  };
}

function createDownloadedFile(
  id: string,
  filename: string,
  overrides: Partial<DownloadedSessionFile> = {},
): DownloadedSessionFile {
  return {
    id,
    guid: `guid-${id}`,
    filename,
    remotePath: `/tmp/downloads/${filename}`,
    completedAt: '2026-03-02T12:05:00.000Z',
    sourceStep: createStepContext(),
    ...overrides,
  };
}

test('buildLoopItemsFromDownloadedFilesPrompt includes loop description and downloaded file metadata', () => {
  const prompt = buildLoopItemsFromDownloadedFilesPrompt({
    description: 'Loop over every downloaded invoice file',
    downloadedFiles: [
      createDownloadedFile('invoice-1', 'invoice-january.pdf', {
        sourceStep: createStepContext({
          instruction: 'Download January invoice',
          loopItemIndex: 3,
        }),
      }),
    ],
  });

  assert.match(prompt, /Loop over every downloaded invoice file/);
  assert.match(prompt, /invoice-january\.pdf/);
  assert.match(prompt, /Download January invoice/);
  assert.match(prompt, /"loopItemIndex": 3/);
});

test('normalizeDownloadedFileLoopSelection keeps valid ids in returned order and drops duplicates', () => {
  const files = [
    createDownloadedFile('invoice', 'invoice.pdf'),
    createDownloadedFile('receipt', 'receipt.pdf'),
  ];

  const result = normalizeDownloadedFileLoopSelection({
    fileIds: ['receipt', 'missing', 'invoice', 'receipt'],
    downloadedFiles: files,
  });

  assert.deepEqual(
    result.map((file) => file.id),
    ['receipt', 'invoice'],
  );
});

test('buildLoopItemFromDownloadedFile returns loop-friendly file metadata', () => {
  const file = createDownloadedFile('invoice', 'invoice.pdf', {
    downloadUrl: 'https://example.com/invoice.pdf',
  });

  const item = buildLoopItemFromDownloadedFile(file);

  assert.deepEqual(item, {
    type: 'downloaded_file',
    fileId: 'invoice',
    filename: 'invoice.pdf',
    remotePath: '/tmp/downloads/invoice.pdf',
    downloadUrl: 'https://example.com/invoice.pdf',
    completedAt: '2026-03-02T12:05:00.000Z',
    sourceStep: file.sourceStep,
  });
});

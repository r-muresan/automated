import test from 'node:test';
import assert from 'node:assert/strict';
import type { DownloadedSessionFile, StepExecutionContext } from '../types';
import {
  buildFileSelectionPrompt,
  buildSessionDownloadedFilesSection,
  normalizeFileSelectionResult,
} from './session-files';

function createStepContext(overrides: Partial<StepExecutionContext> = {}): StepExecutionContext {
  return {
    stepIndex: 3,
    stepType: 'step',
    instruction: 'Upload the invoice PDF',
    pageUrl: 'https://example.com/upload',
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
    sourceStep: createStepContext({
      stepIndex: 1,
      instruction: `Download ${filename}`,
      pageUrl: 'https://example.com/export',
    }),
    ...overrides,
  };
}

test('buildSessionDownloadedFilesSection summarizes the newest downloads', () => {
  const files = [
    createDownloadedFile('file-1', 'report.csv'),
    createDownloadedFile('file-2', 'invoice.pdf', {
      sourceStep: createStepContext({
        stepIndex: 2,
        instruction: 'Download invoice PDF',
        loopItemIndex: 4,
      }),
    }),
  ];

  const section = buildSessionDownloadedFilesSection(files);

  assert.match(section, /## Session Downloaded Files/);
  assert.match(section, /id=file-2; filename=invoice\.pdf/);
  assert.match(section, /loop_item_index=4/);
  assert.ok(section.indexOf('file-2') < section.indexOf('file-1'));
});

test('buildFileSelectionPrompt includes current step and candidate metadata', () => {
  const prompt = buildFileSelectionPrompt({
    chooserMode: 'selectSingle',
    currentStep: createStepContext(),
    pageUrl: 'https://example.com/upload',
    candidates: [createDownloadedFile('file-1', 'invoice.pdf')],
  });

  assert.match(prompt, /Chooser mode: selectSingle/);
  assert.match(prompt, /Current step: stepIndex=3/);
  assert.match(prompt, /invoice\.pdf/);
  assert.match(prompt, /Candidate downloaded files \(newest first\):/);
});

test('normalizeFileSelectionResult falls back to the newest candidate for selectSingle', () => {
  const files = [
    createDownloadedFile('newest', 'invoice.pdf'),
    createDownloadedFile('older', 'report.csv'),
  ];

  const result = normalizeFileSelectionResult({
    chooserMode: 'selectSingle',
    rawSelection: {
      selectedFileIds: ['missing-id'],
      reason: 'Best guess',
      confidence: 'low',
    },
    candidates: files,
  });

  assert.deepEqual(result.selectedFileIds, ['newest']);
  assert.deepEqual(result.selectedRemotePaths, ['/tmp/downloads/invoice.pdf']);
  assert.equal(result.confidence, 'low');
});

test('normalizeFileSelectionResult preserves multiple valid ids for selectMultiple', () => {
  const files = [
    createDownloadedFile('invoice', 'invoice.pdf'),
    createDownloadedFile('receipt', 'receipt.pdf'),
  ];

  const result = normalizeFileSelectionResult({
    chooserMode: 'selectMultiple',
    rawSelection: {
      selectedFileIds: ['receipt', 'invoice', 'receipt'],
      reason: 'Both files are required',
      confidence: 'high',
    },
    candidates: files,
  });

  assert.deepEqual(result.selectedFileIds, ['receipt', 'invoice']);
  assert.deepEqual(result.selectedRemotePaths, [
    '/tmp/downloads/receipt.pdf',
    '/tmp/downloads/invoice.pdf',
  ]);
  assert.equal(result.reason, 'Both files are required');
});

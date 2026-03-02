import test from 'node:test';
import assert from 'node:assert/strict';
import { clickTool } from './click';
import { fillFormVisionTool } from './fillFormVision';
import { typeTool } from './type';
import type { AgentInteractionSyncResult } from '../../types/public/agent';

function createMockPage() {
  return {
    click: async () => '//input',
    type: async () => {},
    waitForTimeout: async () => {},
    screenshot: async () => Buffer.from('image'),
    mainFrame: () => ({
      evaluate: async () => ({ width: 1000, height: 800 }),
    }),
  };
}

function createMockV3(page: ReturnType<typeof createMockPage>) {
  return {
    context: {
      awaitActivePage: async () => page,
    },
    logger: () => {},
    isAgentReplayActive: () => false,
    recordAgentReplayStep: () => {},
    isAdvancedStealth: false,
    configuredViewport: { width: 1000, height: 800 },
  };
}

function createInteractionSync(syncResult: AgentInteractionSyncResult | null) {
  return {
    beginScope: () => ({
      settle: async () => syncResult,
    }),
  };
}

test('click tool includes upload sync metadata in execute result and model output', async () => {
  const page = createMockPage();
  const syncResult: AgentInteractionSyncResult = {
    uploadedFiles: [
      {
        fileId: 'invoice',
        filename: 'invoice.pdf',
        uploadedAs: 'invoice.pdf',
        remotePath: '/tmp/uploads/invoice.pdf',
      },
    ],
    uploadMessage: 'Uploaded invoice.pdf as invoice.pdf.',
  };
  const tool = clickTool(
    createMockV3(page) as any,
    undefined,
    undefined,
    createInteractionSync(syncResult),
  ) as any;

  const result = await tool.execute({
    describe: 'file input',
    coordinates: [120, 240],
  });

  assert.deepEqual(result.uploadedFiles, syncResult.uploadedFiles);
  assert.equal(result.uploadMessage, syncResult.uploadMessage);

  const output = tool.toModelOutput(result);
  const payload = JSON.parse(output.value[0].text);
  assert.deepEqual(payload.uploadedFiles, syncResult.uploadedFiles);
  assert.equal(payload.uploadMessage, syncResult.uploadMessage);
});

test('click tool omits upload sync metadata when no upload occurred', async () => {
  const page = createMockPage();
  const tool = clickTool(
    createMockV3(page) as any,
    undefined,
    undefined,
    createInteractionSync(null),
  ) as any;

  const result = await tool.execute({
    describe: 'plain button',
    coordinates: [120, 240],
  });

  assert.equal(result.uploadedFiles, undefined);
  assert.equal(result.uploadMessage, undefined);
});

test('type tool includes upload sync metadata in execute result', async () => {
  const page = createMockPage();
  const syncResult: AgentInteractionSyncResult = {
    uploadedFiles: [
      {
        fileId: 'invoice',
        filename: 'invoice.pdf',
        uploadedAs: 'invoice.pdf',
        remotePath: '/tmp/uploads/invoice.pdf',
      },
    ],
    uploadMessage: 'Uploaded invoice.pdf as invoice.pdf.',
  };
  const tool = typeTool(
    createMockV3(page) as any,
    undefined,
    undefined,
    undefined,
    createInteractionSync(syncResult),
  ) as any;

  const result = await tool.execute({
    describe: 'file name field',
    text: 'invoice',
    coordinates: [120, 240],
  });

  assert.deepEqual(result.uploadedFiles, syncResult.uploadedFiles);
  assert.equal(result.uploadMessage, syncResult.uploadMessage);
});

test('fillFormVision tool includes upload sync metadata in execute result', async () => {
  const page = createMockPage();
  const syncResult: AgentInteractionSyncResult = {
    uploadedFiles: [
      {
        fileId: 'invoice',
        filename: 'invoice.pdf',
        uploadedAs: 'invoice.pdf',
        remotePath: '/tmp/uploads/invoice.pdf',
      },
    ],
    uploadMessage: 'Uploaded invoice.pdf as invoice.pdf.',
  };
  const tool = fillFormVisionTool(
    createMockV3(page) as any,
    undefined,
    undefined,
    undefined,
    createInteractionSync(syncResult),
  ) as any;

  const result = await tool.execute({
    fields: [
      {
        action: 'type company',
        value: 'ACME',
        coordinates: { x: 120, y: 240 },
      },
      {
        action: 'type contact',
        value: 'alice@example.com',
        coordinates: { x: 180, y: 300 },
      },
    ],
  });

  assert.deepEqual(result.uploadedFiles, syncResult.uploadedFiles);
  assert.equal(result.uploadMessage, syncResult.uploadMessage);
});

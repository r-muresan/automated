/**
 * Test script: Generate a workflow from an interactions log file and save it to the DB.
 *
 * Usage:
 *   npx tsx scripts/test-generate-workflow.ts [path-to-interactions-log.json]
 *
 * If no path is provided, it uses the most recent file in apps/backend/logs/.
 */
import 'dotenv/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PrismaClient } from '../libs/prisma/generated/prisma/client';
import { generateWorkflowFromUserParts } from '../apps/backend/src/app/workflow/workflow-generation.shared';
import type { Step } from '../apps/cua-agent/types';

const USER_ID = 2;

const prisma = new PrismaClient();

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

async function generateUniqueHumanId(title: string): Promise<string> {
  const base = slugify(title);
  let candidate = base;
  let suffix = 1;

  while (true) {
    const existing = await prisma.workflow.findFirst({
      where: { humanId: candidate },
      select: { id: true },
    });
    if (!existing) return candidate;
    suffix++;
    candidate = `${base}-${suffix}`;
  }
}

function buildStepCreateData(
  step: Step,
  meta: {
    workflowId: string;
    parentStepId: string | null;
    branch: 'main' | 'loop' | 'true' | 'false';
    stepNumber: number;
  },
) {
  const base = {
    workflowId: meta.workflowId,
    parentStepId: meta.parentStepId,
    branch: meta.branch,
    stepNumber: meta.stepNumber,
    type: step.type,
    description: null as string | null,
    url: null as string | null,
    dataSchema: null as string | null,
    condition: null as string | null,
  };

  switch (step.type) {
    case 'navigate':
    case 'tab_navigate':
      return { ...base, url: step.url };
    case 'step':
    case 'save':
      return { ...base, description: step.description };
    case 'extract':
      return { ...base, description: step.description, dataSchema: step.dataSchema ?? null };
    case 'loop':
      return { ...base, description: step.description };
    case 'conditional':
      return { ...base, condition: step.condition };
    default:
      return base;
  }
}

async function createWorkflowSteps(
  workflowId: string,
  steps: Step[],
  parentStepId: string | null,
  branch: 'main' | 'loop' | 'true' | 'false',
): Promise<void> {
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    const data = buildStepCreateData(step, {
      workflowId,
      parentStepId,
      branch,
      stepNumber: index + 1,
    });

    const created = await prisma.workflowStep.create({ data });

    if (step.type === 'loop') {
      await createWorkflowSteps(workflowId, step.steps, created.id, 'loop');
    } else if (step.type === 'conditional') {
      await createWorkflowSteps(workflowId, step.trueSteps, created.id, 'true');
      if (step.falseSteps?.length) {
        await createWorkflowSteps(workflowId, step.falseSteps, created.id, 'false');
      }
    }
  }
}

async function findLatestLogFile(): Promise<string> {
  const logsDir = path.join(process.cwd(), 'apps/backend/logs');
  const files = await fs.readdir(logsDir);
  const jsonFiles = files
    .filter((f) => f.startsWith('interactions-') && f.endsWith('.json'))
    .sort()
    .reverse();

  if (jsonFiles.length === 0) {
    throw new Error('No interaction log files found in apps/backend/logs/');
  }
  return path.join(logsDir, jsonFiles[0]);
}

async function main() {
  const logFilePath = process.argv[2] || (await findLatestLogFile());
  console.log(`Reading user parts from: ${logFilePath}`);

  const raw = await fs.readFile(logFilePath, 'utf-8');
  const userParts = JSON.parse(raw);
  console.log(`Loaded ${userParts.length} user parts`);

  console.log('Generating workflow via OpenRouter...');
  const { workflow, rawResponse, usage } = await generateWorkflowFromUserParts({
    userParts,
    modelName: 'google/gemini-3-flash-preview',
  });

  console.log(`Generated workflow: "${workflow.name}" with ${workflow.steps.length} steps`);
  if (usage) {
    console.log(
      `Token usage: ${usage.prompt_tokens} prompt, ${usage.completion_tokens} completion`,
    );
  }

  // Extract starting URL from the first navigate step
  const startingUrl =
    (workflow as any).startingUrl ||
    (workflow.steps[0]?.type === 'navigate' ? workflow.steps[0].url : 'about:blank');

  const title = workflow.name || 'Untitled Workflow';
  const humanId = await generateUniqueHumanId(title);

  const created = await prisma.workflow.create({
    data: {
      humanId,
      title,
      userId: USER_ID,
      startingUrl,
    },
  });

  await createWorkflowSteps(created.id, workflow.steps, null, 'main');

  console.log(`\nWorkflow saved to database!`);
  console.log(`  ID: ${created.id}`);
  console.log(`  Human ID: ${humanId}`);
  console.log(`  Title: ${title}`);
  console.log(`  Starting URL: ${startingUrl}`);
  console.log(`  Steps: ${workflow.steps.length}`);
  console.log(`  User: ${USER_ID}`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('Error:', err);
  await prisma.$disconnect();
  process.exit(1);
});

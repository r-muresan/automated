import { BadRequestException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Step, Workflow } from 'apps/cua-agent';
import { PrismaService } from '../prisma.service';
import type { InteractionPayload, WorkflowDetail } from '@automated/api-dtos';
import { WorkflowGenerationService } from './workflow-generation.service';

@Injectable()
export class WorkflowService {
  constructor(
    private prisma: PrismaService,
    private workflowGeneration: WorkflowGenerationService,
  ) {}

  private async resolveUserId(email: string): Promise<number> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new BadRequestException('User not found');
    }
    return user.id;
  }

  async mergeRecordingFiles(
    files: { video?: Array<{ buffer: Buffer }>; audio?: Array<{ buffer: Buffer }> },
    sessionId?: string,
    audioOffsetMs = 0,
  ) {
    const videoFile = files.video?.[0];
    const audioFile = files.audio?.[0];

    if (!videoFile || !audioFile) {
      throw new BadRequestException('Video and audio files are required');
    }

    const tmpDir = path.join(os.tmpdir(), 'cua-recordings');
    const recordingsDir = path.join(process.cwd(), 'recordings');
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.mkdir(recordingsDir, { recursive: true });

    const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const videoPath = path.join(tmpDir, `${fileId}-video.webm`);
    const audioPath = path.join(tmpDir, `${fileId}-audio.webm`);
    const outputName = sessionId ? `${sessionId}-${fileId}.webm` : `${fileId}.webm`;
    const outputPath = path.join(recordingsDir, outputName);

    try {
      await fs.writeFile(videoPath, videoFile.buffer);
      await fs.writeFile(audioPath, audioFile.buffer);

      // Convert audio offset from ms to seconds for ffmpeg
      const audioOffsetSec = audioOffsetMs / 1000;
      console.log(`[MERGE] Audio offset: ${audioOffsetMs}ms (${audioOffsetSec}s)`);

      await new Promise<void>((resolve, reject) => {
        // Build ffmpeg args - use -ss before audio input to skip the offset
        const ffmpegArgs = [
          '-y',
          '-i',
          videoPath,
          // Skip the first N seconds of audio to sync with video
          ...(audioOffsetSec > 0 ? ['-ss', audioOffsetSec.toString()] : []),
          '-i',
          audioPath,
          '-r',
          '10',
          // Pad dimensions to even numbers (required by most video codecs)
          '-vf',
          'pad=ceil(iw/2)*2:ceil(ih/2)*2',
          '-c:v',
          'libvpx-vp9',
          '-c:a',
          'libopus',
          '-shortest',
          outputPath,
        ];

        console.log(`[MERGE] ffmpeg args:`, ffmpegArgs.join(' '));
        const ffmpeg = spawn('ffmpeg', ffmpegArgs);

        let stderr = '';
        ffmpeg.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        ffmpeg.on('error', (error) => {
          reject(error);
        });

        ffmpeg.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(stderr || `ffmpeg exited with code ${code}`));
          }
        });
      });

      return outputPath;
    } catch (error) {
      console.error('Failed to merge recording:', error);
      throw new InternalServerErrorException('Failed to merge recording');
    } finally {
      await Promise.allSettled([fs.unlink(videoPath), fs.unlink(audioPath)]);
    }
  }

  async generateWorkflowFromInteractions(
    interactions: InteractionPayload[],
    email: string,
    sessionId: string | undefined,
  ) {
    try {
      console.log(`[WORKFLOW] Starting from interactions for session: ${sessionId || 'unknown'}`);
      console.log(`[WORKFLOW] Number of interactions: ${interactions.length}`);

      const { workflow, rawResponse, usage } =
        await this.workflowGeneration.generateWorkflowFromInteractions(interactions);

      if (usage) {
        console.log(`[WORKFLOW] Usage:`, {
          promptTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
        });
      }

      const userId = await this.resolveUserId(email);
      const fallbackStartingUrl = this.getStartingUrlFromInteractions(interactions);
      const workflowId = await this.saveGeneratedWorkflow(
        workflow,
        userId,
        sessionId,
        fallbackStartingUrl,
      );

      console.log(`[WORKFLOW] Saved workflow with ID: ${workflowId}`);
      return { workflowId, workflowData: workflow, rawResponse };
    } catch (error) {
      console.error('Failed to generate workflow from interactions:', error);
      throw new InternalServerErrorException('Failed to generate workflow');
    }
  }

  private getStartingUrlFromInteractions(interactions: InteractionPayload[]): string | undefined {
    const startingUrlInteraction = interactions.find((interaction) => {
      return interaction.data?.type === 'starting_url';
    });
    return startingUrlInteraction?.element?.href || startingUrlInteraction?.data?.url;
  }

  private async saveGeneratedWorkflow(
    workflow: Workflow,
    userId: number,
    sessionId?: string,
    fallbackStartingUrl?: string,
  ): Promise<string> {
    const startingUrl = workflow.startingUrl || fallbackStartingUrl || 'about:blank';
    const title = workflow.name || 'Untitled Workflow';

    return this.prisma.$transaction(async (tx) => {
      const humanId = await this.generateUniqueHumanId(tx, title);
      const created = await tx.workflow.create({
        data: {
          humanId,
          title,
          userId,
          sessionId,
          startingUrl,
          inputs: workflow.inputs ?? [],
        },
      });

      await this.createWorkflowSteps(tx, created.id, workflow.steps, null, 'main');
      return created.id;
    });
  }

  private async createWorkflowSteps(
    prisma: Pick<PrismaService, 'workflowStep'>,
    workflowId: string,
    steps: Step[],
    parentStepId: string | null,
    branch: 'main' | 'loop' | 'true' | 'false',
  ): Promise<void> {
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index];
      const stepNumber = index + 1;

      const data = this.buildStepCreateData(step, {
        workflowId,
        parentStepId,
        branch,
        stepNumber,
      });

      const created = await prisma.workflowStep.create({ data });

      if (step.type === 'loop') {
        await this.createWorkflowSteps(prisma, workflowId, step.steps, created.id, 'loop');
      } else if (step.type === 'conditional') {
        await this.createWorkflowSteps(prisma, workflowId, step.trueSteps, created.id, 'true');
        if (step.falseSteps?.length) {
          await this.createWorkflowSteps(prisma, workflowId, step.falseSteps, created.id, 'false');
        }
      }
    }
  }

  private buildStepCreateData(
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
        return {
          ...base,
          url: step.url,
        };
      case 'step':
        return {
          ...base,
          description: step.description,
        };
      case 'save':
        return {
          ...base,
          description: step.description,
        };
      case 'extract':
        return {
          ...base,
          description: step.description,
          dataSchema: step.dataSchema ?? null,
        };
      case 'loop':
        return {
          ...base,
          description: step.description,
        };
      case 'conditional':
        return {
          ...base,
          condition: step.condition,
        };
      default:
        return base;
    }
  }

  private getDisplayDescription(step: {
    type: string;
    description: string | null;
    url: string | null;
    dataSchema: string | null;
    condition: string | null;
  }): string {
    if (step.description && step.description.trim().length > 0) {
      return step.description;
    }

    switch (step.type) {
      case 'navigate':
        return step.url ? `Navigate to ${step.url}` : 'Navigate to a URL';
      case 'tab_navigate':
        return step.url ? `Open ${step.url} in a new tab` : 'Open a new tab';
      case 'extract':
        return step.dataSchema ? `Extract data (${step.dataSchema})` : 'Extract data from the page';
      case 'loop':
        return 'Loop over items';
      case 'conditional':
        return step.condition ? `If ${step.condition}` : 'Conditional step';
      case 'save':
        return 'Save current state';
      default:
        return 'Step';
    }
  }

  private normalizeIncomingSteps(steps: any[] | undefined): Step[] | undefined {
    if (!steps) return undefined;
    if (steps.length === 0) return [];

    const hasType = typeof steps[0]?.type === 'string';
    const normalized = hasType
      ? (steps as Step[])
      : [...steps]
          .sort((a, b) => (a.stepNumber ?? 0) - (b.stepNumber ?? 0))
          .map((step) => ({
            type: 'step' as const,
            description: step.description ?? '',
          }));

    return normalized.map((step) => this.ensureStepDefaults(step));
  }

  private ensureStepDefaults(step: Step): Step {
    if (step.type === 'loop') {
      return {
        ...step,
        description:
          step.description ??
          this.getDisplayDescription({
            type: 'loop',
            description: step.description ?? null,
            url: null,
            dataSchema: null,
            condition: null,
          }),
        steps: (step.steps ?? []).map((child) => this.ensureStepDefaults(child)),
      };
    }

    if (step.type === 'conditional') {
      return {
        ...step,
        condition: step.condition ?? '',
        trueSteps: (step.trueSteps ?? []).map((child) => this.ensureStepDefaults(child)),
        falseSteps: (step.falseSteps ?? []).map((child) => this.ensureStepDefaults(child)),
      };
    }

    if (step.type === 'navigate' || step.type === 'tab_navigate') {
      return {
        ...step,
        url: step.url ?? '',
      };
    }

    if (step.type === 'extract') {
      return {
        ...step,
        description: step.description ?? '',
        dataSchema: step.dataSchema ?? undefined,
      };
    }

    if (step.type === 'save') {
      return {
        ...step,
        description: step.description ?? '',
      };
    }

    return {
      ...step,
      description: step.description ?? '',
    };
  }

  private buildApiStepTree(
    steps: Array<{
      id: string;
      parentStepId: string | null;
      branch: 'main' | 'loop' | 'true' | 'false';
      stepNumber: number;
      type: string;
      description: string | null;
      url: string | null;
      dataSchema: string | null;
      condition: string | null;
    }>,
  ): Step[] {
    const grouped = new Map<string | null, Array<(typeof steps)[number]>>();

    for (const step of steps) {
      const key = step.parentStepId ?? null;
      const list = grouped.get(key) ?? [];
      list.push(step);
      grouped.set(key, list);
    }

    const buildBranch = (
      parentStepId: string | null,
      branch: 'main' | 'loop' | 'true' | 'false',
    ): Step[] => {
      const branchSteps =
        grouped.get(parentStepId ?? null)?.filter((step) => step.branch === branch) ?? [];

      branchSteps.sort((a, b) => a.stepNumber - b.stepNumber);

      return branchSteps.map((step) => this.mapDbStepToApiStep(step, buildBranch));
    };

    return buildBranch(null, 'main');
  }

  private mapDbStepToApiStep(
    step: {
      id: string;
      type: string;
      description: string | null;
      url: string | null;
      dataSchema: string | null;
      condition: string | null;
    },
    buildBranch: (parentStepId: string, branch: 'main' | 'loop' | 'true' | 'false') => Step[],
  ): Step {
    switch (step.type) {
      case 'navigate':
        return { type: 'navigate', url: step.url ?? '' };
      case 'tab_navigate':
        return { type: 'tab_navigate', url: step.url ?? '' };
      case 'save':
        return { type: 'save', description: step.description ?? '' };
      case 'extract':
        return {
          type: 'extract',
          description: step.description ?? '',
          dataSchema: step.dataSchema ?? undefined,
        };
      case 'loop':
        return {
          type: 'loop',
          description: step.description ?? '',
          steps: buildBranch(step.id, 'loop'),
        };
      case 'conditional': {
        const trueSteps = buildBranch(step.id, 'true');
        const falseSteps = buildBranch(step.id, 'false');
        return {
          type: 'conditional',
          condition: step.condition ?? '',
          trueSteps,
          falseSteps: falseSteps.length > 0 ? falseSteps : [],
        };
      }
      case 'step':
      default:
        return { type: 'step', description: step.description ?? '' };
    }
  }

  private slugifyTitle(title: string): string {
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .trim();
    return slug.length > 0 ? slug : 'workflow';
  }

  private async generateUniqueHumanId(
    prisma: Pick<PrismaService, 'workflow'>,
    title: string,
    excludeId?: string,
  ): Promise<string> {
    const base = this.slugifyTitle(title);
    let candidate = base;
    let suffix = 1;

    while (true) {
      const existing = await prisma.workflow.findFirst({
        where: {
          humanId: candidate,
          ...(excludeId ? { id: { not: excludeId } } : {}),
        },
        select: { id: true },
      });

      if (!existing) {
        return candidate;
      }

      suffix += 1;
      candidate = `${base}-${suffix}`;
    }
  }

  async createWorkflow(data: { title: string; steps?: any[]; email: string }) {
    const normalizedSteps = this.normalizeIncomingSteps(data.steps);
    const userId = await this.resolveUserId(data.email);

    return this.prisma.$transaction(async (tx) => {
      const humanId = await this.generateUniqueHumanId(tx, data.title);
      const workflow = await tx.workflow.create({
        data: {
          humanId,
          title: data.title,
          userId,
        },
      });

      if (normalizedSteps && normalizedSteps.length > 0) {
        await this.createWorkflowSteps(tx, workflow.id, normalizedSteps, null, 'main');
      }

      return tx.workflow.findUnique({
        where: { id: workflow.id },
        include: {
          steps: {
            where: { parentStepId: null, branch: 'main' },
            orderBy: { stepNumber: 'asc' },
          },
        },
      });
    });
  }

  async getWorkflow(id: string): Promise<WorkflowDetail | null> {
    console.log(`[SERVICE] Querying database for workflow ID: ${id}`);
    const workflow = await this.prisma.workflow.findUnique({
      where: { id },
      include: {
        steps: {
          orderBy: { stepNumber: 'asc' },
        },
      },
    });
    console.log(`[SERVICE] Database result for ${id}: ${workflow ? 'FOUND' : 'NOT FOUND'}`);
    if (!workflow) return null;
    return {
      ...workflow,
      steps: this.buildApiStepTree(workflow.steps),
    };
  }

  async getWorkflowIdentityForUser(id: string, email: string) {
    return this.prisma.workflow.findFirst({
      where: { id, user: { email } },
      select: {
        id: true,
        humanId: true,
      },
    });
  }

  async updateWorkflow(
    id: string,
    data: {
      title?: string;
      steps?: any[];
    },
  ) {
    const normalizedSteps = this.normalizeIncomingSteps(data.steps);

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.workflow.findUnique({
        where: { id },
        select: { title: true },
      });

      const shouldUpdateHumanId =
        !!data.title && data.title.trim().length > 0 && data.title !== existing?.title;

      if (data.steps) {
        await tx.workflowStep.deleteMany({
          where: { workflowId: id },
        });
      }

      const humanId = shouldUpdateHumanId
        ? await this.generateUniqueHumanId(tx, data.title!, id)
        : undefined;

      const workflow = await tx.workflow.update({
        where: { id },
        data: {
          ...(data.title && { title: data.title }),
          ...(humanId && { humanId }),
        },
      });

      if (data.steps && normalizedSteps && normalizedSteps.length > 0) {
        await this.createWorkflowSteps(tx, workflow.id, normalizedSteps, null, 'main');
      }

      return tx.workflow.findUnique({
        where: { id: workflow.id },
        include: {
          steps: {
            where: { parentStepId: null, branch: 'main' },
            orderBy: { stepNumber: 'asc' },
          },
        },
      });
    });
  }

  async getUserWorkflows(email: string) {
    const workflows = await this.prisma.workflow.findMany({
      where: { user: { email } },
      include: {
        steps: {
          where: { parentStepId: null, branch: 'main' },
          orderBy: { stepNumber: 'asc' },
        },
        schedule: {
          select: { id: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
    return workflows.map((workflow) => ({
      ...workflow,
      hasSchedule: Boolean(workflow.schedule),
      steps: workflow.steps.map((step) => ({
        ...step,
        description: this.getDisplayDescription(step),
      })),
    }));
  }

  async deleteWorkflow(id: string) {
    // Steps will be deleted automatically if onUpdate: Cascade / onDelete: Cascade is set in Prisma,
    // otherwise we delete them manually first.
    await this.prisma.workflowStep.deleteMany({
      where: { workflowId: id },
    });

    return this.prisma.workflow.delete({
      where: { id },
    });
  }

  async getDeepgramToken() {
    const masterKey = process.env.DEEPGRAM_API_KEY;
    if (!masterKey) {
      throw new InternalServerErrorException('Missing DEEPGRAM_API_KEY');
    }

    try {
      // Generate a short-lived (60s) scoped token for the frontend
      const response = await fetch(
        'https://api.deepgram.com/v1/projects/bb939b19-d30d-44e2-9c39-b4ebec1285ed/keys',
        {
          method: 'POST',
          headers: {
            Authorization: `Token ${masterKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            comment: 'Temporary frontend streaming token',
            scopes: ['usage:write'],
            time_to_live_in_seconds: 60 * 10,
          }),
        },
      );

      if (!response.ok) {
        const error = await response.text();
        console.error('[DEEPGRAM] Failed to generate temp key:', error);
        throw new Error('Failed to generate Deepgram token');
      }

      const data = await response.json();
      return { key: data.key };
    } catch (error) {
      console.error('[DEEPGRAM] Token generation error:', error);
      throw new InternalServerErrorException('Could not generate transcription token');
    }
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Sse,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { map } from 'rxjs/operators';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard';
import { ClerkAuthQueryGuard } from '../auth/clerk-auth-query.guard';
import { GetUser } from '../auth/get-user.decorator';
import { WorkflowService } from './workflow.service';
import { WorkflowExecutionService } from './workflow-execution.service';
import { WorkflowScheduleService } from './workflow-schedule.service';
import type {
  CreateWorkflowRequest,
  GenerateWorkflowFromInteractionsRequest,
  GenerateWorkflowFromInteractionsResponse,
  UpsertWorkflowScheduleRequest,
  UpdateWorkflowRequest,
  WorkflowAction,
  WorkflowDetail,
  WorkflowExecutionCommandResponse,
  WorkflowExecutionState,
  WorkflowExecutionStatusesResponse,
  WorkflowEntity,
  WorkflowLogEntry,
  WorkflowRecordWithSteps,
  WorkflowScheduleResponse,
  WorkflowTriggerEmailResponse,
  WorkflowRunsResponse,
  WorkflowRunOutputResponse,
} from '@automated/api-dtos';

@Controller('workflows')
export class WorkflowController {
  constructor(
    private readonly configService: ConfigService,
    private readonly workflowService: WorkflowService,
    private readonly workflowExecutionService: WorkflowExecutionService,
    private readonly workflowScheduleService: WorkflowScheduleService,
  ) {}

  // @Post('generate')
  // @UseGuards(ClerkAuthGuard)
  // @UseInterceptors(
  //   FileFieldsInterceptor([
  //     { name: 'video', maxCount: 1 },
  //     { name: 'audio', maxCount: 1 },
  //   ]),
  // )
  // async generateWorkflow(
  //   @UploadedFiles()
  //   files: { video?: Array<{ buffer: Buffer }>; audio?: Array<{ buffer: Buffer }> },
  //   @Body('sessionId') sessionId: string | undefined,
  //   @Body('audioOffsetMs') audioOffsetMs: string | undefined,
  // ) {
  //   const offset = audioOffsetMs ? parseInt(audioOffsetMs, 10) : 0;
  //   return this.workflowService.generateWorkflow(files, sessionId, offset);
  // }

  @Post('generate-from-interactions')
  @UseGuards(ClerkAuthGuard)
  async generateWorkflowFromInteractions(
    @GetUser() user: any,
    @Body()
    body: GenerateWorkflowFromInteractionsRequest,
  ): Promise<GenerateWorkflowFromInteractionsResponse> {
    const email = user?.email;
    return this.workflowService.generateWorkflowFromInteractions(
      body.interactions,
      email,
      body.sessionId,
    );
  }

  @Post('speech/deepgram-token')
  @UseGuards(ClerkAuthGuard)
  async getDeepgramToken() {
    return this.workflowService.getDeepgramToken();
  }

  @Post()
  @UseGuards(ClerkAuthGuard)
  async createWorkflow(
    @GetUser() user: any,
    @Body()
    data: CreateWorkflowRequest,
  ): Promise<WorkflowRecordWithSteps | null> {
    const email = user?.email;
    return this.workflowService.createWorkflow({ ...data, email });
  }

  @Get('runs')
  @UseGuards(ClerkAuthGuard)
  async getLatestWorkflowRuns(@GetUser() user: any): Promise<WorkflowRunsResponse> {
    const email = user?.email;
    if (!email) {
      throw new Error('User not authenticated');
    }
    return this.workflowExecutionService.getLatestRunsForUser(email);
  }

  @Get(':id')
  @UseGuards(ClerkAuthGuard)
  async getWorkflow(@Param('id') id: string): Promise<WorkflowDetail> {
    console.log(`[CONTROLLER] Fetching workflow with ID: ${id}`);
    const workflow = await this.workflowService.getWorkflow(id);
    if (!workflow) {
      console.log(`[CONTROLLER] Workflow NOT FOUND: ${id}`);
      throw new NotFoundException('Workflow not found');
    }
    console.log(`[CONTROLLER] Workflow found: ${workflow.title}`);
    return workflow;
  }

  @Get(':id/trigger-email')
  @UseGuards(ClerkAuthGuard)
  async getTriggerEmail(
    @Param('id') id: string,
    @GetUser() user: any,
  ): Promise<WorkflowTriggerEmailResponse> {
    const email = user?.email;
    if (!email) {
      throw new BadRequestException('User not authenticated');
    }

    const workflow = await this.workflowService.getWorkflowIdentityForUser(id, email);
    if (!workflow) {
      throw new NotFoundException('Workflow not found');
    }

    const inboundDomain = this.configService.get<string>('RESEND_INBOUND_DOMAIN')?.trim();
    if (!inboundDomain) {
      throw new InternalServerErrorException('Missing RESEND_INBOUND_DOMAIN');
    }

    return {
      workflowId: workflow.id,
      humanId: workflow.humanId,
      email: `${workflow.humanId}@${inboundDomain}`,
    };
  }

  @Get(':id/schedule')
  @UseGuards(ClerkAuthGuard)
  async getSchedule(
    @Param('id') id: string,
    @GetUser() user: any,
  ): Promise<WorkflowScheduleResponse | null> {
    const email = user?.email;
    if (!email) {
      throw new BadRequestException('User not authenticated');
    }

    return this.workflowScheduleService.getSchedule(id, email);
  }

  @Put(':id/schedule')
  @UseGuards(ClerkAuthGuard)
  async upsertSchedule(
    @Param('id') id: string,
    @GetUser() user: any,
    @Body() body: UpsertWorkflowScheduleRequest,
  ): Promise<WorkflowScheduleResponse> {
    const email = user?.email;
    if (!email) {
      throw new BadRequestException('User not authenticated');
    }

    return this.workflowScheduleService.upsertSchedule(id, email, body);
  }

  @Delete(':id/schedule')
  @UseGuards(ClerkAuthGuard)
  async deleteSchedule(
    @Param('id') id: string,
    @GetUser() user: any,
  ): Promise<WorkflowExecutionCommandResponse> {
    const email = user?.email;
    if (!email) {
      throw new BadRequestException('User not authenticated');
    }

    return this.workflowScheduleService.deleteSchedule(id, email);
  }

  @Put(':id')
  @UseGuards(ClerkAuthGuard)
  async updateWorkflow(
    @Param('id') id: string,
    @Body()
    data: UpdateWorkflowRequest,
  ): Promise<WorkflowRecordWithSteps | null> {
    return this.workflowService.updateWorkflow(id, data);
  }

  @Delete(':id')
  @UseGuards(ClerkAuthGuard)
  async deleteWorkflow(@Param('id') id: string): Promise<WorkflowEntity> {
    return this.workflowService.deleteWorkflow(id);
  }

  @Get()
  @UseGuards(ClerkAuthGuard)
  async getUserWorkflows(@GetUser() user: any): Promise<WorkflowRecordWithSteps[]> {
    const email = user?.email;
    if (!email) {
      throw new Error('User not authenticated');
    }
    return this.workflowService.getUserWorkflows(email);
  }

  @Get('execution/statuses')
  @UseGuards(ClerkAuthGuard)
  async getAllExecutionStatuses(): Promise<WorkflowExecutionStatusesResponse> {
    return this.workflowExecutionService.getAllStatuses();
  }

  @Get(':id/execution/status')
  @UseGuards(ClerkAuthGuard)
  async getExecutionStatus(@Param('id') id: string): Promise<WorkflowExecutionState> {
    return this.workflowExecutionService.getStatus(id);
  }

  @Get(':id/execution/logs')
  @UseGuards(ClerkAuthGuard)
  async getExecutionLogs(@Param('id') id: string): Promise<WorkflowLogEntry[]> {
    return this.workflowExecutionService.getLogs(id);
  }

  @Get(':id/execution/actions')
  @UseGuards(ClerkAuthGuard)
  async getExecutionActions(
    @Param('id') id: string,
    @Query('runId') runId: string,
  ): Promise<WorkflowAction[]> {
    if (!runId) {
      throw new BadRequestException('runId is required');
    }
    return this.workflowExecutionService.getActionLogs(id, runId);
  }

  @Get(':id/runs/:runId/output')
  @UseGuards(ClerkAuthGuard)
  async getRunOutput(
    @Param('id') id: string,
    @Param('runId') runId: string,
  ): Promise<WorkflowRunOutputResponse> {
    return this.workflowExecutionService.getRunOutput(id, runId);
  }

  @Sse(':id/execution/actions/stream')
  @UseGuards(ClerkAuthQueryGuard)
  async streamExecutionActions(
    @Param('id') id: string,
    @Query('runId') runId: string,
    @Query('since') since?: string,
  ) {
    if (!runId) {
      throw new BadRequestException('runId is required');
    }
    const sinceDate = since ? new Date(since) : undefined;
    if (since && Number.isNaN(sinceDate?.getTime() ?? NaN)) {
      throw new BadRequestException('Invalid since timestamp');
    }

    const stream = await this.workflowExecutionService.getActionStream(id, runId, sinceDate);
    return stream.pipe(map((log) => ({ data: log })));
  }

  @Post(':id/execution/start')
  @UseGuards(ClerkAuthGuard)
  async startExecution(
    @Param('id') id: string,
    @GetUser() user: any,
    @Body() body?: { inputValues?: Record<string, string> },
  ): Promise<WorkflowExecutionCommandResponse> {
    const email = user?.email;
    return this.workflowExecutionService.startWorkflow(id, email, body?.inputValues);
  }

  @Post(':id/execution/stop')
  @UseGuards(ClerkAuthGuard)
  async stopExecution(@Param('id') id: string): Promise<WorkflowExecutionCommandResponse> {
    return this.workflowExecutionService.stopWorkflow(id);
  }

  @Post(':id/execution/continue')
  @UseGuards(ClerkAuthGuard)
  async continueExecution(
    @Param('id') id: string,
    @Body() body: { runId: string; requestId?: string },
  ): Promise<WorkflowExecutionCommandResponse> {
    if (!body?.runId) {
      throw new BadRequestException('runId is required');
    }
    return this.workflowExecutionService.continueWorkflow(id, body.runId, body.requestId);
  }
}

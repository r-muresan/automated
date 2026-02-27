import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { BrowserSessionService } from './browser-session.service';
import { PrismaService } from '../prisma.service';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard';
import { GetUser } from '../auth/get-user.decorator';
import { FileInterceptor } from '@nestjs/platform-express';
import type {
  BrowserSessionCreateRequest,
  BrowserSessionCreateResponse,
  BrowserSessionDebugResponse,
  BrowserSessionPingResponse,
  BrowserSessionRecordingResponse,
  BrowserSessionStopResponse,
  BrowserSessionUploadResponse,
} from '@automated/api-dtos';

@Controller('browser-session')
export class BrowserSessionController {
  constructor(
    private readonly browserSessionService: BrowserSessionService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('usage')
  @UseGuards(ClerkAuthGuard)
  async getBrowserUsage(@GetUser() user: any) {
    const email = user?.email;
    const dbUser = email ? await this.prisma.user.findUnique({ where: { email } }) : null;
    const minutesUsed = dbUser?.browserMinutesUsed ?? 0;
    const isUsingManagedBrowser = !!process.env.HYPERBROWSER_API_KEY;
    const minutesCap = isUsingManagedBrowser ? 60 : Infinity;
    return {
      minutesUsed: Math.round(minutesUsed * 100) / 100,
      minutesCap,
      minutesRemaining: isUsingManagedBrowser
        ? Math.max(0, Math.round((60 - minutesUsed) * 100) / 100)
        : Infinity,
    };
  }

  @Post()
  @UseGuards(ClerkAuthGuard)
  async createBrowserSession(
    @GetUser() user: any,
    @Body() body: BrowserSessionCreateRequest,
    @Headers('user-agent') userAgent?: string,
  ): Promise<BrowserSessionCreateResponse> {
    const userId = user?.email;
    const { colorScheme, width, height, reuseExisting = true, timezone } = body;

    const session = await this.browserSessionService.createSession(
      userId,
      colorScheme,
      width,
      height,
      reuseExisting,
      userAgent,
      timezone,
    );
    return {
      sessionId: session.id,
      pages: session.pages,
      cdpWsUrlTemplate: session.cdpWsUrlTemplate,
      liveViewUrl: session.liveViewUrl,
    };
  }

  @Get(':sessionId/debug')
  @UseGuards(ClerkAuthGuard)
  async getBrowserSessionDebug(
    @Param('sessionId') sessionId: string,
  ): Promise<BrowserSessionDebugResponse> {
    const debugInfo = await this.browserSessionService.getDebugUrl(sessionId);
    return {
      ...debugInfo,
      pages: debugInfo.pages || [],
      cdpWsUrlTemplate: debugInfo.cdpWsUrlTemplate,
      liveViewUrl: debugInfo.liveViewUrl,
    };
  }

  @Post(':sessionId/ping')
  @UseGuards(ClerkAuthGuard)
  async pingSession(@Param('sessionId') sessionId: string): Promise<BrowserSessionPingResponse> {
    await this.browserSessionService.updateLastUsed(sessionId);
    return { success: true };
  }

  @Post(':sessionId/recording/start')
  @UseGuards(ClerkAuthGuard)
  async startRecordingKeepalive(
    @Param('sessionId') sessionId: string,
  ): Promise<BrowserSessionRecordingResponse> {
    console.log(`[CONTROLLER] Starting recording keepalive for session: ${sessionId}`);
    return this.browserSessionService.startRecordingKeepalive(sessionId);
  }

  @Post(':sessionId/recording/stop')
  @UseGuards(ClerkAuthGuard)
  async stopRecordingKeepalive(
    @Param('sessionId') sessionId: string,
  ): Promise<BrowserSessionRecordingResponse> {
    console.log(`[CONTROLLER] Stopping recording keepalive for session: ${sessionId}`);
    return this.browserSessionService.stopRecordingKeepalive(sessionId);
  }

  @Post(':sessionId/upload')
  @UseGuards(ClerkAuthGuard)
  @UseInterceptors(FileInterceptor('file'))
  async uploadSessionFile(
    @Param('sessionId') sessionId: string,
    @UploadedFile() file: { buffer: Buffer; originalname: string; mimetype?: string; size?: number },
  ): Promise<BrowserSessionUploadResponse> {
    return this.browserSessionService.uploadSessionFile(sessionId, file);
  }

  @Post(':sessionId/stop')
  @UseGuards(ClerkAuthGuard)
  async stopSessionWithRecording(
    @Param('sessionId') sessionId: string,
  ): Promise<BrowserSessionStopResponse> {
    console.log(`[CONTROLLER] Stopping session: ${sessionId}`);
    await this.browserSessionService.stopRecordingKeepalive(sessionId);
    await this.browserSessionService.stopSession(sessionId);
    return { success: true };
  }

  @Delete(':sessionId')
  @UseGuards(ClerkAuthGuard)
  async stopSession(@Param('sessionId') sessionId: string): Promise<BrowserSessionStopResponse> {
    await this.browserSessionService.stopSession(sessionId);
    return { success: true };
  }
}

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaService } from './prisma.service';
import { BrowserProvider } from './browser/browser-provider.interface';
import { HyperbrowserBrowserProvider } from './browser/hyperbrowser-browser.provider';
import { LocalBrowserProvider } from './browser/local-browser.provider';
import { BrowserSessionService } from './browser-session/browser-session.service';
import { BrowserSessionController } from './browser-session/browser-session.controller';
import { LocalStorageService } from './storage/local-storage.service';
import { WorkflowController } from './workflow/workflow.controller';
import { WorkflowService } from './workflow/workflow.service';
import { WorkflowExecutionService } from './workflow/workflow-execution.service';
import { WorkflowGenerationService } from './workflow/workflow-generation.service';
import { WorkflowScheduleService } from './workflow/workflow-schedule.service';
import { ResendWebhookController } from './email/resend-webhook.controller';
import { ResendEmailService } from './email/resend-email.service';
import { ResendWebhookService } from './email/resend-webhook.service';
import { SettingsController } from './settings/settings.controller';
import { SettingsService } from './settings/settings.service';

const BrowserProviderFactory = {
  provide: BrowserProvider,
  useFactory: (storage: LocalStorageService) => {
    if (process.env.HYPERBROWSER_API_KEY) {
      return new HyperbrowserBrowserProvider();
    }
    return new LocalBrowserProvider(storage);
  },
  inject: [LocalStorageService],
};

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
  ],
  controllers: [
    AppController,
    BrowserSessionController,
    WorkflowController,
    ResendWebhookController,
    SettingsController,
  ],
  providers: [
    AppService,
    PrismaService,
    LocalStorageService,
    BrowserProviderFactory,
    BrowserSessionService,
    WorkflowService,
    WorkflowExecutionService,
    WorkflowGenerationService,
    WorkflowScheduleService,
    ResendEmailService,
    ResendWebhookService,
    SettingsService,
  ],
})
export class AppModule {}

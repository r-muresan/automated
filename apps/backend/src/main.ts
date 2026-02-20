/**
 * This is not a production server yet!
 * This is only a minimal backend to get started.
 */

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { SettingsService } from './app/settings/settings.service';

async function bootstrap() {
  // Load persisted settings (e.g. OPENROUTER_API_KEY) into process.env before NestJS init
  SettingsService.loadSettingsToEnv();

  const app = await NestFactory.create(AppModule, {
    bodyParser: true,
  });

  app.enableShutdownHooks();

  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.use(
    require('express').json({
      limit: '50mb',
      verify: (req: any, _res: any, buf: Buffer) => {
        if (buf?.length) {
          req.rawBody = buf.toString('utf8');
        }
      },
    }),
  );
  expressApp.use(require('express').urlencoded({ limit: '50mb', extended: true }));

  const defaultCorsOrigins = ['http://localhost:3000', 'https://app.useautomated.com'];
  const configuredCorsOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const allowedCorsOrigins =
    configuredCorsOrigins.length > 0 ? configuredCorsOrigins : defaultCorsOrigins;

  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void,
    ) => {
      // Allow non-browser and same-origin requests that do not send Origin.
      if (!origin || allowedCorsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`CORS blocked for origin: ${origin}`), false);
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
    allowedHeaders: 'Content-Type, Authorization, x-anonymous-id, x-admin-impersonation',
  });
  const globalPrefix = 'api';
  app.setGlobalPrefix(globalPrefix);
  const port = process.env.PORT || 8080;
  await app.listen(port);
  Logger.log(`🚀 Application is running on: http://localhost:${port}/${globalPrefix}`);
}

bootstrap();

import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import type { AppConfig } from './config/app-config.js';
import { ErrorFilter } from './http/error.filter.js';
import { createValidationPipe } from './http/validation.js';

export async function createApp(config: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(config));
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new ErrorFilter());
  app.enableShutdownHooks();
  return app;
}

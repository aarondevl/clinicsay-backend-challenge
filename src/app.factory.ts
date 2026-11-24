import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import type { AppConfig } from './config/app-config.js';
import { ErrorFilter } from './http/error.filter.js';
import { createValidationPipe } from './http/validation.js';

/**
 * Crea la app con sus pipes, el filtro de errores y los shutdown hooks, y
 * ejecuta las migraciones pendientes antes de devolverla (antes de abrir el
 * puerto). Si las migraciones fallan, cierra la app y relanza el error.
 */
export async function createApp(config: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(config));
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new ErrorFilter());
  app.enableShutdownHooks();
  try {
    await app.get(MikroORM).migrator.up();
  } catch (error) {
    await app.close();
    throw error;
  }
  return app;
}

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { AppConfig } from '../../src/config/app-config.js';
import { createApp } from '../../src/app.factory.js';

export const TEST_PROVIDER_PORT = 4011;

export interface TestApp {
  http: ReturnType<typeof request>;
  app: INestApplication;
  setClock(iso: string): Promise<void>;
  close(): Promise<void>;
}

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    databaseUrl:
      process.env.TEST_DATABASE_URL ??
      'postgres://clinicsay:clinicsay@localhost:5432/clinicsay_test',
    providerUrl: `http://localhost:${TEST_PROVIDER_PORT}`,
    clockMode: 'test',
    providerTimeoutMs: 5000,
    ...overrides,
  };
}

export async function startTestApp(
  overrides: Partial<AppConfig> = {},
): Promise<TestApp> {
  const app = await createApp(testConfig(overrides));
  await app.init();
  const http = request(app.getHttpServer());
  return {
    http,
    app,
    async setClock(iso: string) {
      await http.put('/test/clock').send({ now: iso }).expect(204);
    },
    close: () => app.close(),
  };
}

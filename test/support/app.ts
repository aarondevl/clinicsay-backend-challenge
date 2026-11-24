import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { AppConfig } from '../../src/config/app-config.js';
import { createApp } from '../../src/app.factory.js';
import { createProviderAdmin, type ProviderAdmin } from './provider-admin.js';

export const TEST_PROVIDER_PORT = 4011;

export interface TestApp {
  http: ReturnType<typeof request>;
  app: INestApplication;
  orm: MikroORM;
  /** Administración del proveedor de test (puerto 4011), aunque la app apunte a otro. */
  provider: ProviderAdmin;
  setClock(iso: string): Promise<void>;
  /** Vacía todas las tablas y olvida mensajes, peticiones y reglas del proveedor. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** Configuración de la app en los e2e: base `clinicsay_test` y proveedor en 4011. */
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

/** Arranca la app real (con migraciones) sin abrir puerto y devuelve sus manejadores. */
export async function startTestApp(
  overrides: Partial<AppConfig> = {},
): Promise<TestApp> {
  const app = await createApp(testConfig(overrides));
  await app.init();
  const http = request(app.getHttpServer());
  const orm = app.get<MikroORM>(MikroORM);
  const provider = createProviderAdmin(testConfig().providerUrl);
  return {
    http,
    app,
    orm,
    provider,
    async setClock(iso: string) {
      await http.put('/test/clock').send({ now: iso }).expect(204);
    },
    async reset() {
      const tables = [...orm.getMetadata().getAll().values()].map(
        (meta) => `"${meta.tableName}"`,
      );
      await orm.em
        .getConnection()
        .execute(`truncate table ${tables.join(', ')} cascade`);
      await provider.reset();
    },
    close: () => app.close(),
  };
}

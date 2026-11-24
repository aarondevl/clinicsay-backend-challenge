import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { MikroORM } from '@mikro-orm/postgresql';
import { TEST_PROVIDER_PORT, testConfig } from './app.js';

const PROVIDER_SCRIPT = resolve(
  import.meta.dirname,
  '../../provider/server.mjs',
);
const PROVIDER_URL = `http://localhost:${TEST_PROVIDER_PORT}`;

async function providerIsUp(): Promise<boolean> {
  try {
    const res = await fetch(`${PROVIDER_URL}/health`);
    return res.ok;
  } catch {
    // Sin respuesta todavía: el proveedor no ha abierto el puerto.
    return false;
  }
}

/** Crea `clinicsay_test` si no existe; MikroORM conecta a `postgres` para ello. */
async function ensureTestDatabase(): Promise<void> {
  const orm = await MikroORM.init({
    clientUrl: testConfig().databaseUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
  });
  try {
    await orm.schema.ensureDatabase();
  } finally {
    await orm.close(true);
  }
}

/** Lanza `provider/server.mjs` en el puerto de test y espera a su `/health`. */
async function startProvider(): Promise<ChildProcess> {
  if (await providerIsUp()) {
    throw new Error(
      `El puerto ${TEST_PROVIDER_PORT} ya tiene un proveedor: los e2e necesitan el suyo propio.`,
    );
  }
  const child = spawn(process.execPath, [PROVIDER_SCRIPT], {
    env: { ...process.env, PORT: String(TEST_PROVIDER_PORT) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) {
      throw new Error(
        `El proveedor de test terminó con código ${child.exitCode}`,
      );
    }
    if (await providerIsUp()) return child;
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill();
  throw new Error('El proveedor de test no respondió a /health en 5 s');
}

/** `globalSetup` de los e2e: base de test y proveedor propio en el puerto 4011. */
export async function setup(): Promise<() => Promise<void>> {
  await ensureTestDatabase();
  const provider = await startProvider();
  return async () => {
    if (provider.exitCode === null) {
      provider.kill();
      await once(provider, 'exit');
    }
  };
}

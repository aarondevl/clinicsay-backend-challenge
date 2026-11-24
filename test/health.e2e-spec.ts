import { startTestApp, testConfig, type TestApp } from './support/app.js';
import { startTcpProxy } from './support/tcp-proxy.js';

describe('GET /health', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('responde 200 con la base migrada', async () => {
    const res = await t.http.get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    const tables = await t.orm.em
      .getConnection()
      .execute<{ table_name: string }[]>(
        "select table_name from information_schema.tables where table_schema = 'public'",
      );
    expect(tables.map((r) => r.table_name)).toEqual(
      expect.arrayContaining([
        'clinic',
        'patient',
        'appointment',
        'reminder',
        'inbound_message',
      ]),
    );
  });
});

describe('GET /health sin base', () => {
  it('responde 503 { error } cuando la base deja de responder', async () => {
    // La app llega a Postgres a través de un proxy; al cerrarlo, la base
    // desaparece para la app igual que en una caída real.
    const db = new URL(testConfig().databaseUrl);
    const proxy = await startTcpProxy(db.hostname, Number(db.port || 5432));
    db.hostname = '127.0.0.1';
    db.port = String(proxy.port);
    const t = await startTestApp({ databaseUrl: db.toString() });
    try {
      await t.http.get('/health').expect(200);
      await proxy.close();
      const res = await t.http.get('/health');
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'database unavailable' });
    } finally {
      await proxy.close();
      await t.close();
    }
  });
});

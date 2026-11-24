import { startTestApp, type TestApp } from './support/app.js';

describe('reloj de pruebas', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('PUT /test/clock responde 204 en modo test', async () => {
    await t.http
      .put('/test/clock')
      .send({ now: '2027-03-01T00:00:00Z' })
      .expect(204);
  });

  it('PUT /test/clock con now inválido responde 400 { error }', async () => {
    const res = await t.http
      .put('/test/clock')
      .send({ now: '2027-03-01T00:00:00' })
      .expect(400);
    expect(typeof res.body.error).toBe('string');
  });

  it('un JSON mal formado responde 400 { error }', async () => {
    const res = await t.http
      .put('/test/clock')
      .set('Content-Type', 'application/json')
      .send('{"now":')
      .expect(400);
    expect(Object.keys(res.body)).toEqual(['error']);
  });

  it('una ruta desconocida responde 404 { error }', async () => {
    const res = await t.http.get('/no-existe').expect(404);
    expect(typeof res.body.error).toBe('string');
  });
});

describe('reloj del sistema', () => {
  it('PUT /test/clock no existe sin CLOCK_MODE=test', async () => {
    const t = await startTestApp({ clockMode: 'system' });
    try {
      const res = await t.http
        .put('/test/clock')
        .send({ now: '2027-03-01T00:00:00Z' })
        .expect(404);
      expect(typeof res.body.error).toBe('string');
    } finally {
      await t.close();
    }
  });
});

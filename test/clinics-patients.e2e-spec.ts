import { randomUUID } from 'node:crypto';
import { Transactions } from '../src/application/ports/transactions.js';
import { startTestApp, type TestApp } from './support/app.js';
import { createClinic, createPatient } from './support/fixtures.js';

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('clínicas y pacientes', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await t.reset();
  });

  describe('POST /clinics', () => {
    it('responde 201 con la clínica creada', async () => {
      const res = await t.http
        .post('/clinics')
        .send({ name: 'Clínica Dental Sonrisa', timezone: 'Atlantic/Canary' });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        id: expect.stringMatching(UUID_V7),
        name: 'Clínica Dental Sonrisa',
        timezone: 'Atlantic/Canary',
      });
    });

    it.each(['Europe/Narnia', 'local', '+01:00'])(
      'con la zona %s responde 400 { error }',
      async (timezone) => {
        const res = await t.http
          .post('/clinics')
          .send({ name: 'Clínica', timezone });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({
          error: 'timezone must be a valid IANA time zone',
        });
      },
    );

    it.each([
      ['sin name', { timezone: 'Europe/Madrid' }],
      ['con name vacío', { name: '', timezone: 'Europe/Madrid' }],
      ['con name que no es texto', { name: 7, timezone: 'Europe/Madrid' }],
      ['sin timezone', { name: 'Clínica' }],
    ])('%s responde 400 { error }', async (_label, body) => {
      const res = await t.http.post('/clinics').send(body);
      expect(res.status).toBe(400);
      expect(Object.keys(res.body)).toEqual(['error']);
    });

    it('con JSON mal formado responde 400 { error }', async () => {
      const res = await t.http
        .post('/clinics')
        .set('Content-Type', 'application/json')
        .send('{"name":');
      expect(res.status).toBe(400);
      expect(Object.keys(res.body)).toEqual(['error']);
    });
  });

  describe('POST /patients', () => {
    it('responde 201 con el paciente creado', async () => {
      const clinic = await createClinic(t);
      const res = await t.http.post('/patients').send({
        clinicId: clinic.id,
        name: 'Ana',
        phone: '+34600111222',
        acceptsReminders: true,
      });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        id: expect.stringMatching(UUID_V7),
        clinicId: clinic.id,
        name: 'Ana',
        phone: '+34600111222',
        acceptsReminders: true,
      });
    });

    it('sin phone responde 201 con phone null', async () => {
      const clinic = await createClinic(t);
      const res = await t.http
        .post('/patients')
        .send({ clinicId: clinic.id, name: 'Luis', acceptsReminders: false });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ phone: null, acceptsReminders: false });
    });

    it('el repositorio devuelve el paciente guardado como tipo del dominio', async () => {
      const clinic = await createClinic(t);
      const patient = await createPatient(t, clinic.id, {
        name: 'Luis',
        phone: null,
        acceptsReminders: false,
      });
      const transactions = t.app.get(Transactions);
      const found = await transactions.run((repos) =>
        repos.patients.findById(patient.id),
      );
      expect(found).toEqual({
        id: patient.id,
        clinicId: clinic.id,
        name: 'Luis',
        phone: null,
        acceptsReminders: false,
      });
      const missing = await transactions.run((repos) =>
        repos.patients.findById(randomUUID()),
      );
      expect(missing).toBeNull();
    });

    it('con phone null responde 201 con phone null', async () => {
      const clinic = await createClinic(t);
      const res = await t.http.post('/patients').send({
        clinicId: clinic.id,
        name: 'Luis',
        phone: null,
        acceptsReminders: true,
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ phone: null });
    });

    it.each([
      ['un phone sin formato E.164', { phone: '600111222' }],
      ['un phone que no es texto', { phone: 34600111222 }],
      ['acceptsReminders como texto', { acceptsReminders: 'true' }],
      ['acceptsReminders ausente', { acceptsReminders: undefined }],
      ['un name vacío', { name: '' }],
      ['un clinicId que no es texto', { clinicId: 7 }],
    ])('con %s responde 400 { error }', async (_label, over) => {
      const clinic = await createClinic(t);
      const res = await t.http.post('/patients').send({
        clinicId: clinic.id,
        name: 'Ana',
        phone: '+34600111222',
        acceptsReminders: true,
        ...over,
      });
      expect(res.status).toBe(400);
      expect(Object.keys(res.body)).toEqual(['error']);
    });

    it('con una clínica que no existe responde 404 { error }', async () => {
      const res = await t.http.post('/patients').send({
        clinicId: randomUUID(),
        name: 'Ana',
        acceptsReminders: true,
      });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'clinic not found' });
    });

    it('con un clinicId que no es UUID responde 404 { error }', async () => {
      const res = await t.http
        .post('/patients')
        .send({ clinicId: 'abc', name: 'Ana', acceptsReminders: true });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'clinic not found' });
    });

    it('valida el cuerpo antes de buscar la clínica (400 antes que 404)', async () => {
      const res = await t.http.post('/patients').send({
        clinicId: randomUUID(),
        name: 'Ana',
        phone: '600111222',
        acceptsReminders: true,
      });
      expect(res.status).toBe(400);
      expect(Object.keys(res.body)).toEqual(['error']);
    });
  });
});

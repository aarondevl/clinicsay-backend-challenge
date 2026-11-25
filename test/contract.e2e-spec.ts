import type { Response, Test } from 'supertest';
import { startTestApp, type TestApp } from './support/app.js';
import {
  expectContract,
  type HttpMethod,
  uncoveredResponses,
} from './support/contract.js';
import type {
  AppointmentBody,
  ClinicBody,
  PatientBody,
} from './support/fixtures.js';

// Hora del servicio al crear las citas.
const NOW = '2027-03-01T00:00:00Z';
// 10:00 de Madrid el día del cambio de horario (CEST).
const STARTS_AT = '2027-03-28T08:00:00Z';
// Envío previsto: 10:00 de Madrid del día anterior (CET).
const SEND_AT = '2027-03-27T09:00:00Z';
const PHONE = '+34600111222';
// UUIDv7 válido que ninguna fila usa.
const UNKNOWN_ID = '0190d6f0-0000-7000-8000-000000000000';

/**
 * Recorre cada operación y cada código de `openapi.yaml` y valida cada
 * respuesta con `expectContract` en modo estricto. El último test falla si
 * alguna respuesta documentada no se ejercitó.
 */
describe('contrato (openapi.yaml)', () => {
  let t: TestApp;
  let messageSeq = 0;

  beforeAll(async () => {
    t = await startTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await t.reset();
    await clock(NOW);
  });

  /**
   * Espera la respuesta, la valida contra el contrato y comprueba que el
   * escenario dio el código que se buscaba.
   */
  async function call(
    req: Test,
    method: HttpMethod,
    path: string,
    status: number,
  ): Promise<Response> {
    const res = await req;
    expectContract(res, method, path);
    expect(res.status).toBe(status);
    return res;
  }

  async function clock(now: string): Promise<void> {
    await call(
      t.http.put('/test/clock').send({ now }),
      'put',
      '/test/clock',
      204,
    );
  }

  async function clinic(
    over: Record<string, unknown> = {},
  ): Promise<ClinicBody> {
    const res = await call(
      t.http.post('/clinics').send({
        name: 'Clínica Dental Sonrisa',
        timezone: 'Europe/Madrid',
        ...over,
      }),
      'post',
      '/clinics',
      201,
    );
    // Límite con supertest: el cuerpo llega sin tipo y ya cumple el contrato.
    return res.body as ClinicBody;
  }

  async function patient(
    clinicId: string,
    over: Record<string, unknown> = {},
  ): Promise<PatientBody> {
    const res = await call(
      t.http.post('/patients').send({
        clinicId,
        name: 'Ana',
        phone: PHONE,
        acceptsReminders: true,
        ...over,
      }),
      'post',
      '/patients',
      201,
    );
    // Límite con supertest: el cuerpo llega sin tipo y ya cumple el contrato.
    return res.body as PatientBody;
  }

  /** Cita de una paciente nueva de una clínica de Madrid. */
  async function appointment(
    over: Record<string, unknown> = {},
    patientOver: Record<string, unknown> = {},
  ): Promise<AppointmentBody> {
    const c = await clinic();
    const p = await patient(c.id, patientOver);
    const res = await call(
      t.http.post('/appointments').send({
        clinicId: c.id,
        patientId: p.id,
        startsAt: STARTS_AT,
        ...over,
      }),
      'post',
      '/appointments',
      201,
    );
    // Límite con supertest: el cuerpo llega sin tipo y ya cumple el contrato.
    return res.body as AppointmentBody;
  }

  async function get(id: string): Promise<AppointmentBody> {
    const res = await call(
      t.http.get(`/appointments/${id}`),
      'get',
      '/appointments/{id}',
      200,
    );
    // Límite con supertest: el cuerpo llega sin tipo y ya cumple el contrato.
    return res.body as AppointmentBody;
  }

  async function runJob(): Promise<unknown> {
    const res = await call(
      t.http.post('/jobs/reminders/run'),
      'post',
      '/jobs/reminders/run',
      200,
    );
    return res.body;
  }

  async function reply(text: string): Promise<void> {
    messageSeq += 1;
    await call(
      t.http.post('/webhooks/inbound-messages').send({
        messageId: `contract-${messageSeq}`,
        from: PHONE,
        text,
        receivedAt: SEND_AT,
      }),
      'post',
      '/webhooks/inbound-messages',
      200,
    );
  }

  /** Estado y motivo de cada recordatorio, del más antiguo al más nuevo. */
  function reminderStates(a: AppointmentBody) {
    return a.reminders.map((r) => [r.status, r.skipReason]);
  }

  describe('GET /health', () => {
    it('200', async () => {
      await call(t.http.get('/health'), 'get', '/health', 200);
    });
  });

  describe('PUT /test/clock', () => {
    it('204 sin cuerpo', async () => {
      await clock('2027-03-10T10:00:00.250Z');
    });
  });

  describe('POST /clinics', () => {
    it('201', async () => {
      await clinic({ timezone: 'Atlantic/Canary' });
    });

    it.each([
      ['sin timezone', { name: 'Clínica' }],
      [
        'con una zona que no existe',
        { name: 'Clínica', timezone: 'Mars/Olympus' },
      ],
      [
        'con un offset en vez de una zona',
        { name: 'Clínica', timezone: '+01:00' },
      ],
      ['con el nombre vacío', { name: '', timezone: 'Europe/Madrid' }],
    ])('400 %s', async (_label, body) => {
      await call(t.http.post('/clinics').send(body), 'post', '/clinics', 400);
    });
  });

  describe('POST /patients', () => {
    it('201 con teléfono', async () => {
      await patient((await clinic()).id);
    });

    it('201 sin teléfono y sin aceptar recordatorios', async () => {
      const p = await patient((await clinic()).id, {
        phone: null,
        acceptsReminders: false,
      });
      expect(p.phone).toBeNull();
    });

    it.each([
      ['con un teléfono que no es E.164', { phone: '600111222' }],
      ['sin acceptsReminders', { acceptsReminders: undefined }],
      ['con acceptsReminders como texto', { acceptsReminders: 'true' }],
    ])('400 %s', async (_label, over) => {
      const c = await clinic();
      await call(
        t.http.post('/patients').send({
          clinicId: c.id,
          name: 'Ana',
          phone: PHONE,
          acceptsReminders: true,
          ...over,
        }),
        'post',
        '/patients',
        400,
      );
    });

    it.each([
      ['que no existe', UNKNOWN_ID],
      ['con un id que no es UUID', 'no-es-un-id'],
    ])('404 con una clínica %s', async (_label, clinicId) => {
      await call(
        t.http.post('/patients').send({
          clinicId,
          name: 'Ana',
          phone: PHONE,
          acceptsReminders: true,
        }),
        'post',
        '/patients',
        404,
      );
    });
  });

  describe('POST /appointments', () => {
    it('201 con su recordatorio pendiente', async () => {
      const a = await appointment();
      expect(a.reminders).toEqual([
        expect.objectContaining({ scheduledFor: SEND_AT, status: 'pending' }),
      ]);
    });

    it('201 con virtual: true, la extensión documentada', async () => {
      const a = await appointment({ virtual: true });
      expect(a.virtual).toBe(true);
    });

    it('201 sin la clave virtual con virtual: false', async () => {
      const a = await appointment({ virtual: false });
      expect(a).not.toHaveProperty('virtual');
    });

    it('201 con el recordatorio skipped/too_late', async () => {
      // 22:30 en Madrid: la franja lleva el envío a las 09:00, tras el inicio.
      await clock('2027-03-10T21:30:00Z');
      const a = await appointment({ startsAt: '2027-03-11T07:30:00Z' });
      expect(reminderStates(a)).toEqual([['skipped', 'too_late']]);
    });

    it('201 con milisegundos en una fecha cuando no son cero', async () => {
      // La hora de envío ya pasó: se usa la del servicio, con sus milisegundos.
      await clock('2027-03-10T10:00:00.250Z');
      const a = await appointment({ startsAt: '2027-03-10T18:00:00Z' });
      expect(a.reminders[0]?.scheduledFor).toBe('2027-03-10T10:00:00.250Z');
    });

    it.each([
      ['con startsAt sin zona', { startsAt: '2027-03-28T10:00:00' }],
      ['con startsAt en el pasado', { startsAt: '2027-02-01T08:00:00Z' }],
      ['sin startsAt', { startsAt: undefined }],
    ])('400 %s', async (_label, over) => {
      const c = await clinic();
      const p = await patient(c.id);
      await call(
        t.http
          .post('/appointments')
          .send({ clinicId: c.id, patientId: p.id, ...over }),
        'post',
        '/appointments',
        400,
      );
    });

    it('400 si el paciente no es de esa clínica', async () => {
      const c = await clinic();
      const other = await patient((await clinic()).id);
      await call(
        t.http
          .post('/appointments')
          .send({ clinicId: c.id, patientId: other.id, startsAt: STARTS_AT }),
        'post',
        '/appointments',
        400,
      );
    });

    it.each(['clinicId', 'patientId'])(
      '404 con un %s que no existe',
      async (field) => {
        const c = await clinic();
        const p = await patient(c.id);
        await call(
          t.http.post('/appointments').send({
            clinicId: c.id,
            patientId: p.id,
            startsAt: STARTS_AT,
            [field]: UNKNOWN_ID,
          }),
          'post',
          '/appointments',
          404,
        );
      },
    );
  });

  describe('GET /appointments/{id}', () => {
    it('200 con la cita confirmada y su recordatorio sent', async () => {
      const a = await appointment();
      await clock(SEND_AT);
      expect(await runJob()).toEqual({ processed: 1 });
      await reply('Sí');
      const read = await get(a.id);
      expect(read.status).toBe('confirmed');
      expect(read.reminders).toEqual([
        expect.objectContaining({
          status: 'sent',
          attempts: 1,
          sentAt: SEND_AT,
        }),
      ]);
    });

    it('200 con un sentAt con milisegundos', async () => {
      const a = await appointment();
      await clock('2027-03-27T09:00:00.250Z');
      await runJob();
      const read = await get(a.id);
      expect(read.reminders[0]?.sentAt).toBe('2027-03-27T09:00:00.250Z');
    });

    it('200 con la cita cancelada y sus recordatorios sent y cancelled', async () => {
      const a = await appointment();
      await clock(SEND_AT);
      await runJob();
      await call(
        t.http
          .patch(`/appointments/${a.id}`)
          .send({ startsAt: '2027-04-10T08:00:00Z' }),
        'patch',
        '/appointments/{id}',
        200,
      );
      await call(
        t.http.post(`/appointments/${a.id}/cancel`),
        'post',
        '/appointments/{id}/cancel',
        200,
      );
      const read = await get(a.id);
      expect(read.status).toBe('cancelled');
      expect(reminderStates(read)).toEqual([
        ['sent', null],
        ['cancelled', null],
      ]);
    });

    it('200 con el recordatorio failed', async () => {
      const a = await appointment();
      await t.provider.rule(PHONE, 'reject', 1);
      await clock(SEND_AT);
      await runJob();
      expect(reminderStates(await get(a.id))).toEqual([['failed', null]]);
    });

    it.each([
      ['no_phone', { phone: null }],
      ['opted_out', { acceptsReminders: false }],
    ])('200 con el recordatorio skipped/%s', async (reason, patientOver) => {
      const a = await appointment({}, patientOver);
      await clock(SEND_AT);
      await runJob();
      expect(reminderStates(await get(a.id))).toEqual([['skipped', reason]]);
    });

    it('200 con una cita virtual', async () => {
      const a = await appointment({ virtual: true });
      expect((await get(a.id)).virtual).toBe(true);
    });

    it.each([
      ['que no existe', UNKNOWN_ID],
      ['con un id que no es UUID', 'no-es-un-id'],
    ])('404 con una cita %s', async (_label, id) => {
      await call(
        t.http.get(`/appointments/${id}`),
        'get',
        '/appointments/{id}',
        404,
      );
    });
  });

  describe('PATCH /appointments/{id}', () => {
    it('200 con el pendiente cancelado y otro nuevo', async () => {
      const a = await appointment();
      const res = await call(
        t.http
          .patch(`/appointments/${a.id}`)
          .send({ startsAt: '2027-04-10T08:00:00Z' }),
        'patch',
        '/appointments/{id}',
        200,
      );
      // Límite con supertest: el cuerpo llega sin tipo y ya cumple el contrato.
      expect(reminderStates(res.body as AppointmentBody)).toEqual([
        ['cancelled', null],
        ['pending', null],
      ]);
    });

    it.each([
      ['con startsAt sin zona', { startsAt: '2027-04-10T10:00:00' }],
      ['con startsAt en el pasado', { startsAt: '2027-02-01T08:00:00Z' }],
      ['sin startsAt', {}],
    ])('400 %s', async (_label, body) => {
      const a = await appointment();
      await call(
        t.http.patch(`/appointments/${a.id}`).send(body),
        'patch',
        '/appointments/{id}',
        400,
      );
    });

    it('404 con una cita que no existe', async () => {
      await call(
        t.http
          .patch(`/appointments/${UNKNOWN_ID}`)
          .send({ startsAt: STARTS_AT }),
        'patch',
        '/appointments/{id}',
        404,
      );
    });

    it('409 con una cita cancelada', async () => {
      const a = await appointment();
      await call(
        t.http.post(`/appointments/${a.id}/cancel`),
        'post',
        '/appointments/{id}/cancel',
        200,
      );
      await call(
        t.http
          .patch(`/appointments/${a.id}`)
          .send({ startsAt: '2027-04-10T08:00:00Z' }),
        'patch',
        '/appointments/{id}',
        409,
      );
    });

    it('409 con una cita que ya empezó', async () => {
      const a = await appointment();
      await clock('2027-03-28T08:30:00Z');
      await call(
        t.http
          .patch(`/appointments/${a.id}`)
          .send({ startsAt: '2027-04-10T08:00:00Z' }),
        'patch',
        '/appointments/{id}',
        409,
      );
    });
  });

  describe('POST /appointments/{id}/cancel', () => {
    it('200, también si ya estaba cancelada', async () => {
      const a = await appointment();
      for (let i = 0; i < 2; i += 1) {
        const res = await call(
          t.http.post(`/appointments/${a.id}/cancel`),
          'post',
          '/appointments/{id}/cancel',
          200,
        );
        // Límite con supertest: el cuerpo llega sin tipo y ya cumple el contrato.
        expect((res.body as AppointmentBody).status).toBe('cancelled');
      }
    });

    it.each([
      ['que no existe', UNKNOWN_ID],
      ['con un id que no es UUID', 'no-es-un-id'],
    ])('404 con una cita %s', async (_label, id) => {
      await call(
        t.http.post(`/appointments/${id}/cancel`),
        'post',
        '/appointments/{id}/cancel',
        404,
      );
    });
  });

  describe('POST /jobs/reminders/run', () => {
    it('200 { processed } sin nada que enviar', async () => {
      expect(await runJob()).toEqual({ processed: 0 });
    });
  });

  describe('POST /webhooks/inbound-messages', () => {
    it('200 sin cuerpo, también con un texto que se ignora', async () => {
      const a = await appointment();
      await clock(SEND_AT);
      await runJob();
      await reply('Hola');
      await reply('NO!');
      expect((await get(a.id)).status).toBe('cancelled');
    });

    it.each([
      ['sin messageId', { messageId: undefined }],
      ['con receivedAt sin zona', { receivedAt: '2027-03-27T10:00:00' }],
      ['con text que no es texto', { text: 1 }],
    ])('400 %s', async (_label, over) => {
      await call(
        t.http.post('/webhooks/inbound-messages').send({
          messageId: 'contract-400',
          from: PHONE,
          text: 'SI',
          receivedAt: SEND_AT,
          ...over,
        }),
        'post',
        '/webhooks/inbound-messages',
        400,
      );
    });
  });

  // Va el último: Vitest corre los tests de un archivo en orden.
  it('ejercita cada operación y cada código documentados en openapi.yaml', () => {
    expect(uncoveredResponses()).toEqual([]);
  });
});

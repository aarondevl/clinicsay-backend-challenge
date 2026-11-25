import { randomUUID } from 'node:crypto';
import { IdGenerator } from '../src/application/ports/id-generator.js';
import { Transactions } from '../src/application/ports/transactions.js';
import type { Reminder } from '../src/domain/reminder.js';
import { startTestApp, type TestApp } from './support/app.js';
import {
  createAppointment,
  createClinic,
  createPatient,
} from './support/fixtures.js';

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Hora del servicio en cada test salvo que se diga otra cosa.
const NOW = '2027-03-01T00:00:00Z';

describe('citas', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await t.reset();
    await t.setClock(NOW);
  });

  /** Clínica de Madrid con una paciente con teléfono. */
  async function madridPatient() {
    const clinic = await createClinic(t);
    const patient = await createPatient(t, clinic.id);
    return { clinic, patient };
  }

  describe('POST /appointments', () => {
    it('responde 201 con la cita y su recordatorio pendiente, fechas en UTC sin milisegundos', async () => {
      const { clinic, patient } = await madridPatient();
      // Ejemplo del enunciado: 10:00 de Madrid el día del cambio de horario.
      const res = await t.http.post('/appointments').send({
        clinicId: clinic.id,
        patientId: patient.id,
        startsAt: '2027-03-28T10:00:00+02:00',
      });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        id: expect.stringMatching(UUID_V7),
        clinicId: clinic.id,
        patientId: patient.id,
        startsAt: '2027-03-28T08:00:00Z',
        status: 'scheduled',
        reminders: [
          {
            id: expect.stringMatching(UUID_V7),
            scheduledFor: '2027-03-27T09:00:00Z',
            status: 'pending',
            attempts: 0,
            sentAt: null,
            skipReason: null,
          },
        ],
      });
      expect(res.body).not.toHaveProperty('virtual');
    });

    it('si la hora de envío ya pasó usa la hora del servicio', async () => {
      const { clinic, patient } = await madridPatient();
      await t.setClock('2027-03-10T10:00:00Z'); // 11:00 en Madrid
      const appointment = await createAppointment(
        t,
        clinic.id,
        patient.id,
        '2027-03-10T18:00:00Z',
      );
      expect(appointment.reminders).toEqual([
        expect.objectContaining({
          scheduledFor: '2027-03-10T10:00:00Z',
          status: 'pending',
          skipReason: null,
        }),
      ]);
    });

    it('crea el recordatorio skipped too_late si no da tiempo a enviarlo', async () => {
      const { clinic, patient } = await madridPatient();
      // 22:30 en Madrid: la franja lo lleva a las 09:00 (08:00Z), tras el inicio.
      await t.setClock('2027-03-10T21:30:00Z');
      const appointment = await createAppointment(
        t,
        clinic.id,
        patient.id,
        '2027-03-11T07:30:00Z',
      );
      expect(appointment.status).toBe('scheduled');
      expect(appointment.reminders).toEqual([
        {
          id: expect.stringMatching(UUID_V7),
          scheduledFor: '2027-03-11T08:00:00Z',
          status: 'skipped',
          attempts: 0,
          sentAt: null,
          skipReason: 'too_late',
        },
      ]);
    });

    it('una cita virtual usa la hora de Madrid en una clínica de Canarias', async () => {
      const clinic = await createClinic(t, { timezone: 'Atlantic/Canary' });
      const patient = await createPatient(t, clinic.id);
      const startsAt = '2027-03-10T08:30:00Z'; // 08:30 en Canarias, 09:30 en Madrid

      const local = await createAppointment(t, clinic.id, patient.id, startsAt);
      // 08:30 en Canarias el día anterior cae en la franja → 09:00 de Canarias.
      expect(local.reminders[0]?.scheduledFor).toBe('2027-03-09T09:00:00Z');
      expect(local).not.toHaveProperty('virtual');

      const virtual = await createAppointment(
        t,
        clinic.id,
        patient.id,
        startsAt,
        { virtual: true },
      );
      // 09:30 en Madrid el día anterior queda fuera de la franja.
      expect(virtual.reminders[0]?.scheduledFor).toBe('2027-03-09T08:30:00Z');
      expect(virtual.virtual).toBe(true);
      const res = await t.http.get(`/appointments/${virtual.id}`);
      expect(res.body).toMatchObject({ virtual: true });
    });

    it('con virtual: false responde sin la clave virtual', async () => {
      const { clinic, patient } = await madridPatient();
      const appointment = await createAppointment(
        t,
        clinic.id,
        patient.id,
        '2027-03-28T10:00:00+02:00',
        { virtual: false },
      );
      expect(appointment).not.toHaveProperty('virtual');
    });

    it.each([
      ['startsAt sin zona', { startsAt: '2027-03-28T10:00:00' }],
      ['startsAt que no es fecha', { startsAt: 'mañana' }],
      ['startsAt ausente', { startsAt: undefined }],
      ['clinicId ausente', { clinicId: undefined }],
      ['patientId que no es texto', { patientId: 7 }],
      ['virtual como texto', { virtual: 'true' }],
      [
        'startsAt con un offset imposible',
        { startsAt: '2027-03-28T10:00:00+99:00' },
      ],
      [
        'startsAt con un año de 5 cifras',
        { startsAt: '+010000-01-01T00:00:00Z' },
      ],
      // Postgres lee el `+010000-…` de `toISOString()` como un offset: 500.
      [
        'startsAt que en UTC pasa al año 10000',
        { startsAt: '9999-12-31T23:30:00-01:00' },
      ],
    ])('con %s responde 400 { error }', async (_label, over) => {
      const { clinic, patient } = await madridPatient();
      const res = await t.http.post('/appointments').send({
        clinicId: clinic.id,
        patientId: patient.id,
        startsAt: '2027-03-28T10:00:00+02:00',
        ...over,
      });
      expect(res.status).toBe(400);
      expect(Object.keys(res.body)).toEqual(['error']);
    });

    it('con startsAt sin fecha responde 400 en vez de usar la fecha del sistema', async () => {
      const { clinic, patient } = await madridPatient();
      // Con el reloj en el pasado, «hoy a las 10:00» del sistema sería futura.
      await t.setClock('2000-01-01T00:00:00Z');
      const res = await t.http.post('/appointments').send({
        clinicId: clinic.id,
        patientId: patient.id,
        startsAt: '10:00:00Z',
      });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'startsAt must be an ISO 8601 date-time with a time zone',
      });
    });

    it('con startsAt en el año 0 responde 400 de esquema antes que 404', async () => {
      const res = await t.http.post('/appointments').send({
        clinicId: randomUUID(),
        patientId: randomUUID(),
        startsAt: '0000-01-01T00:00:00Z',
      });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'startsAt must be between the years 0001 and 9999 in UTC',
      });
    });

    it.each([
      ['pasada', '2027-02-28T10:00:00Z'],
      ['igual a la hora del servicio', NOW],
    ])('con startsAt %s responde 400 { error }', async (_label, startsAt) => {
      const { clinic, patient } = await madridPatient();
      const res = await t.http
        .post('/appointments')
        .send({ clinicId: clinic.id, patientId: patient.id, startsAt });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'startsAt must be in the future' });
    });

    it('con un paciente de otra clínica responde 400 { error }', async () => {
      const { patient } = await madridPatient();
      const other = await createClinic(t, { name: 'Otra clínica' });
      const res = await t.http.post('/appointments').send({
        clinicId: other.id,
        patientId: patient.id,
        startsAt: '2027-03-28T10:00:00+02:00',
      });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'patient does not belong to clinic' });
    });

    it.each([
      ['una clínica que no existe', 'clinic', 'clinic not found'],
      ['un clinicId que no es UUID', 'clinic-x', 'clinic not found'],
      ['un paciente que no existe', 'patient', 'patient not found'],
      ['un patientId que no es UUID', 'patient-x', 'patient not found'],
    ])('con %s responde 404 { error }', async (_label, which, error) => {
      const { clinic, patient } = await madridPatient();
      const ids = {
        clinic: { clinicId: randomUUID() },
        'clinic-x': { clinicId: 'x' },
        patient: { patientId: randomUUID() },
        'patient-x': { patientId: 'x' },
      }[which];
      const res = await t.http.post('/appointments').send({
        clinicId: clinic.id,
        patientId: patient.id,
        startsAt: '2027-03-28T10:00:00+02:00',
        ...ids,
      });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error });
    });

    it('valida el cuerpo antes de buscar la clínica (400 antes que 404)', async () => {
      const res = await t.http.post('/appointments').send({
        clinicId: randomUUID(),
        patientId: randomUUID(),
        startsAt: '2027-03-28T10:00:00',
      });
      expect(res.status).toBe(400);
      expect(Object.keys(res.body)).toEqual(['error']);
    });

    it('busca la clínica y el paciente antes de las reglas de negocio (404 antes que 400)', async () => {
      const { clinic } = await madridPatient();
      const res = await t.http.post('/appointments').send({
        clinicId: clinic.id,
        patientId: randomUUID(),
        startsAt: '2027-02-28T10:00:00Z',
      });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'patient not found' });
    });
  });

  describe('GET /appointments/{id}', () => {
    it('devuelve lo mismo que el POST', async () => {
      const { clinic, patient } = await madridPatient();
      const created = await createAppointment(
        t,
        clinic.id,
        patient.id,
        '2027-03-28T10:00:00+02:00',
      );
      const res = await t.http.get(`/appointments/${created.id}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(created);
    });

    it.each([
      ['que no existe', randomUUID()],
      ['que no es UUID', 'abc'],
    ])('con un id %s responde 404 { error }', async (_label, id) => {
      const res = await t.http.get(`/appointments/${id}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'appointment not found' });
    });
  });

  it('el repositorio lista los recordatorios por id ascendente, como tipos del dominio', async () => {
    const { clinic, patient } = await madridPatient();
    const appointment = await createAppointment(
      t,
      clinic.id,
      patient.id,
      '2027-03-28T10:00:00+02:00',
    );
    const ids = t.app.get(IdGenerator);
    const transactions = t.app.get(Transactions);
    const older = ids.next();
    const newer = ids.next();
    const base = {
      appointmentId: appointment.id,
      scheduledFor: new Date('2027-03-27T09:00:00Z'),
      skipReason: null,
      nextAttemptAt: null,
    };
    const sent: Reminder = {
      ...base,
      id: newer,
      status: 'sent',
      attempts: 2,
      sentAt: new Date('2027-03-27T09:01:30Z'),
      sentTo: '+34600111222',
      sendSeq: 7,
    };
    const cancelled: Reminder = {
      ...base,
      id: older,
      status: 'cancelled',
      attempts: 0,
      sentAt: null,
      sentTo: null,
      sendSeq: null,
    };
    // Se insertan al revés de su orden de id.
    await transactions.run(async (repos) => {
      await repos.reminders.insert(sent);
      await repos.reminders.insert(cancelled);
    });

    const listed = await transactions.run((repos) =>
      repos.reminders.listByAppointment(appointment.id),
    );
    const first = new Date('2027-03-27T09:00:00Z');
    expect(listed).toEqual([
      {
        id: appointment.reminders[0]?.id,
        appointmentId: appointment.id,
        scheduledFor: first,
        status: 'pending',
        skipReason: null,
        attempts: 0,
        nextAttemptAt: first,
        sentAt: null,
        sentTo: null,
        sendSeq: null,
      },
      cancelled,
      sent,
    ]);
  });
});

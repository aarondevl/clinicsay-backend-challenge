import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { IdGenerator } from '../src/application/ports/id-generator.js';
import { Transactions } from '../src/application/ports/transactions.js';
import type { Appointment } from '../src/domain/appointment.js';
import { cancelReminder, type Reminder } from '../src/domain/reminder.js';
import { startTestApp, type TestApp } from './support/app.js';
import { holdLock } from './support/locks.js';
import {
  type AppointmentBody,
  createAppointment,
  createClinic,
  createPatient,
} from './support/fixtures.js';

// Hora del servicio en cada test salvo que se diga otra cosa.
const NOW = '2027-03-01T00:00:00Z';
// 10:00 de Madrid el día del cambio de horario; recordatorio el 27 a las 09:00Z.
const STARTS_AT = '2027-03-28T08:00:00Z';

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Lo que tarda como mucho una consulta sin bloqueo en la base de los e2e. */
const UNBLOCKED_MS = 200;

describe('reprogramar y cancelar', () => {
  let t: TestApp;
  let transactions: Transactions;

  beforeAll(async () => {
    t = await startTestApp();
    transactions = t.app.get(Transactions);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await t.reset();
    await t.setClock(NOW);
  });

  /** Cita de una paciente de Madrid creada por la API. */
  async function madridAppointment(
    startsAt = STARTS_AT,
  ): Promise<AppointmentBody> {
    const clinic = await createClinic(t);
    const patient = await createPatient(t, clinic.id);
    return createAppointment(t, clinic.id, patient.id, startsAt);
  }

  /** La cita como tipo del dominio, leída por el repositorio. */
  async function storedAppointment(id: string): Promise<Appointment> {
    const appointment = await transactions.run((repos) =>
      repos.appointments.findById(id),
    );
    if (!appointment) throw new Error(`appointment ${id} not stored`);
    return appointment;
  }

  /** Inserta un recordatorio de la cita con el estado dado. */
  async function insertReminder(
    appointmentId: string,
    over: Partial<Reminder>,
  ): Promise<Reminder> {
    const reminder: Reminder = {
      id: t.app.get(IdGenerator).next(),
      appointmentId,
      scheduledFor: new Date('2027-03-26T09:00:00Z'),
      status: 'cancelled',
      skipReason: null,
      attempts: 0,
      nextAttemptAt: null,
      sentAt: null,
      sentTo: null,
      sendSeq: null,
      ...over,
    };
    await transactions.run((repos) => repos.reminders.insert(reminder));
    return reminder;
  }

  describe('repositorios', () => {
    it('AppointmentRepository.update guarda la hora y el estado', async () => {
      const created = await madridAppointment();
      const before = await storedAppointment(created.id);
      const changed: Appointment = {
        ...before,
        startsAt: new Date('2027-03-29T08:00:00Z'),
        status: 'confirmed',
      };
      await transactions.run((repos) => repos.appointments.update(changed));
      expect(await storedAppointment(created.id)).toEqual(changed);
    });

    it('lockById devuelve la cita, o null si no existe', async () => {
      const created = await madridAppointment();
      const stored = await storedAppointment(created.id);
      await expect(
        transactions.run((repos) => repos.appointments.lockById(created.id)),
      ).resolves.toEqual(stored);
      await expect(
        transactions.run((repos) =>
          repos.appointments.lockById(t.app.get(IdGenerator).next()),
        ),
      ).resolves.toBeNull();
    });

    it('lockById espera a la transacción que tiene la cita y ve lo que confirmó', async () => {
      const created = await madridAppointment();
      const stored = await storedAppointment(created.id);
      const first = await holdLock(
        transactions,
        (repos) => repos.appointments.lockById(created.id),
        (repos) =>
          repos.appointments.update({ ...stored, status: 'confirmed' }),
      );

      const events: string[] = [];
      const second = transactions.run(async (repos) => {
        const seen = await repos.appointments.lockById(created.id);
        events.push('second locked');
        return seen;
      });
      await sleep(UNBLOCKED_MS);
      events.push('first released');
      first.release();

      const [, seen] = await Promise.all([first.done, second]);
      expect(events).toEqual(['first released', 'second locked']);
      expect(seen?.status).toBe('confirmed');
    });

    it('en una misma transacción, findById ve lo que acaba de guardar update', async () => {
      const created = await madridAppointment();
      const seen = await transactions.run(async (repos) => {
        const before = await repos.appointments.findById(created.id);
        if (!before) throw new Error('appointment not stored');
        await repos.appointments.update({ ...before, status: 'confirmed' });
        return repos.appointments.findById(created.id);
      });
      expect(seen?.status).toBe('confirmed');
    });

    it('lockPendingByAppointment devuelve solo el pendiente de la cita', async () => {
      const created = await madridAppointment();
      await insertReminder(created.id, { status: 'cancelled' });
      await insertReminder(created.id, {
        status: 'sent',
        attempts: 1,
        sentAt: new Date('2027-03-26T09:00:00Z'),
        sentTo: '+34600111222',
        sendSeq: 1,
      });
      const other = await madridAppointment();

      const locked = await transactions.run((repos) =>
        repos.reminders.lockPendingByAppointment(created.id),
      );
      expect(locked.map((r) => r.id)).toEqual([created.reminders[0]?.id]);
      expect(locked[0]).toMatchObject({
        appointmentId: created.id,
        status: 'pending',
      });
      expect(locked.map((r) => r.id)).not.toContain(other.reminders[0]?.id);
    });

    it('lockPendingByAppointment espera al bloqueo del pendiente y ve su estado final', async () => {
      const created = await madridAppointment();
      const first = await holdLock(
        transactions,
        (repos) => repos.reminders.lockPendingByAppointment(created.id),
        async (repos) => {
          const [pending] = await repos.reminders.lockPendingByAppointment(
            created.id,
          );
          if (!pending) throw new Error('no pending reminder');
          await repos.reminders.update(cancelReminder(pending));
        },
      );

      const events: string[] = [];
      const second = transactions.run(async (repos) => {
        const seen = await repos.reminders.lockPendingByAppointment(created.id);
        events.push('second locked');
        return seen;
      });
      await sleep(UNBLOCKED_MS);
      events.push('first released');
      first.release();

      const [, seen] = await Promise.all([first.done, second]);
      expect(events).toEqual(['first released', 'second locked']);
      // El que esperaba ya no lo ve pendiente: lo cancelaron mientras tanto.
      expect(seen).toEqual([]);
    });

    it('ReminderRepository.update guarda todos los campos del recordatorio', async () => {
      const created = await madridAppointment();
      const id = created.reminders[0]?.id;
      const changed = await transactions.run(async (repos) => {
        const [pending] = await repos.reminders.lockPendingByAppointment(
          created.id,
        );
        if (!pending || pending.id !== id) throw new Error('no pending');
        const sent: Reminder = {
          ...pending,
          status: 'sent',
          attempts: 2,
          nextAttemptAt: null,
          sentAt: new Date('2027-03-27T09:01:30Z'),
          sentTo: '+34600111222',
          sendSeq: 9,
        };
        await repos.reminders.update(sent);
        return sent;
      });
      const listed = await transactions.run((repos) =>
        repos.reminders.listByAppointment(created.id),
      );
      expect(listed).toEqual([changed]);
    });

    it('en una misma transacción, listByAppointment ve el pendiente que acaba de cancelar update', async () => {
      const created = await madridAppointment();
      const listed = await transactions.run(async (repos) => {
        const [pending] = await repos.reminders.listByAppointment(created.id);
        if (!pending) throw new Error('no reminder');
        await repos.reminders.update(cancelReminder(pending));
        return repos.reminders.listByAppointment(created.id);
      });
      expect(listed).toEqual([
        expect.objectContaining({ status: 'cancelled', nextAttemptAt: null }),
      ]);
    });
  });

  /** Pone la cita en `status` por el repositorio (sin webhook todavía). */
  async function setStatus(
    id: string,
    status: Appointment['status'],
  ): Promise<void> {
    const appointment = await storedAppointment(id);
    await transactions.run((repos) =>
      repos.appointments.update({ ...appointment, status }),
    );
  }

  /** Cuerpo de una respuesta de cita (200 o 201). */
  const appointmentBody = (res: { body: unknown }): AppointmentBody =>
    // Límite con supertest: el cuerpo llega sin tipo y el test ya comprobó el estado.
    res.body as AppointmentBody;

  const patch = (id: string, body: object) =>
    t.http.patch(`/appointments/${id}`).send(body);
  const cancel = (id: string) => t.http.post(`/appointments/${id}/cancel`);

  describe('PATCH /appointments/{id}', () => {
    it('cancela el pendiente, crea otro para la hora nueva y responde 200 con la cita', async () => {
      const created = await madridAppointment();
      const res = await patch(created.id, { startsAt: '2027-03-29T08:00:00Z' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        id: created.id,
        clinicId: created.clinicId,
        patientId: created.patientId,
        startsAt: '2027-03-29T08:00:00Z',
        status: 'scheduled',
        reminders: [
          {
            id: created.reminders[0]?.id,
            scheduledFor: '2027-03-27T09:00:00Z',
            status: 'cancelled',
            attempts: 0,
            sentAt: null,
            skipReason: null,
          },
          {
            id: expect.stringMatching(UUID_V7),
            // 10:00 de Madrid (ya en horario de verano) del día anterior.
            scheduledFor: '2027-03-28T08:00:00Z',
            status: 'pending',
            attempts: 0,
            sentAt: null,
            skipReason: null,
          },
        ],
      });
      expect(res.body).not.toHaveProperty('virtual');
      const got = await t.http.get(`/appointments/${created.id}`);
      expect(got.body).toEqual(res.body);
    });

    it('reprogramar después de enviado deja el enviado sent y crea otro pendiente', async () => {
      const created = await madridAppointment();
      await t.setClock('2027-03-27T09:00:00Z');
      await t.http.post('/jobs/reminders/run').expect(200, { processed: 1 });
      const res = await patch(created.id, { startsAt: '2027-03-29T08:00:00Z' });
      expect(res.status).toBe(200);
      expect(
        appointmentBody(res).reminders.map((r) => [
          r.status,
          r.scheduledFor,
          r.attempts,
          r.sentAt,
        ]),
      ).toEqual([
        ['sent', '2027-03-27T09:00:00Z', 1, '2027-03-27T09:00:00Z'],
        // 10:00 de Madrid (CEST) del día anterior a la hora nueva.
        ['pending', '2027-03-28T08:00:00Z', 0, null],
      ]);
    });

    it('reprogramar dos veces sin mover el reloj lista los recordatorios en orden de creación', async () => {
      const created = await madridAppointment();
      await patch(created.id, { startsAt: '2027-03-29T08:00:00Z' }).expect(200);
      const res = await patch(created.id, {
        startsAt: '2027-03-30T08:00:00Z',
      }).expect(200);
      const reminders = appointmentBody(res).reminders;
      expect(reminders.map((r) => [r.status, r.scheduledFor])).toEqual([
        ['cancelled', '2027-03-27T09:00:00Z'],
        ['cancelled', '2027-03-28T08:00:00Z'],
        ['pending', '2027-03-29T08:00:00Z'],
      ]);
      expect(reminders[0]?.id).toBe(created.reminders[0]?.id);
    });

    it('una cita confirmed vuelve a scheduled', async () => {
      const created = await madridAppointment();
      await setStatus(created.id, 'confirmed');
      const res = await patch(created.id, { startsAt: '2027-03-29T08:00:00Z' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'scheduled' });
    });

    it('si con la hora nueva ya no da tiempo, el recordatorio nuevo nace skipped too_late', async () => {
      const created = await madridAppointment();
      // 22:30 en Madrid: la franja lleva el envío a las 09:00 (08:00Z), tras el inicio.
      await t.setClock('2027-03-10T21:30:00Z');
      const res = await patch(created.id, { startsAt: '2027-03-11T07:30:00Z' });
      expect(res.status).toBe(200);
      expect(
        appointmentBody(res).reminders.map((r) => [
          r.status,
          r.skipReason,
          r.scheduledFor,
        ]),
      ).toEqual([
        ['cancelled', null, '2027-03-27T09:00:00Z'],
        ['skipped', 'too_late', '2027-03-11T08:00:00Z'],
      ]);
    });

    it('una cita virtual se reprograma con la hora de Madrid', async () => {
      const clinic = await createClinic(t, { timezone: 'Atlantic/Canary' });
      const patient = await createPatient(t, clinic.id);
      const created = await createAppointment(
        t,
        clinic.id,
        patient.id,
        STARTS_AT,
        { virtual: true },
      );
      // 09:30 de Madrid el día anterior; en Canarias (08:30) caería en la franja.
      const res = await patch(created.id, { startsAt: '2027-03-11T08:30:00Z' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ virtual: true });
      expect(appointmentBody(res).reminders[1]).toMatchObject({
        status: 'pending',
        scheduledFor: '2027-03-10T08:30:00Z',
      });
    });

    it('varios PATCH a la vez sobre la misma cita dejan un solo pendiente', async () => {
      const created = await madridAppointment();
      const days = ['29', '30', '31'];
      const responses = await Promise.all(
        days.map((day) =>
          patch(created.id, { startsAt: `2027-03-${day}T08:00:00Z` }),
        ),
      );
      expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
      const got = await t.http.get(`/appointments/${created.id}`);
      const statuses = appointmentBody(got).reminders.map((r) => r.status);
      expect(statuses).toEqual([
        'cancelled',
        'cancelled',
        'cancelled',
        'pending',
      ]);
    });

    it('con una cita cancelada responde 409 { error }, aunque startsAt no sea futura', async () => {
      const created = await madridAppointment();
      await cancel(created.id).expect(200);
      for (const startsAt of ['2027-03-29T08:00:00Z', '2027-02-01T08:00:00Z']) {
        const res = await patch(created.id, { startsAt });
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: 'appointment is cancelled' });
      }
    });

    it.each([
      ['empieza justo ahora', STARTS_AT],
      ['empezó antes', '2027-03-28T09:00:00Z'],
    ])(
      'con una cita que %s responde 409 { error }, aunque startsAt no sea futura',
      async (_label, now) => {
        const created = await madridAppointment();
        await t.setClock(now);
        for (const startsAt of ['2027-04-01T08:00:00Z', NOW]) {
          const res = await patch(created.id, { startsAt });
          expect(res.status).toBe(409);
          expect(res.body).toEqual({
            error: 'appointment has already started',
          });
        }
      },
    );

    it.each([
      ['pasada', '2027-02-28T10:00:00Z'],
      ['igual a la hora del servicio', NOW],
    ])(
      'con startsAt %s responde 400 { error } y no cambia nada',
      async (_label, startsAt) => {
        const created = await madridAppointment();
        const res = await patch(created.id, { startsAt });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'startsAt must be in the future' });
        const got = await t.http.get(`/appointments/${created.id}`);
        expect(got.body).toEqual(created);
      },
    );

    it.each([
      ['que no existe', randomUUID()],
      ['que no es UUID', 'abc'],
    ])('con un id %s responde 404 { error }', async (_label, id) => {
      const res = await patch(id, { startsAt: '2027-03-29T08:00:00Z' });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'appointment not found' });
    });

    it.each([
      ['startsAt sin zona', { startsAt: '2027-03-29T10:00:00' }],
      ['startsAt que no es fecha', { startsAt: 'mañana' }],
      ['startsAt ausente', {}],
      ['startsAt a null', { startsAt: null }],
      ['startsAt como número', { startsAt: 1806307200000 }],
      ['startsAt sin fecha', { startsAt: '10:00:00Z' }],
      // Postgres lee el `+010000-…` de `toISOString()` como un offset: 500.
      [
        'startsAt que en UTC pasa al año 10000',
        { startsAt: '9999-12-31T23:30:00-01:00' },
      ],
    ])('con %s responde 400 { error }', async (_label, body) => {
      const created = await madridAppointment();
      const res = await patch(created.id, body);
      expect(res.status).toBe(400);
      expect(Object.keys(res.body)).toEqual(['error']);
    });

    it('valida el cuerpo antes de buscar la cita (400 antes que 404)', async () => {
      const res = await patch('abc', { startsAt: '2027-03-29T10:00:00' });
      expect(res.status).toBe(400);
      expect(Object.keys(res.body)).toEqual(['error']);
    });
  });

  describe('POST /appointments/{id}/cancel', () => {
    it('cancelar mientras un PATCH espera al job no pierde la hora nueva ni deja un pendiente', async () => {
      const created = await madridAppointment();
      // Hace de job: retiene el pendiente como si lo estuviera enviando.
      const job = await holdLock(transactions, (repos) =>
        repos.reminders.lockPendingByAppointment(created.id),
      );
      // El PATCH bloquea la cita y espera al pendiente; el cancelar llega después.
      const patching = patch(created.id, {
        startsAt: '2027-03-29T08:00:00Z',
      }).then((res) => res);
      await sleep(UNBLOCKED_MS);
      const cancelling = cancel(created.id).then((res) => res);
      await sleep(UNBLOCKED_MS);
      job.release();

      const [patched, cancelled] = await Promise.all([patching, cancelling]);
      await job.done;
      expect([patched.status, cancelled.status]).toEqual([200, 200]);
      const got = appointmentBody(
        await t.http.get(`/appointments/${created.id}`),
      );
      expect(got.status).toBe('cancelled');
      expect(got.startsAt).toBe('2027-03-29T08:00:00Z');
      expect(got.reminders.map((r) => r.status)).toEqual([
        'cancelled',
        'cancelled',
      ]);
    });

    it('cancela la cita y su pendiente y responde 200 con la cita', async () => {
      const created = await madridAppointment();
      const res = await cancel(created.id);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ...created,
        status: 'cancelled',
        reminders: [{ ...created.reminders[0], status: 'cancelled' }],
      });
      const got = await t.http.get(`/appointments/${created.id}`);
      expect(got.body).toEqual(res.body);
    });

    it('repetirlo responde 200 con la misma cita', async () => {
      const created = await madridAppointment();
      const first = await cancel(created.id).expect(200);
      const again = await cancel(created.id);
      expect(again.status).toBe(200);
      expect(again.body).toEqual(first.body);
    });

    it('un recordatorio que no está pendiente se queda como está', async () => {
      const clinic = await createClinic(t);
      const patient = await createPatient(t, clinic.id);
      await t.setClock('2027-03-10T21:30:00Z');
      const created = await createAppointment(
        t,
        clinic.id,
        patient.id,
        '2027-03-11T07:30:00Z',
      );
      expect(created.reminders[0]?.status).toBe('skipped');
      const res = await cancel(created.id).expect(200);
      expect(res.body).toEqual({
        ...created,
        status: 'cancelled',
        reminders: created.reminders,
      });
    });

    it.each(['confirmed', 'scheduled'] as const)(
      'cancela una cita %s',
      async (status) => {
        const created = await madridAppointment();
        await setStatus(created.id, status);
        const res = await cancel(created.id).expect(200);
        expect(res.body).toMatchObject({ status: 'cancelled' });
      },
    );

    it('cancela una cita que ya empezó (el contrato solo prevé 200 y 404)', async () => {
      const created = await madridAppointment();
      await t.setClock('2027-03-28T09:00:00Z');
      const res = await cancel(created.id);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'cancelled' });
    });

    it.each([
      ['que no existe', randomUUID()],
      ['que no es UUID', 'abc'],
    ])('con un id %s responde 404 { error }', async (_label, id) => {
      const res = await cancel(id);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'appointment not found' });
    });
  });
});

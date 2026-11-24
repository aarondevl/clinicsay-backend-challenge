import { setTimeout as sleep } from 'node:timers/promises';
import { IdGenerator } from '../src/application/ports/id-generator.js';
import { Transactions } from '../src/application/ports/transactions.js';
import type { Appointment } from '../src/domain/appointment.js';
import { cancelReminder, type Reminder } from '../src/domain/reminder.js';
import { startTestApp, type TestApp } from './support/app.js';
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

  /**
   * Abre una transacción que ejecuta `lock` y se queda con el bloqueo hasta
   * que se llame a `release`; entonces ejecuta `then` y confirma.
   */
  async function holdLock(
    lock: (
      repos: Parameters<Parameters<Transactions['run']>[0]>[0],
    ) => Promise<unknown>,
    then: (
      repos: Parameters<Parameters<Transactions['run']>[0]>[0],
    ) => Promise<void> = async () => {},
  ): Promise<{ release: () => void; done: Promise<void> }> {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const done = transactions.run(async (repos) => {
      await lock(repos);
      locked();
      await released;
      await then(repos);
    });
    // Si la transacción falla antes de bloquear, el test falla ya y no espera.
    await Promise.race([
      isLocked,
      done.then(() => {
        throw new Error('transaction finished without holding the lock');
      }),
    ]);
    return { release, done };
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
});

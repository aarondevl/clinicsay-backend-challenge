import { setTimeout as sleep } from 'node:timers/promises';
import { Logger } from '@nestjs/common';
import { ServiceUnavailableError } from '../src/application/errors.js';
import { Clock } from '../src/application/ports/clock.js';
import { MessageProvider } from '../src/application/ports/message-provider.js';
import type { Repositories } from '../src/application/ports/repositories.js';
import { Transactions } from '../src/application/ports/transactions.js';
import { RunReminderPass } from '../src/application/reminders/run-reminder-pass.js';
import type { Reminder } from '../src/domain/reminder.js';
import { ShutdownCoordinator } from '../src/http/shutdown-coordinator.js';
import {
  startTestApp,
  TEST_PROVIDER_PORT,
  type TestApp,
} from './support/app.js';
import {
  type AppointmentBody,
  type ClinicBody,
  createAppointment,
  createClinic,
  createPatient,
  type PatientBody,
  type ReminderBody,
} from './support/fixtures.js';
import { holdLock } from './support/locks.js';
import { type ResetServer, startResetServer } from './support/reset-server.js';
import { startTcpProxy, type TcpProxy } from './support/tcp-proxy.js';

// Hora del servicio al crear las citas.
const NOW = '2027-03-01T00:00:00Z';
// 10:00 de Madrid el día del cambio de horario (CEST).
const STARTS_AT = '2027-03-28T08:00:00Z';
// Envío previsto: 10:00 de Madrid del día anterior (CET), 23 h antes.
const T = '2027-03-27T09:00:00Z';
const T_PLUS_1_MIN = '2027-03-27T09:01:00Z';
const T_PLUS_6_MIN = '2027-03-27T09:06:00Z';
const PHONE = '+34600111222';
// Texto exacto de `openapi.yaml` con la fecha y la hora de Madrid.
const MADRID_TEXT =
  'Hola Ana, te recordamos tu cita en Clínica Dental Sonrisa el 28/03/2027 a las 10:00. Responde SI para confirmar o NO para cancelar.';

/** Resuelve `work`, o falla si tarda más de `ms` (por ejemplo, porque espera un bloqueo). */
async function within<V>(ms: number, work: Promise<V>): Promise<V> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`still waiting after ${ms} ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Espera a que `check` se cumpla, mirando cada 20 ms durante 5 s como mucho. */
async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 250; i++) {
    if (await check()) return;
    await sleep(20);
  }
  throw new Error('condition not met after 5 s');
}

describe('job de envío', () => {
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

  /** `POST /jobs/reminders/run` en `app`; comprueba el 200 y devuelve el cuerpo. */
  async function runJob(app: TestApp = t): Promise<unknown> {
    const res = await app.http.post('/jobs/reminders/run');
    expect(res.status).toBe(200);
    return res.body;
  }

  /** Recordatorios de la cita, leídos por la API. */
  async function remindersOf(id: string): Promise<ReminderBody[]> {
    const res = await t.http.get(`/appointments/${id}`).expect(200);
    // Límite con supertest: el cuerpo llega sin tipo y el 200 garantiza su forma.
    return (res.body as AppointmentBody).reminders;
  }

  /** El único recordatorio de una cita que no se ha reprogramado. */
  async function onlyReminder(id: string): Promise<ReminderBody> {
    const reminders = await remindersOf(id);
    expect(reminders).toHaveLength(1);
    const [reminder] = reminders;
    if (!reminder) throw new Error(`appointment ${id} has no reminder`);
    return reminder;
  }

  /**
   * Cita de una paciente de Madrid (Ana, `+34600111222`) creada por la API de
   * `app`, con el reloj en `NOW`, en su propia clínica salvo que se pase una.
   */
  async function madridAppointment(
    over: {
      app?: TestApp;
      clinic?: ClinicBody;
      patient?: Partial<Omit<PatientBody, 'id' | 'clinicId'>>;
      startsAt?: string;
    } = {},
  ): Promise<AppointmentBody> {
    const app = over.app ?? t;
    const clinic = over.clinic ?? (await createClinic(app));
    const patient = await createPatient(app, clinic.id, over.patient);
    return createAppointment(
      app,
      clinic.id,
      patient.id,
      over.startsAt ?? STARTS_AT,
    );
  }

  describe('repositorios', () => {
    const lockNextDue = (now: string, excludeIds: string[] = []) =>
      transactions.run((repos) =>
        repos.reminders.lockNextDue(new Date(now), excludeIds),
      );

    it('lockNextDue devuelve el pendiente cuando le toca, y null antes', async () => {
      const created = await madridAppointment();
      expect(await lockNextDue('2027-03-27T08:59:59Z')).toBeNull();
      expect(await lockNextDue(T)).toEqual<Reminder>({
        id: created.reminders[0]?.id ?? '',
        appointmentId: created.id,
        scheduledFor: new Date(T),
        status: 'pending',
        skipReason: null,
        attempts: 0,
        nextAttemptAt: new Date(T),
        sentAt: null,
        sentTo: null,
        sendSeq: null,
      });
    });

    it.each(['sent', 'failed', 'skipped', 'cancelled'] as const)(
      'lockNextDue no devuelve uno %s aunque conserve nextAttemptAt',
      async (status) => {
        await madridAppointment();
        const due = await lockNextDue(T);
        if (!due) throw new Error('no pending reminder');
        // Solo el filtro de estado lo deja fuera: la hora sí le tocaría.
        await transactions.run((repos) =>
          repos.reminders.update({ ...due, status }),
        );
        expect(await lockNextDue(T)).toBeNull();
      },
    );

    it('lockNextDue toma el de nextAttemptAt más antiguo, después por id, y se salta excludeIds', async () => {
      const clinic = await createClinic(t);
      // El primero en crearse (id menor) toca una hora más tarde.
      const later = await madridAppointment({
        clinic,
        startsAt: '2027-03-28T09:00:00Z',
      });
      const first = await madridAppointment({ clinic });
      const second = await madridAppointment({ clinic });
      const ids = [later, first, second].map((a) => a.reminders[0]?.id ?? '');
      const [laterId, firstId, secondId] = ids;

      const now = '2027-03-27T12:00:00Z';
      expect((await lockNextDue(now))?.id).toBe(firstId);
      expect((await lockNextDue(now, [firstId ?? '']))?.id).toBe(secondId);
      expect(
        (await lockNextDue(now, [firstId ?? '', secondId ?? '']))?.id,
      ).toBe(laterId);
      expect(await lockNextDue(now, ids)).toBeNull();
    });

    it('lockNextDue se salta, sin esperar, el que tiene bloqueado otra transacción', async () => {
      const clinic = await createClinic(t);
      const first = await madridAppointment({ clinic });
      const second = await madridAppointment({ clinic });
      let taken: Reminder | null = null;
      const held = await holdLock(transactions, async (repos) => {
        taken = await repos.reminders.lockNextDue(new Date(T), []);
      });
      try {
        expect(taken).toMatchObject({ id: first.reminders[0]?.id });
        const other = await within(1000, lockNextDue(T));
        expect(other?.id).toBe(second.reminders[0]?.id);
      } finally {
        held.release();
        await held.done;
      }
    });

    it('nextSendSequence da números enteros crecientes', async () => {
      const next = () =>
        transactions.run((repos) => repos.reminders.nextSendSequence());
      const a = await next();
      const b = await next();
      expect(Number.isInteger(a)).toBe(true);
      expect(b).toBeGreaterThan(a);
    });
  });

  describe('POST /jobs/reminders/run', () => {
    it('sin nada que enviar responde 200 { processed: 0 }', async () => {
      expect(await runJob()).toEqual({ processed: 0 });
    });

    it('envía a su hora: sent, attempts 1, sentAt T y el texto exacto con la clave del recordatorio', async () => {
      const created = await madridAppointment();
      await t.setClock(T);
      expect(await runJob()).toEqual({ processed: 1 });
      const reminder = await onlyReminder(created.id);
      expect(reminder).toEqual({
        id: created.reminders[0]?.id,
        scheduledFor: T,
        status: 'sent',
        attempts: 1,
        sentAt: T,
        skipReason: null,
      });
      expect(await t.provider.messages(PHONE)).toEqual([
        { text: MADRID_TEXT, idempotencyKey: reminder.id },
      ]);
      expect(await t.provider.requests(PHONE)).toEqual([
        { idempotencyKey: reminder.id, status: 202 },
      ]);
    });

    it('antes de su hora no se procesa', async () => {
      const created = await madridAppointment();
      await t.setClock('2027-03-27T08:59:59Z');
      expect(await runJob()).toEqual({ processed: 0 });
      expect(await onlyReminder(created.id)).toMatchObject({
        status: 'pending',
        attempts: 0,
      });
      expect(await t.provider.requests()).toEqual([]);
    });

    it('una segunda pasada no lo vuelve a enviar', async () => {
      await madridAppointment();
      await t.setClock(T);
      expect(await runJob()).toEqual({ processed: 1 });
      expect(await runJob()).toEqual({ processed: 0 });
      expect(await t.provider.requests(PHONE)).toHaveLength(1);
    });

    it('cada envío guarda sentTo y un sendSeq mayor que el anterior, en el orden en que salen', async () => {
      // Dos pacientes con el mismo teléfono: la respuesta irá al último envío.
      const clinic = await createClinic(t);
      const first = await madridAppointment({ clinic });
      const second = await madridAppointment({ clinic });
      await t.setClock(T);
      expect(await runJob()).toEqual({ processed: 2 });
      const [a, b] = await Promise.all(
        [first, second].map(async (appointment) => {
          const [stored] = await transactions.run((repos) =>
            repos.reminders.listByAppointment(appointment.id),
          );
          return stored;
        }),
      );
      expect(a).toMatchObject({ status: 'sent', sentTo: PHONE });
      expect(b).toMatchObject({ status: 'sent', sentTo: PHONE });
      expect(b?.sendSeq).toBeGreaterThan(a?.sendSeq ?? Infinity);
    });

    it('no espera el bloqueo de la cita: con un PATCH que la tiene bloqueada, envía sin deadlock', async () => {
      const created = await madridAppointment();
      await t.setClock(T);
      // Hace de PATCH: ya bloqueó la cita y después irá a por sus pendientes.
      const patch = await holdLock(
        transactions,
        (repos) => repos.appointments.lockById(created.id),
        async (repos) => {
          await repos.reminders.lockPendingByAppointment(created.id);
        },
      );
      try {
        expect(await within(2000, runJob())).toEqual({ processed: 1 });
      } finally {
        patch.release();
        await patch.done;
      }
      expect(await onlyReminder(created.id)).toMatchObject({ status: 'sent' });
    });

    it('trata los recordatorios de todas las clínicas, cada uno con la hora de su zona', async () => {
      const madrid = await madridAppointment();
      const canary = await createClinic(t, {
        name: 'Clínica Atlántico',
        timezone: 'Atlantic/Canary',
      });
      // 10:00 de Canarias (WEST) el día del cambio; envío el 27 a las 10:00 (WET).
      const canaryAppointment = await madridAppointment({
        clinic: canary,
        patient: { name: 'Luis', phone: '+34600333444' },
        startsAt: '2027-03-28T09:00:00Z',
      });
      await t.setClock('2027-03-27T10:00:00Z');
      expect(await runJob()).toEqual({ processed: 2 });
      expect(await onlyReminder(madrid.id)).toMatchObject({ status: 'sent' });
      expect(await onlyReminder(canaryAppointment.id)).toMatchObject({
        status: 'sent',
      });
      expect(
        (await t.provider.messages('+34600333444')).map((m) => m.text),
      ).toEqual([
        'Hola Luis, te recordamos tu cita en Clínica Atlántico el 28/03/2027 a las 10:00. Responde SI para confirmar o NO para cancelar.',
      ]);
    });

    it('una cita virtual de una clínica de Canarias lleva la hora de Madrid en el texto', async () => {
      const clinic = await createClinic(t, { timezone: 'Atlantic/Canary' });
      const patient = await createPatient(t, clinic.id);
      // 10:00 de Madrid y 09:00 de Canarias.
      await createAppointment(t, clinic.id, patient.id, STARTS_AT, {
        virtual: true,
      });
      await t.setClock(T);
      expect(await runJob()).toEqual({ processed: 1 });
      expect((await t.provider.messages(PHONE)).map((m) => m.text)).toEqual([
        MADRID_TEXT,
      ]);
    });

    it('503 → pending con attempts 1; al minuto, con la misma clave, sent con attempts 2', async () => {
      const created = await madridAppointment();
      await t.provider.rule(PHONE, 'unavailable', 1);
      await t.setClock(T);
      expect(await runJob()).toEqual({ processed: 1 });
      expect(await onlyReminder(created.id)).toMatchObject({
        status: 'pending',
        attempts: 1,
        sentAt: null,
      });

      await t.setClock('2027-03-27T09:00:59Z');
      expect(await runJob()).toEqual({ processed: 0 });

      await t.setClock(T_PLUS_1_MIN);
      expect(await runJob()).toEqual({ processed: 1 });
      const reminder = await onlyReminder(created.id);
      expect(reminder).toMatchObject({
        status: 'sent',
        attempts: 2,
        sentAt: T_PLUS_1_MIN,
        // El reintento mueve el próximo intento, no la hora prevista.
        scheduledFor: T,
      });
      expect(await t.provider.requests(PHONE)).toEqual([
        { idempotencyKey: reminder.id, status: 503 },
        { idempotencyKey: reminder.id, status: 202 },
      ]);
    });

    it('504 con la entrega perdida: el reintento usa la misma clave y el paciente lo recibe una vez', async () => {
      const created = await madridAppointment();
      await t.provider.rule(PHONE, 'lost-response', 1);
      await t.setClock(T);
      expect(await runJob()).toEqual({ processed: 1 });
      expect(await onlyReminder(created.id)).toMatchObject({
        status: 'pending',
        attempts: 1,
      });

      await t.setClock(T_PLUS_1_MIN);
      expect(await runJob()).toEqual({ processed: 1 });
      const reminder = await onlyReminder(created.id);
      expect(reminder).toMatchObject({
        status: 'sent',
        attempts: 2,
        sentAt: T_PLUS_1_MIN,
      });
      expect(await t.provider.messages(PHONE)).toHaveLength(1);
      expect(await t.provider.requests(PHONE)).toEqual([
        { idempotencyKey: reminder.id, status: 504 },
        { idempotencyKey: reminder.id, status: 200 },
      ]);
    });

    it('tres fallos → failed con attempts 3; el tercero no sale antes de T+6 min', async () => {
      const created = await madridAppointment();
      await t.provider.rule(PHONE, 'unavailable', 3);
      await t.setClock(T);
      expect(await runJob()).toEqual({ processed: 1 });
      await t.setClock(T_PLUS_1_MIN);
      expect(await runJob()).toEqual({ processed: 1 });
      expect(await onlyReminder(created.id)).toMatchObject({
        status: 'pending',
        attempts: 2,
      });

      // El 3.º va 5 minutos después del 2.º fallo, no del primero.
      await t.setClock('2027-03-27T09:05:59Z');
      expect(await runJob()).toEqual({ processed: 0 });

      await t.setClock(T_PLUS_6_MIN);
      expect(await runJob()).toEqual({ processed: 1 });
      expect(await onlyReminder(created.id)).toEqual({
        id: created.reminders[0]?.id,
        scheduledFor: T,
        status: 'failed',
        attempts: 3,
        sentAt: null,
        skipReason: null,
      });

      await t.setClock('2027-03-27T12:00:00Z');
      expect(await runJob()).toEqual({ processed: 0 });
      expect(await t.provider.requests(PHONE)).toHaveLength(3);
    });

    it('422 → failed con attempts 1 y sin más llamadas', async () => {
      const created = await madridAppointment();
      await t.provider.rule(PHONE, 'reject', 1);
      await t.setClock(T);
      expect(await runJob()).toEqual({ processed: 1 });
      expect(await onlyReminder(created.id)).toMatchObject({
        status: 'failed',
        attempts: 1,
        sentAt: null,
      });
      await t.setClock('2027-03-27T12:00:00Z');
      expect(await runJob()).toEqual({ processed: 0 });
      expect(await t.provider.requests(PHONE)).toEqual([
        { idempotencyKey: created.reminders[0]?.id, status: 422 },
      ]);
    });

    it('sin teléfono → skipped no_phone, sin llamar al proveedor', async () => {
      const created = await madridAppointment({ patient: { phone: null } });
      await t.setClock(T);
      expect(await runJob()).toEqual({ processed: 1 });
      expect(await onlyReminder(created.id)).toMatchObject({
        status: 'skipped',
        skipReason: 'no_phone',
        attempts: 0,
        sentAt: null,
      });
      expect(await t.provider.requests()).toEqual([]);
    });

    it('dado de baja → skipped opted_out, sin llamar al proveedor', async () => {
      const created = await madridAppointment({
        patient: { acceptsReminders: false },
      });
      await t.setClock(T);
      expect(await runJob()).toEqual({ processed: 1 });
      expect(await onlyReminder(created.id)).toMatchObject({
        status: 'skipped',
        skipReason: 'opted_out',
        attempts: 0,
      });
      expect(await t.provider.requests()).toEqual([]);
    });

    it('si la pasada llega cuando la cita ya empezó → skipped too_late, antes que no_phone', async () => {
      const created = await madridAppointment({ patient: { phone: null } });
      await t.setClock(STARTS_AT);
      expect(await runJob()).toEqual({ processed: 1 });
      expect(await onlyReminder(created.id)).toMatchObject({
        status: 'skipped',
        skipReason: 'too_late',
        attempts: 0,
      });
    });

    it('la cita empieza entre dos intentos → skipped too_late, conserva attempts y no vuelve a llamar', async () => {
      // 11:00 de Madrid: el envío del día anterior ya pasó y sale ahora mismo.
      await t.setClock('2027-03-10T10:00:00Z');
      const created = await madridAppointment({
        startsAt: '2027-03-10T10:00:30Z',
      });
      await t.provider.rule(PHONE, 'unavailable', 1);
      expect(await runJob()).toEqual({ processed: 1 });

      await t.setClock('2027-03-10T10:01:00Z');
      expect(await runJob()).toEqual({ processed: 1 });
      expect(await onlyReminder(created.id)).toMatchObject({
        status: 'skipped',
        skipReason: 'too_late',
        attempts: 1,
        sentAt: null,
      });
      expect(await t.provider.requests(PHONE)).toHaveLength(1);
    });

    describe('franja de silencio al enviar', () => {
      it('un primer intento que la pasada toma a las 21:00 no se envía: sigue pending y sale a las 09:00 siguientes', async () => {
        // 20:59:30 de Madrid (CET): el envío del día anterior ya pasó y queda
        // para ahora, todavía fuera de la franja.
        await t.setClock('2027-03-10T19:59:30Z');
        const created = await madridAppointment({
          startsAt: '2027-03-11T09:00:00Z',
        });
        expect(created.reminders[0]).toMatchObject({
          scheduledFor: '2027-03-10T19:59:30Z',
          status: 'pending',
        });

        // 21:00 en punto ya es franja: no se llama ni cuenta en `processed`.
        await t.setClock('2027-03-10T20:00:00Z');
        expect(await runJob()).toEqual({ processed: 0 });
        expect(await onlyReminder(created.id)).toMatchObject({
          scheduledFor: '2027-03-10T19:59:30Z',
          status: 'pending',
          attempts: 0,
          sentAt: null,
        });
        expect(await t.provider.requests()).toEqual([]);

        await t.setClock('2027-03-11T07:59:59Z');
        expect(await runJob()).toEqual({ processed: 0 });
        expect(await t.provider.requests()).toEqual([]);

        // 09:00 de Madrid.
        await t.setClock('2027-03-11T08:00:00Z');
        expect(await runJob()).toEqual({ processed: 1 });
        const reminder = await onlyReminder(created.id);
        expect(reminder).toEqual({
          id: created.reminders[0]?.id,
          // Como en un reintento, se mueve el próximo intento y no la hora prevista.
          scheduledFor: '2027-03-10T19:59:30Z',
          status: 'sent',
          attempts: 1,
          sentAt: '2027-03-11T08:00:00Z',
          skipReason: null,
        });
        expect(await t.provider.requests(PHONE)).toEqual([
          { idempotencyKey: reminder.id, status: 202 },
        ]);
      });

      it('un recordatorio acumulado que la pasada toma a las 23:00 espera a las 09:00 siguientes', async () => {
        const created = await madridAppointment();
        // 23:00 de Madrid (CET) del día del envío previsto (T, a las 10:00).
        await t.setClock('2027-03-27T22:00:00Z');
        expect(await runJob()).toEqual({ processed: 0 });
        expect(await onlyReminder(created.id)).toMatchObject({
          scheduledFor: T,
          status: 'pending',
          attempts: 0,
        });

        // Las 09:00 siguientes ya son de horario de verano (CEST): 07:00 UTC.
        await t.setClock('2027-03-28T06:59:59Z');
        expect(await runJob()).toEqual({ processed: 0 });
        expect(await t.provider.requests()).toEqual([]);

        await t.setClock('2027-03-28T07:00:00Z');
        expect(await runJob()).toEqual({ processed: 1 });
        const reminder = await onlyReminder(created.id);
        expect(reminder).toMatchObject({
          scheduledFor: T,
          status: 'sent',
          attempts: 1,
          sentAt: '2027-03-28T07:00:00Z',
        });
        expect(await t.provider.messages(PHONE)).toEqual([
          { text: MADRID_TEXT, idempotencyKey: reminder.id },
        ]);
      });

      it('si las 09:00 siguientes no quedan antes de la cita → skipped too_late, sin llamar al proveedor', async () => {
        // Cita a las 09:00 de Madrid; envío previsto el día anterior a las 09:00.
        const created = await madridAppointment({
          startsAt: '2027-03-11T08:00:00Z',
        });
        // 23:00 de Madrid: la siguiente apertura es la hora de la cita.
        await t.setClock('2027-03-10T22:00:00Z');
        expect(await runJob()).toEqual({ processed: 1 });
        expect(await onlyReminder(created.id)).toMatchObject({
          scheduledFor: '2027-03-10T08:00:00Z',
          status: 'skipped',
          skipReason: 'too_late',
          attempts: 0,
          sentAt: null,
        });
        expect(await t.provider.requests()).toEqual([]);
      });

      it('una cita virtual de una clínica de Canarias usa la franja de Madrid', async () => {
        const clinic = await createClinic(t, { timezone: 'Atlantic/Canary' });
        const patient = await createPatient(t, clinic.id);
        const created = await createAppointment(
          t,
          clinic.id,
          patient.id,
          STARTS_AT,
          { virtual: true },
        );
        // 21:30 de Madrid (franja) y 20:30 de Canarias (fuera de ella).
        await t.setClock('2027-03-27T20:30:00Z');
        expect(await runJob()).toEqual({ processed: 0 });
        expect(await onlyReminder(created.id)).toMatchObject({
          status: 'pending',
          attempts: 0,
        });
        expect(await t.provider.requests()).toEqual([]);

        // 09:00 de Madrid (CEST).
        await t.setClock('2027-03-28T07:00:00Z');
        expect(await runJob()).toEqual({ processed: 1 });
        expect(await onlyReminder(created.id)).toMatchObject({
          status: 'sent',
          sentAt: '2027-03-28T07:00:00Z',
        });
      });

      it('un reintento dentro de la franja sí se envía: no espera a las 09:00', async () => {
        await t.setClock('2027-03-10T19:59:30Z');
        const created = await madridAppointment({
          startsAt: '2027-03-11T09:00:00Z',
        });
        await t.provider.rule(PHONE, 'unavailable', 1);
        expect(await runJob()).toEqual({ processed: 1 });

        // 21:00:30 de Madrid: el reintento, un minuto después del 503.
        await t.setClock('2027-03-10T20:00:30Z');
        expect(await runJob()).toEqual({ processed: 1 });
        const reminder = await onlyReminder(created.id);
        expect(reminder).toMatchObject({
          status: 'sent',
          attempts: 2,
          sentAt: '2027-03-10T20:00:30Z',
        });
        expect(await t.provider.requests(PHONE)).toEqual([
          { idempotencyKey: reminder.id, status: 503 },
          { idempotencyKey: reminder.id, status: 202 },
        ]);
      });
    });

    it('5 pasadas concurrentes envían 10 recordatorios una sola vez', async () => {
      const clinic = await createClinic(t);
      const phones = Array.from({ length: 10 }, (_, i) => `+3460000000${i}`);
      const appointments: AppointmentBody[] = [];
      for (const phone of phones) {
        appointments.push(
          await madridAppointment({ clinic, patient: { phone } }),
        );
      }
      await t.setClock(T);

      const results = await Promise.all(
        Array.from({ length: 5 }, () => t.http.post('/jobs/reminders/run')),
      );
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
      // Límite con supertest: el cuerpo llega sin tipo y el 200 garantiza su forma.
      const bodies = results.map((r) => r.body as { processed: number });
      // Cada pasada cuenta solo lo que trató ella: entre todas, los 10.
      expect(bodies.reduce((sum, body) => sum + body.processed, 0)).toBe(10);
      for (const phone of phones) {
        expect(await t.provider.requests(phone)).toEqual([
          { idempotencyKey: expect.any(String), status: 202 },
        ]);
      }
      for (const appointment of appointments) {
        expect(await onlyReminder(appointment.id)).toMatchObject({
          status: 'sent',
          attempts: 1,
        });
      }
    });

    it('un error inesperado en un recordatorio no frena a los demás: sigue pending, sin contarse, y se registra con su id', async () => {
      const broken = await madridAppointment();
      const healthy = await madridAppointment({
        patient: { name: 'Luis', phone: '+34600333444' },
      });
      // Una zona que la API nunca acepta: `buildReminderText` lanza al ir a
      // enviarlo. Es el primero que toma la pasada (misma hora, id menor).
      await t.orm.em
        .getConnection()
        .execute(`update clinic set timezone = 'Nope/Zone' where id = ?`, [
          broken.clinicId,
        ]);
      const brokenId = broken.reminders[0]?.id;
      const errors = vi
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      try {
        await t.setClock(T);
        expect(await runJob()).toEqual({ processed: 1 });
        expect(await onlyReminder(broken.id)).toMatchObject({
          status: 'pending',
          attempts: 0,
        });
        expect(await onlyReminder(healthy.id)).toMatchObject({
          status: 'sent',
        });
        expect(errors).toHaveBeenCalledWith(
          expect.stringContaining(`reminder ${brokenId}`),
          expect.any(Error),
        );

        // La pasada siguiente lo vuelve a tomar primero y tampoco se queda en él.
        expect(await runJob()).toEqual({ processed: 0 });
        expect(await onlyReminder(broken.id)).toMatchObject({
          status: 'pending',
          attempts: 0,
        });
        expect(await t.provider.requests()).toHaveLength(1);
      } finally {
        errors.mockRestore();
      }
    });

    it('con la señal abortada no toma ningún recordatorio', async () => {
      const created = await madridAppointment();
      await t.setClock(T);
      const pass = t.app.get(RunReminderPass);
      expect(await pass.execute(AbortSignal.abort())).toEqual({ processed: 0 });
      expect(await onlyReminder(created.id)).toMatchObject({
        status: 'pending',
        attempts: 0,
      });
      expect(await t.provider.requests()).toEqual([]);
    });
  });

  describe('errores que cortan la pasada', () => {
    /** La pasada de la app con otras transacciones y un registro de errores propio. */
    function passWith(tx: Transactions, logger = { error: vi.fn() }) {
      return new RunReminderPass(
        tx,
        t.app.get(Clock),
        t.app.get(MessageProvider),
        logger,
      );
    }

    it('la base caída al confirmar un recordatorio corta la pasada (503) sin tomar el siguiente ni registrarlo como fallo suyo', async () => {
      const first = await madridAppointment();
      const second = await madridAppointment({
        patient: { name: 'Luis', phone: '+34600333444' },
      });
      await t.setClock(T);
      // Como si la conexión se cortara en el COMMIT: el proveedor ya lo recibió.
      class CommitFails extends Transactions {
        run<V>(work: (repos: Repositories) => Promise<V>): Promise<V> {
          return transactions.run(async (repos) => {
            await work(repos);
            throw new ServiceUnavailableError('database unavailable');
          });
        }
      }
      const logger = { error: vi.fn() };
      await expect(
        passWith(new CommitFails(), logger).execute(),
      ).rejects.toBeInstanceOf(ServiceUnavailableError);
      expect(await t.provider.requests()).toHaveLength(1);
      expect(logger.error).not.toHaveBeenCalled();
      for (const appointment of [first, second]) {
        expect(await onlyReminder(appointment.id)).toMatchObject({
          status: 'pending',
          attempts: 0,
        });
      }
    });

    it('un error antes de tomar ningún recordatorio corta la pasada en vez de repetirse sin fin', async () => {
      await madridAppointment();
      await t.setClock(T);
      const boom = new Error('lockNextDue failed');
      class LockFails extends Transactions {
        run<V>(): Promise<V> {
          return transactions.run(async () => {
            throw boom;
          });
        }
      }
      // Si la pasada no se corta, la señal la para al acabar el test.
      const stop = new AbortController();
      try {
        await expect(
          within(2000, passWith(new LockFails()).execute(stop.signal)),
        ).rejects.toBe(boom);
      } finally {
        stop.abort();
      }
    });
  });

  describe('sin conexión con el proveedor', () => {
    let offline: TestApp;
    let resetting: ResetServer;

    beforeAll(async () => {
      // Un servidor propio que corta cada conexión al aceptarla. Un puerto
      // recién liberado no vale: otro proceso puede ocuparlo y responder.
      resetting = await startResetServer();
      offline = await startTestApp({
        providerUrl: `http://127.0.0.1:${resetting.port}`,
      });
    });

    afterAll(async () => {
      await offline.close();
      await resetting.close();
    });

    it('un error de red se reintenta al minuto', async () => {
      await offline.setClock(NOW);
      const created = await madridAppointment({ app: offline });
      await offline.setClock(T);
      expect(await runJob(offline)).toEqual({ processed: 1 });
      expect(await onlyReminder(created.id)).toMatchObject({
        status: 'pending',
        attempts: 1,
        sentAt: null,
      });
      expect(await t.provider.requests()).toEqual([]);

      // El reintento lo hace una instancia que sí llega al proveedor.
      await t.setClock('2027-03-27T09:00:59Z');
      expect(await runJob()).toEqual({ processed: 0 });
      await t.setClock(T_PLUS_1_MIN);
      expect(await runJob()).toEqual({ processed: 1 });
      expect(await onlyReminder(created.id)).toMatchObject({
        status: 'sent',
        attempts: 2,
        sentAt: T_PLUS_1_MIN,
      });
    });
  });

  describe('proveedor que no responde a tiempo', () => {
    let proxy: TcpProxy;
    let slow: TestApp;

    beforeAll(async () => {
      proxy = await startTcpProxy('127.0.0.1', TEST_PROVIDER_PORT);
      slow = await startTestApp({
        providerUrl: `http://127.0.0.1:${proxy.port}`,
        providerTimeoutMs: 300,
      });
    });

    afterAll(async () => {
      await slow.close();
      await proxy.close();
    });

    afterEach(() => {
      proxy.dropResponses(false);
    });

    it('sin respuesta en providerTimeoutMs se reintenta con la misma clave y el paciente lo recibe una vez', async () => {
      await slow.setClock(NOW);
      const created = await madridAppointment({ app: slow });
      await slow.setClock(T);
      // El proveedor lo entrega, pero la respuesta no llega nunca.
      proxy.dropResponses(true);
      // Sin el timeout esperaría para siempre: el proxy no deja ver ni el cierre.
      expect(await within(3000, runJob(slow))).toEqual({ processed: 1 });
      expect(await onlyReminder(created.id)).toMatchObject({
        status: 'pending',
        attempts: 1,
        sentAt: null,
      });
      expect(await t.provider.messages(PHONE)).toHaveLength(1);

      proxy.dropResponses(false);
      await slow.setClock(T_PLUS_1_MIN);
      expect(await runJob(slow)).toEqual({ processed: 1 });
      const reminder = await onlyReminder(created.id);
      expect(reminder).toMatchObject({ status: 'sent', attempts: 2 });
      expect(await t.provider.messages(PHONE)).toHaveLength(1);
      expect(await t.provider.requests(PHONE)).toEqual([
        { idempotencyKey: reminder.id, status: 202 },
        { idempotencyKey: reminder.id, status: 200 },
      ]);
    });

    it('un PATCH que llega mientras el job espera al proveedor espera y ve el estado final', async () => {
      await slow.setClock(NOW);
      const created = await madridAppointment({ app: slow });
      await slow.setClock(T);
      proxy.dropResponses(true);
      const job = runJob(slow);
      // El job tiene el recordatorio bloqueado y espera la respuesta.
      await until(async () => (await t.provider.requests(PHONE)).length > 0);
      const patched = await slow.http
        .patch(`/appointments/${created.id}`)
        .send({ startsAt: '2027-03-29T08:00:00Z' });
      expect(await job).toEqual({ processed: 1 });
      expect(patched.status).toBe(200);
      // El PATCH canceló el pendiente con el intento que guardó el job.
      // Límite con supertest: el cuerpo llega sin tipo y el 200 garantiza su forma.
      const reminders = (patched.body as AppointmentBody).reminders;
      expect(reminders.map((r) => [r.status, r.attempts])).toEqual([
        ['cancelled', 1],
        ['pending', 0],
      ]);
    });
  });

  describe('cierre ordenado', () => {
    const OTHER_PHONE = '+34600333444';

    // Con `close()` no se ve que el cierre espere a la pasada, porque
    // `server.close()` espera a la petición en curso y el pool de `pg` a que
    // la transacción suelte su conexión. Por eso el segundo test llama al
    // coordinador directamente.
    it('al cerrar la app, la pasada en curso termina su recordatorio y no toma más', async () => {
      // El proveedor recibe las peticiones pero no responde: la pasada se
      // queda esperando 1 s con el primer recordatorio.
      const proxy = await startTcpProxy('127.0.0.1', TEST_PROVIDER_PORT);
      const closing = await startTestApp({
        providerUrl: `http://127.0.0.1:${proxy.port}`,
        providerTimeoutMs: 1000,
      });
      let closed = false;
      let first: AppointmentBody;
      let second: AppointmentBody;
      try {
        await closing.setClock(NOW);
        const clinic = await createClinic(closing);
        first = await madridAppointment({ app: closing, clinic });
        second = await madridAppointment({
          app: closing,
          clinic,
          patient: { phone: OTHER_PHONE },
        });
        await closing.setClock(T);
        proxy.dropResponses(true);

        const running = closing.http
          .post('/jobs/reminders/run')
          .then((res) => res);
        await until(async () => (await t.provider.requests(PHONE)).length > 0);
        await closing.close();
        closed = true;

        const res = await running;
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ processed: 1 });
      } finally {
        if (!closed) await closing.close();
        await proxy.close();
      }
      // Guardó el intento del primero antes de cerrar la base y no tomó el segundo.
      expect(await onlyReminder(first.id)).toMatchObject({
        status: 'pending',
        attempts: 1,
      });
      expect(await onlyReminder(second.id)).toMatchObject({
        status: 'pending',
        attempts: 0,
      });
      expect(await t.provider.requests(OTHER_PHONE)).toEqual([]);
    });

    it('el coordinador espera a la pasada que lanzó el controlador antes de dejar cerrar', async () => {
      // Sin cerrar el servidor HTTP ni la base, lo único que puede hacer
      // esperar al coordinador es que el controlador le registrara la pasada.
      const proxy = await startTcpProxy('127.0.0.1', TEST_PROVIDER_PORT);
      const waiting = await startTestApp({
        providerUrl: `http://127.0.0.1:${proxy.port}`,
        providerTimeoutMs: 1000,
      });
      try {
        await waiting.setClock(NOW);
        const created = await madridAppointment({ app: waiting });
        await waiting.setClock(T);
        proxy.dropResponses(true);

        const running = waiting.http
          .post('/jobs/reminders/run')
          .then((res) => res);
        await until(async () => (await t.provider.requests(PHONE)).length > 0);
        await waiting.app.get(ShutdownCoordinator).beforeApplicationShutdown();
        // Sin esperar, la pasada seguiría con el proveedor y el intento sin
        // confirmar (attempts 0).
        expect(await onlyReminder(created.id)).toMatchObject({
          status: 'pending',
          attempts: 1,
        });
        const res = await running;
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ processed: 1 });
      } finally {
        await waiting.close();
        await proxy.close();
      }
    });

    it('createApp escucha SIGTERM para cerrar la app, y close() deja de escucharlo', async () => {
      const before = process.listenerCount('SIGTERM');
      const started = await startTestApp();
      try {
        expect(process.listenerCount('SIGTERM')).toBe(before + 1);
      } finally {
        await started.close();
      }
      expect(process.listenerCount('SIGTERM')).toBe(before);
    });
  });
});

import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Transactions } from '../src/application/ports/transactions.js';
import type { Appointment } from '../src/domain/appointment.js';
import { recordAttempt, type Reminder } from '../src/domain/reminder.js';
import { startTestApp, type TestApp } from './support/app.js';
import {
  type AppointmentBody,
  type ClinicBody,
  createAppointment,
  createClinic,
  createPatient,
} from './support/fixtures.js';
import { holdLock } from './support/locks.js';

// Hora del servicio al crear las citas.
const NOW = '2027-03-01T00:00:00Z';
// 10:00 de Madrid el día del cambio de horario (CEST).
const STARTS_AT = '2027-03-28T08:00:00Z';
// Envío previsto: 10:00 de Madrid del día anterior (CET).
const T = '2027-03-27T09:00:00Z';
const PHONE = '+34600111222';
const OTHER_PHONE = '+34600999888';

/** Lo que tarda como mucho una consulta sin bloqueo en la base de los e2e. */
const UNBLOCKED_MS = 200;

/** Cuerpo de `POST /webhooks/inbound-messages` según `openapi.yaml`. */
type InboundBody = {
  messageId: string;
  from: string;
  text: string;
  receivedAt: string;
};

describe('webhook de respuestas', () => {
  let t: TestApp;
  let transactions: Transactions;
  let messageSeq = 0;

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

  /** `POST /webhooks/inbound-messages` desde `PHONE`, con un `messageId` nuevo salvo que se pase. */
  function reply(text: string, over: Partial<InboundBody> = {}) {
    messageSeq += 1;
    return t.http.post('/webhooks/inbound-messages').send({
      messageId: `msg-${messageSeq}`,
      from: PHONE,
      text,
      receivedAt: T,
      ...over,
    });
  }

  /** Como `reply`, pero comprueba el 200. */
  async function replyOk(
    text: string,
    over: Partial<InboundBody> = {},
  ): Promise<void> {
    await reply(text, over).expect(200);
  }

  /** La cita leída por la API. */
  async function appointment(id: string): Promise<AppointmentBody> {
    const res = await t.http.get(`/appointments/${id}`).expect(200);
    // Límite con supertest: el cuerpo llega sin tipo y el 200 garantiza su forma.
    return res.body as AppointmentBody;
  }

  /** Estado de la cita y de sus recordatorios, leídos por la API. */
  async function statesOf(
    id: string,
  ): Promise<{ status: string; reminders: string[] }> {
    const got = await appointment(id);
    return {
      status: got.status,
      reminders: got.reminders.map((r) => r.status),
    };
  }

  /** Una pasada del job (`POST /jobs/reminders/run`); devuelve `processed`. */
  async function runJob(): Promise<number> {
    const res = await t.http.post('/jobs/reminders/run').expect(200);
    // Límite con supertest: el cuerpo llega sin tipo y el 200 garantiza su forma.
    return (res.body as { processed: number }).processed;
  }

  /** Cita de un paciente nuevo de `clinic` con `phone`, creada a la hora actual del servicio. */
  async function book(
    clinic: ClinicBody,
    startsAt = STARTS_AT,
    phone = PHONE,
  ): Promise<AppointmentBody> {
    const patient = await createPatient(t, clinic.id, { phone });
    return createAppointment(t, clinic.id, patient.id, startsAt);
  }

  /** Cita de Madrid con su recordatorio ya enviado a `PHONE` por el job; deja el reloj en `T`. */
  async function sentAppointment(): Promise<AppointmentBody> {
    const created = await book(await createClinic(t));
    await t.setClock(T);
    expect(await runJob()).toBe(1);
    expect((await statesOf(created.id)).reminders).toEqual(['sent']);
    return created;
  }

  describe('repositorios', () => {
    const insertIfNew = (messageId: string, receivedAt = T) =>
      transactions.run((repos) =>
        repos.inboundMessages.insertIfNew(messageId, new Date(receivedAt)),
      );

    it('insertIfNew guarda el mensaje la primera vez y devuelve false con el mismo messageId', async () => {
      expect(await insertIfNew('m-1')).toBe(true);
      expect(await insertIfNew('m-1', '2027-03-27T10:00:00Z')).toBe(false);
      expect(await insertIfNew('m-2')).toBe(true);

      const rows = await t.orm.em
        .getConnection()
        .execute<{ message_id: string; received_at: Date | string }[]>(
          'select message_id, received_at from inbound_message order by message_id',
        );
      expect(
        rows.map((r) => [r.message_id, new Date(r.received_at).toISOString()]),
      ).toEqual([
        ['m-1', '2027-03-27T09:00:00.000Z'],
        ['m-2', '2027-03-27T09:00:00.000Z'],
      ]);
    });

    it('insertIfNew espera a otra transacción con el mismo messageId y devuelve false cuando confirma', async () => {
      const first = await holdLock(transactions, (repos) =>
        repos.inboundMessages.insertIfNew('m-1', new Date(T)),
      );
      const events: string[] = [];
      const second = insertIfNew('m-1').then((inserted) => {
        events.push('second done');
        return inserted;
      });
      await sleep(UNBLOCKED_MS);
      events.push('first released');
      first.release();

      const [, inserted] = await Promise.all([first.done, second]);
      expect(events).toEqual(['first released', 'second done']);
      expect(inserted).toBe(false);
    });

    it('lockLatestRepliable devuelve la cita entera del último envío a ese teléfono, o null', async () => {
      const created = await sentAppointment();
      const lock = (phone: string) =>
        transactions.run((repos) =>
          repos.appointments.lockLatestRepliable(phone, new Date(T)),
        );
      expect(await lock(PHONE)).toEqual<Appointment>({
        id: created.id,
        clinicId: created.clinicId,
        patientId: created.patientId,
        startsAt: new Date(STARTS_AT),
        status: 'scheduled',
        virtual: false,
      });
      expect(await lock(OTHER_PHONE)).toBeNull();
    });
  });

  describe('POST /webhooks/inbound-messages', () => {
    it('SI confirma la cita y responde 200', async () => {
      const created = await sentAppointment();
      await replyOk('Sí');
      expect(await statesOf(created.id)).toEqual({
        status: 'confirmed',
        reminders: ['sent'],
      });
    });

    it('NO cancela la cita y su recordatorio pendiente', async () => {
      const created = await sentAppointment();
      // Reprogramar tras el envío deja el enviado sent y crea otro pendiente.
      await t.http
        .patch(`/appointments/${created.id}`)
        .send({ startsAt: '2027-03-29T08:00:00Z' })
        .expect(200);
      expect((await statesOf(created.id)).reminders).toEqual([
        'sent',
        'pending',
      ]);

      await replyOk('NO!');
      expect(await statesOf(created.id)).toEqual({
        status: 'cancelled',
        reminders: ['sent', 'cancelled'],
      });
    });

    it('NO después de SI cancela la cita confirmada', async () => {
      const created = await sentAppointment();
      await replyOk('si');
      await replyOk('no');
      expect((await statesOf(created.id)).status).toBe('cancelled');
    });

    it('el mismo messageId solo se procesa una vez', async () => {
      const created = await sentAppointment();
      await replyOk('SI', { messageId: 'm-1' });
      expect((await statesOf(created.id)).status).toBe('confirmed');
      // Reprogramar la devuelve a scheduled; el SI repetido no la vuelve a confirmar.
      await t.http
        .patch(`/appointments/${created.id}`)
        .send({ startsAt: '2027-03-29T08:00:00Z' })
        .expect(200);
      await replyOk('SI', { messageId: 'm-1' });
      expect((await statesOf(created.id)).status).toBe('scheduled');
    });

    it('un messageId repetido no hace nada aunque la primera vez se ignorara', async () => {
      const created = await book(await createClinic(t));
      // Aún no se ha enviado nada a ese teléfono: se ignora, pero queda registrado.
      await replyOk('SI', { messageId: 'm-1' });
      await t.setClock(T);
      expect(await runJob()).toBe(1);

      await replyOk('SI', { messageId: 'm-1' });
      expect((await statesOf(created.id)).status).toBe('scheduled');
    });

    it('SI y luego reprogramar deja la cita scheduled', async () => {
      const created = await sentAppointment();
      await replyOk('SI');
      await t.http
        .patch(`/appointments/${created.id}`)
        .send({ startsAt: '2027-03-29T08:00:00Z' })
        .expect(200);
      expect((await statesOf(created.id)).status).toBe('scheduled');
    });

    it('acepta un messageId de 255 caracteres de 7 bytes y lo deduplica', async () => {
      const created = await sentAppointment();
      // El caso más largo en UTF-8 que cuenta `@MaxLength`: emoji (4 bytes)
      // más selector de variante (3 bytes) por carácter, unos 1,8 kB.
      const messageId = '😀\u{FE0F}'.repeat(255);
      await replyOk('SI', { messageId });
      await replyOk('NO', { messageId });
      expect((await statesOf(created.id)).status).toBe('confirmed');
    });

    it('un text con NUL se ignora con 200: no llega a la base', async () => {
      const created = await sentAppointment();
      await replyOk('S\u0000I');
      expect((await statesOf(created.id)).status).toBe('scheduled');
    });

    it('«Sí, gracias» se ignora con 200', async () => {
      const created = await sentAppointment();
      await replyOk('Sí, gracias');
      expect((await statesOf(created.id)).status).toBe('scheduled');
    });

    it('teléfono sin citas → 200 y nada cambia', async () => {
      const created = await sentAppointment();
      await replyOk('NO', { from: OTHER_PHONE });
      expect(await statesOf(created.id)).toEqual({
        status: 'scheduled',
        reminders: ['sent'],
      });
    });

    it('un from que no es E.164 → 200 y se ignora', async () => {
      const created = await sentAppointment();
      await replyOk('NO', { from: 'not a phone' });
      expect((await statesOf(created.id)).status).toBe('scheduled');
    });

    it('un from con SQL no altera la consulta', async () => {
      const created = await sentAppointment();
      await replyOk('NO', { from: "x' or '1'='1" });
      expect((await statesOf(created.id)).status).toBe('scheduled');
    });

    it('solo cuentan los recordatorios ya enviados a ese teléfono', async () => {
      const clinic = await createClinic(t);
      const created = await book(clinic);
      // El paciente tiene ese teléfono, pero su recordatorio sigue pendiente.
      await replyOk('NO');
      expect(await statesOf(created.id)).toEqual({
        status: 'scheduled',
        reminders: ['pending'],
      });
    });

    it('teléfono compartido en la misma pasada: aplica a la última enviada', async () => {
      const clinic = await createClinic(t);
      const a = await book(clinic);
      const b = await book(clinic);
      await t.setClock(T);
      // Una pasada envía las dos con el mismo sentAt; A sale antes (id menor).
      expect(await runJob()).toBe(2);
      const [sentA, sentB] = [await appointment(a.id), await appointment(b.id)];
      expect(sentA.reminders[0]?.sentAt).toBe(sentB.reminders[0]?.sentAt);

      await replyOk('NO');
      expect((await statesOf(b.id)).status).toBe('cancelled');
      expect((await statesOf(a.id)).status).toBe('scheduled');
    });

    it('teléfono compartido: decide el orden de envío, no el de creación', async () => {
      const clinic = await createClinic(t);
      // X se crea antes, pero su recordatorio toca una hora más tarde (10:00Z).
      const x = await book(clinic, '2027-03-28T09:00:00Z');
      const y = await book(clinic);
      await t.setClock('2027-03-27T10:00:00Z');
      // La pasada envía Y (09:00Z) y después X (10:00Z), con el mismo sentAt.
      expect(await runJob()).toBe(2);

      await replyOk('NO');
      expect((await statesOf(x.id)).status).toBe('cancelled');
      expect((await statesOf(y.id)).status).toBe('scheduled');
    });

    it('decide el número de envío aunque sentAt vaya hacia atrás', async () => {
      // Con varias réplicas, sentAt sale del reloj de cada una y puede no
      // crecer; aquí se reproduce moviendo el reloj de test hacia atrás.
      const clinic = await createClinic(t);
      const first = await book(clinic);
      await t.setClock(T);
      expect(await runJob()).toBe(1);
      // 09:30 de Madrid: la cita nace con la hora de envío ya pasada y sale ahora.
      await t.setClock('2027-03-27T08:30:00Z');
      const second = await book(clinic, '2027-03-27T12:00:00Z');
      expect(await runJob()).toBe(1);
      expect((await appointment(second.id)).reminders[0]?.sentAt).toBe(
        '2027-03-27T08:30:00Z',
      );

      await replyOk('NO');
      expect((await statesOf(second.id)).status).toBe('cancelled');
      expect((await statesOf(first.id)).status).toBe('scheduled');
    });

    it('ignora una cita que ya empezó y cae en la anterior', async () => {
      // 10:00 de Madrid: las dos citas se crean con la hora de envío ya pasada,
      // así que su recordatorio toca ahora.
      await t.setClock(T);
      const clinic = await createClinic(t);
      const later = await book(clinic, '2027-03-27T20:00:00Z');
      expect(await runJob()).toBe(1);
      const sooner = await book(clinic, '2027-03-27T12:00:00Z');
      expect(await runJob()).toBe(1);

      // La última enviada empieza justo ahora: ya no puede recibir la respuesta.
      await t.setClock('2027-03-27T12:00:00Z');
      await replyOk('NO');
      expect((await statesOf(sooner.id)).status).toBe('scheduled');
      expect((await statesOf(later.id)).status).toBe('cancelled');
    });

    it('ignora una cita cancelada y cae en la anterior', async () => {
      const clinic = await createClinic(t);
      const a = await book(clinic);
      const b = await book(clinic);
      await t.setClock(T);
      expect(await runJob()).toBe(2);
      await t.http.post(`/appointments/${b.id}/cancel`).expect(200);

      await replyOk('SI');
      expect((await statesOf(b.id)).status).toBe('cancelled');
      expect((await statesOf(a.id)).status).toBe('confirmed');
    });

    it('«ya empezó» se mira con la hora del servicio, no con receivedAt', async () => {
      const created = await sentAppointment();
      // El reloj sigue en T, antes del inicio, aunque el mensaje diga otra hora.
      await replyOk('SI', { receivedAt: '2027-03-28T09:00:00Z' });
      expect((await statesOf(created.id)).status).toBe('confirmed');
    });

    it('un SI que espera a que cancelen la última cita no la confirma y va a la anterior', async () => {
      const clinic = await createClinic(t);
      const a = await book(clinic);
      const b = await book(clinic);
      await t.setClock(T);
      expect(await runJob()).toBe(2);
      // Hace de cancelar: retiene la cita B y la cancela al soltarla.
      const cancelling = await holdLock(
        transactions,
        (repos) => repos.appointments.lockById(b.id),
        async (repos) => {
          const stored = await repos.appointments.findById(b.id);
          if (!stored) throw new Error(`appointment ${b.id} not stored`);
          await repos.appointments.update({ ...stored, status: 'cancelled' });
        },
      );

      const events: string[] = [];
      const replying = reply('SI').then((res) => {
        events.push('replied');
        return res;
      });
      await sleep(UNBLOCKED_MS);
      events.push('cancel released');
      cancelling.release();

      const [res] = await Promise.all([replying, cancelling.done]);
      expect(res.status).toBe(200);
      expect(events).toEqual(['cancel released', 'replied']);
      expect((await statesOf(b.id)).status).toBe('cancelled');
      expect((await statesOf(a.id)).status).toBe('confirmed');
    });

    it('un NO mientras el job envía el pendiente lo espera y no pisa el envío', async () => {
      const created = await sentAppointment();
      await t.http
        .patch(`/appointments/${created.id}`)
        .send({ startsAt: '2027-03-29T08:00:00Z' })
        .expect(200);
      // Hace de job: retiene el pendiente y lo deja enviado al soltarlo.
      let pending: Reminder | undefined;
      const job = await holdLock(
        transactions,
        async (repos) => {
          [pending] = await repos.reminders.lockPendingByAppointment(
            created.id,
          );
        },
        async (repos) => {
          if (!pending) throw new Error('no pending reminder');
          const sendSeq = await repos.reminders.nextSendSequence();
          await repos.reminders.update(
            recordAttempt(pending, 'delivered', {
              now: new Date(T),
              to: PHONE,
              sendSeq,
            }),
          );
        },
      );

      const events: string[] = [];
      const replying = reply('NO').then((res) => {
        events.push('replied');
        return res;
      });
      await sleep(UNBLOCKED_MS);
      events.push('job released');
      job.release();

      const [res] = await Promise.all([replying, job.done]);
      expect(res.status).toBe(200);
      expect(events).toEqual(['job released', 'replied']);
      expect(await statesOf(created.id)).toEqual({
        status: 'cancelled',
        reminders: ['sent', 'sent'],
      });
    });

    const valid: InboundBody = {
      messageId: 'm-1',
      from: PHONE,
      text: 'SI',
      receivedAt: T,
    };
    /** `valid` sin el campo `key`. */
    const without = (key: keyof InboundBody): Partial<InboundBody> => {
      const body: Partial<InboundBody> = { ...valid };
      delete body[key];
      return body;
    };

    it.each<[string, object]>([
      ['sin messageId', without('messageId')],
      ['sin from', without('from')],
      ['sin text', without('text')],
      ['sin receivedAt', without('receivedAt')],
      ['vacío', {}],
      ['que es una lista', [valid]],
      ['con messageId numérico', { ...valid, messageId: 1 }],
      ['con from numérico', { ...valid, from: 34600111222 }],
      ['con text null', { ...valid, text: null }],
      [
        'con receivedAt sin zona',
        { ...valid, receivedAt: '2027-03-27T09:00:00' },
      ],
      ['con receivedAt que no es una fecha', { ...valid, receivedAt: 'ayer' }],
      // Lo que sigue pasaba el DTO y Postgres lo rechazaba: 500, y el
      // proveedor reenviaría el mensaje sin fin.
      ['con messageId con NUL', { ...valid, messageId: 'a\u0000b' }],
      ['con from con NUL', { ...valid, from: `${PHONE}\u0000` }],
      [
        'con messageId de más de 255 caracteres',
        { ...valid, messageId: 'a'.repeat(256) },
      ],
      [
        // Aleatorio para que Postgres no lo comprima: pasa de los 2704 bytes
        // de una clave btree.
        'con messageId de 2800 caracteres aleatorios',
        { ...valid, messageId: randomBytes(1400).toString('hex') },
      ],
      [
        'con from de más de 200 caracteres',
        { ...valid, from: '+'.repeat(201) },
      ],
      [
        'con receivedAt en el año 0',
        { ...valid, receivedAt: '0000-01-01T00:00:00Z' },
      ],
      [
        'con receivedAt que en UTC pasa al año 10000',
        { ...valid, receivedAt: '9999-12-31T23:30:00-01:00' },
      ],
    ])('un cuerpo %s → 400 { error }', async (_label, body) => {
      const created = await sentAppointment();
      const res = await t.http
        .post('/webhooks/inbound-messages')
        .send(body)
        .expect(400);
      expect(res.body).toEqual({ error: expect.any(String) });
      expect((await statesOf(created.id)).status).toBe('scheduled');
    });
  });
});

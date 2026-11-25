import {
  cancelReminder,
  holdForQuietHours,
  newReminder,
  postponeReminder,
  recordAttempt,
  type Reminder,
  skipReasonAtSendTime,
  skipReminder,
} from './reminder.js';

const ID = '019a0000-0000-7000-8000-000000000001';
const APPOINTMENT_ID = '019a0000-0000-7000-8000-000000000002';

describe('newReminder', () => {
  it('con un plan a tiempo crea un recordatorio pendiente que toca a su hora', () => {
    const scheduledFor = new Date('2027-03-27T09:00:00Z');
    expect(
      newReminder(ID, APPOINTMENT_ID, { scheduledFor, skipReason: null }),
    ).toEqual({
      id: ID,
      appointmentId: APPOINTMENT_ID,
      scheduledFor,
      status: 'pending',
      skipReason: null,
      attempts: 0,
      nextAttemptAt: scheduledFor,
      sentAt: null,
      sentTo: null,
      sendSeq: null,
    });
  });

  it('con un plan too_late lo crea ya descartado y sin próximo intento', () => {
    const scheduledFor = new Date('2027-03-11T08:00:00Z');
    expect(
      newReminder(ID, APPOINTMENT_ID, {
        scheduledFor,
        skipReason: 'too_late',
      }),
    ).toEqual({
      id: ID,
      appointmentId: APPOINTMENT_ID,
      scheduledFor,
      status: 'skipped',
      skipReason: 'too_late',
      attempts: 0,
      nextAttemptAt: null,
      sentAt: null,
      sentTo: null,
      sendSeq: null,
    });
  });
});

describe('cancelReminder', () => {
  const scheduledFor = new Date('2027-03-27T09:00:00Z');
  /** Pendiente nuevo en cada llamada, para que un test no contamine a otro. */
  const pending = (): Reminder => ({
    id: ID,
    appointmentId: APPOINTMENT_ID,
    scheduledFor,
    status: 'pending',
    skipReason: null,
    attempts: 1,
    nextAttemptAt: new Date('2027-03-27T09:01:00Z'),
    sentAt: null,
    sentTo: null,
    sendSeq: null,
  });

  it('un pendiente queda cancelled, sin próximo intento y con sus intentos', () => {
    expect(cancelReminder(pending())).toEqual({
      ...pending(),
      status: 'cancelled',
      nextAttemptAt: null,
    });
  });

  it('no modifica el recordatorio recibido', () => {
    const original = pending();
    cancelReminder(original);
    expect(original).toEqual(pending());
  });

  it.each<Reminder>([
    {
      ...pending(),
      status: 'sent',
      nextAttemptAt: null,
      sentAt: new Date('2027-03-27T09:00:00Z'),
      sentTo: '+34600111222',
      sendSeq: 3,
    },
    { ...pending(), status: 'failed', attempts: 3, nextAttemptAt: null },
    {
      ...pending(),
      status: 'skipped',
      skipReason: 'too_late',
      nextAttemptAt: null,
    },
    { ...pending(), status: 'cancelled', nextAttemptAt: null },
  ])('uno $status se queda como está', (reminder) => {
    expect(cancelReminder(reminder)).toEqual(reminder);
  });
});

describe('skipReasonAtSendTime', () => {
  const now = new Date('2027-03-27T09:00:00Z');
  const ready = {
    startsAt: new Date('2027-03-28T08:00:00Z'),
    now,
    phone: '+34600111222',
    acceptsReminders: true,
  };

  it('con la cita por empezar, teléfono y sin baja no hay motivo para descartarlo', () => {
    expect(skipReasonAtSendTime(ready)).toBeNull();
  });

  it('una cita que ya empezó es too_late', () => {
    expect(
      skipReasonAtSendTime({
        ...ready,
        startsAt: new Date('2027-03-27T08:59:59Z'),
      }),
    ).toBe('too_late');
  });

  it('una cita que empieza justo ahora es too_late', () => {
    expect(skipReasonAtSendTime({ ...ready, startsAt: now })).toBe('too_late');
  });

  it('una cita que empieza un milisegundo después todavía se envía', () => {
    expect(
      skipReasonAtSendTime({
        ...ready,
        startsAt: new Date('2027-03-27T09:00:00.001Z'),
      }),
    ).toBeNull();
  });

  it('sin teléfono es no_phone', () => {
    expect(skipReasonAtSendTime({ ...ready, phone: null })).toBe('no_phone');
  });

  it('dado de baja es opted_out', () => {
    expect(skipReasonAtSendTime({ ...ready, acceptsReminders: false })).toBe(
      'opted_out',
    );
  });

  it('too_late va antes que no_phone y que opted_out', () => {
    expect(
      skipReasonAtSendTime({
        startsAt: now,
        now,
        phone: null,
        acceptsReminders: false,
      }),
    ).toBe('too_late');
  });

  it('no_phone va antes que opted_out', () => {
    expect(
      skipReasonAtSendTime({ ...ready, phone: null, acceptsReminders: false }),
    ).toBe('no_phone');
  });
});

describe('envío de un recordatorio', () => {
  const T = new Date('2027-03-27T09:00:00Z');
  /** Pendiente nuevo en cada llamada, para que un test no contamine a otro. */
  const pending = (over: Partial<Reminder> = {}): Reminder => ({
    id: ID,
    appointmentId: APPOINTMENT_ID,
    scheduledFor: T,
    status: 'pending',
    skipReason: null,
    attempts: 0,
    nextAttemptAt: T,
    sentAt: null,
    sentTo: null,
    sendSeq: null,
    ...over,
  });
  const to = '+34600111222';

  describe('skipReminder', () => {
    it('lo deja skipped con el motivo, sin próximo intento y con sus intentos', () => {
      const retried = pending({
        attempts: 1,
        nextAttemptAt: new Date('2027-03-27T09:01:00Z'),
      });
      expect(skipReminder(retried, 'too_late')).toEqual({
        ...retried,
        status: 'skipped',
        skipReason: 'too_late',
        nextAttemptAt: null,
      });
    });

    it('no modifica el recordatorio recibido', () => {
      const original = pending();
      skipReminder(original, 'no_phone');
      expect(original).toEqual(pending());
    });

    it('uno que no está pendiente es un fallo de programación', () => {
      expect(() =>
        skipReminder(pending({ status: 'sent' }), 'opted_out'),
      ).toThrow(Error);
    });
  });

  describe('postponeReminder', () => {
    it('sigue pending con sus intentos y su hora prevista; solo mueve el próximo intento', () => {
      const until = new Date('2027-03-28T07:00:00Z');
      expect(postponeReminder(pending(), until)).toEqual({
        ...pending(),
        nextAttemptAt: until,
      });
    });

    it('no modifica el recordatorio recibido', () => {
      const original = pending();
      postponeReminder(original, new Date('2027-03-28T07:00:00Z'));
      expect(original).toEqual(pending());
    });

    it('uno que no está pendiente es un fallo de programación', () => {
      expect(() =>
        postponeReminder(
          pending({ status: 'skipped' }),
          new Date('2027-03-28T07:00:00Z'),
        ),
      ).toThrow(Error);
    });
  });

  describe('holdForQuietHours', () => {
    // Cita a las 10:00 de Madrid (CET) del 11 de marzo.
    const startsAt = new Date('2027-03-11T09:00:00Z');
    const timeZone = 'Europe/Madrid';
    // 09:00 de Madrid del 11 de marzo: la apertura tras una noche de franja.
    const opening = new Date('2027-03-11T08:00:00Z');

    it('un primer intento fuera de la franja se envía ya', () => {
      const now = new Date('2027-03-10T19:59:59Z');
      expect(holdForQuietHours(pending(), { now, startsAt, timeZone })).toBe(
        null,
      );
    });

    it('un primer intento a las 21:00 se aplaza a las 09:00 siguientes sin tocar scheduledFor ni attempts', () => {
      const now = new Date('2027-03-10T20:00:00Z');
      expect(holdForQuietHours(pending(), { now, startsAt, timeZone })).toEqual(
        { ...pending(), nextAttemptAt: opening },
      );
    });

    it('si la apertura es la hora de la cita queda skipped too_late, con attempts 0', () => {
      const now = new Date('2027-03-10T22:00:00Z');
      expect(
        holdForQuietHours(pending(), { now, startsAt: opening, timeZone }),
      ).toEqual({
        ...pending(),
        status: 'skipped',
        skipReason: 'too_late',
        nextAttemptAt: null,
      });
    });

    it('si la apertura cae después de la cita también es too_late', () => {
      const now = new Date('2027-03-10T22:00:00Z');
      expect(
        holdForQuietHours(pending(), {
          now,
          startsAt: new Date('2027-03-11T07:30:00Z'),
          timeZone,
        }),
      ).toMatchObject({ status: 'skipped', skipReason: 'too_late' });
    });

    it('un reintento dentro de la franja no espera', () => {
      const now = new Date('2027-03-10T20:00:30Z');
      expect(
        holdForQuietHours(pending({ attempts: 1, nextAttemptAt: now }), {
          now,
          startsAt,
          timeZone,
        }),
      ).toBe(null);
    });

    it('usa la zona que recibe: 20:30 de Canarias no es franja', () => {
      const now = new Date('2027-03-10T20:30:00Z');
      expect(
        holdForQuietHours(pending(), {
          now,
          startsAt,
          timeZone: 'Atlantic/Canary',
        }),
      ).toBe(null);
    });
  });

  describe('recordAttempt', () => {
    it('entregado: sent con sentAt, sentTo y sendSeq, y sin próximo intento', () => {
      expect(
        recordAttempt(pending(), 'delivered', { now: T, to, sendSeq: 7 }),
      ).toEqual({
        ...pending(),
        status: 'sent',
        attempts: 1,
        nextAttemptAt: null,
        sentAt: T,
        sentTo: to,
        sendSeq: 7,
      });
    });

    it('entregado en un reintento suma ese intento', () => {
      const retried = pending({
        attempts: 2,
        nextAttemptAt: new Date('2027-03-27T09:06:00Z'),
      });
      const at = new Date('2027-03-27T09:06:00Z');
      expect(
        recordAttempt(retried, 'delivered', { now: at, to, sendSeq: 1 }),
      ).toMatchObject({ status: 'sent', attempts: 3, sentAt: at });
    });

    it('rechazado: failed sin próximo intento', () => {
      expect(
        recordAttempt(pending(), 'rejected', { now: T, to, sendSeq: null }),
      ).toEqual({
        ...pending(),
        status: 'failed',
        attempts: 1,
        nextAttemptAt: null,
      });
    });

    it('primer fallo que se reintenta: pending para 1 minuto después', () => {
      expect(
        recordAttempt(pending(), 'retry', { now: T, to, sendSeq: null }),
      ).toEqual({
        ...pending(),
        attempts: 1,
        nextAttemptAt: new Date('2027-03-27T09:01:00Z'),
      });
    });

    it('segundo fallo: pending para 5 minutos después; scheduledFor no se mueve', () => {
      const at = new Date('2027-03-27T09:01:00Z');
      const retried = pending({ attempts: 1, nextAttemptAt: at });
      expect(
        recordAttempt(retried, 'retry', { now: at, to, sendSeq: null }),
      ).toEqual({
        ...retried,
        scheduledFor: T,
        attempts: 2,
        nextAttemptAt: new Date('2027-03-27T09:06:00Z'),
      });
    });

    it('tercer fallo: failed con 3 intentos', () => {
      const at = new Date('2027-03-27T09:06:00Z');
      expect(
        recordAttempt(pending({ attempts: 2, nextAttemptAt: at }), 'retry', {
          now: at,
          to,
          sendSeq: null,
        }),
      ).toEqual({
        ...pending(),
        status: 'failed',
        attempts: 3,
        nextAttemptAt: null,
      });
    });

    it('no modifica el recordatorio recibido', () => {
      const original = pending();
      recordAttempt(original, 'delivered', { now: T, to, sendSeq: 1 });
      expect(original).toEqual(pending());
    });

    it('uno que no está pendiente es un fallo de programación', () => {
      expect(() =>
        recordAttempt(pending({ status: 'cancelled' }), 'delivered', {
          now: T,
          to,
          sendSeq: 1,
        }),
      ).toThrow(Error);
    });

    it('entregado sin número de envío es un fallo de programación', () => {
      expect(() =>
        recordAttempt(pending(), 'delivered', { now: T, to, sendSeq: null }),
      ).toThrow(Error);
    });
  });
});

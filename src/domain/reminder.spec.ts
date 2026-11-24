import { cancelReminder, newReminder, type Reminder } from './reminder.js';

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

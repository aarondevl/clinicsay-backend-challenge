import { newReminder } from './reminder.js';

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

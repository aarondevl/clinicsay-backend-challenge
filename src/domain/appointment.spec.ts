import {
  type Appointment,
  cancelAppointment,
  confirmAppointment,
  hasStarted,
  rescheduleAppointment,
} from './appointment.js';

/** Cita nueva en cada llamada, para que un test no contamine a otro. */
const scheduled = (): Appointment => ({
  id: '019a0000-0000-7000-8000-000000000001',
  clinicId: '019a0000-0000-7000-8000-000000000002',
  patientId: '019a0000-0000-7000-8000-000000000003',
  startsAt: new Date('2027-03-28T08:00:00Z'),
  status: 'scheduled',
  virtual: false,
});

describe('hasStarted', () => {
  const now = new Date('2027-03-28T08:00:00Z');

  it('una cita que empieza justo ahora ya empezó', () => {
    expect(hasStarted({ ...scheduled(), startsAt: now }, now)).toBe(true);
  });

  it('una cita que empezó antes de ahora ya empezó', () => {
    const startsAt = new Date('2027-03-28T07:59:59Z');
    expect(hasStarted({ ...scheduled(), startsAt }, now)).toBe(true);
  });

  it('una cita posterior a ahora no ha empezado', () => {
    const startsAt = new Date('2027-03-28T08:00:01Z');
    expect(hasStarted({ ...scheduled(), startsAt }, now)).toBe(false);
  });
});

describe('rescheduleAppointment', () => {
  const startsAt = new Date('2027-03-29T08:00:00Z');

  it('cambia la hora de inicio y deja la cita scheduled', () => {
    expect(rescheduleAppointment(scheduled(), startsAt)).toEqual({
      ...scheduled(),
      startsAt,
      status: 'scheduled',
    });
  });

  it('una cita confirmed vuelve a scheduled', () => {
    const confirmed: Appointment = { ...scheduled(), status: 'confirmed' };
    expect(rescheduleAppointment(confirmed, startsAt).status).toBe('scheduled');
  });

  it('no modifica la cita recibida', () => {
    const original = { ...scheduled(), status: 'confirmed' as const };
    rescheduleAppointment(original, startsAt);
    expect(original).toEqual({ ...scheduled(), status: 'confirmed' });
  });
});

describe('cancelAppointment', () => {
  it.each(['scheduled', 'confirmed', 'cancelled'] as const)(
    'una cita %s queda cancelled con el resto igual',
    (status) => {
      expect(cancelAppointment({ ...scheduled(), status })).toEqual({
        ...scheduled(),
        status: 'cancelled',
      });
    },
  );
});

describe('confirmAppointment', () => {
  it.each(['scheduled', 'confirmed'] as const)(
    'una cita %s queda confirmed con el resto igual',
    (status) => {
      expect(confirmAppointment({ ...scheduled(), status })).toEqual({
        ...scheduled(),
        status: 'confirmed',
      });
    },
  );
});

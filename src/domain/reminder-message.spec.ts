import { buildReminderText } from './reminder-message.js';

describe('buildReminderText', () => {
  it('compone el texto exacto del contrato con la fecha y la hora locales', () => {
    expect(
      buildReminderText({
        patientName: 'Ana',
        clinicName: 'Clínica Dental Sonrisa',
        startsAt: new Date('2027-03-28T08:00:00Z'),
        timeZone: 'Europe/Madrid',
      }),
    ).toBe(
      'Hola Ana, te recordamos tu cita en Clínica Dental Sonrisa el 28/03/2027 a las 10:00. Responde SI para confirmar o NO para cancelar.',
    );
  });

  it('usa la zona indicada (Canarias va una hora por detrás)', () => {
    expect(
      buildReminderText({
        patientName: 'Luis',
        clinicName: 'Clínica Atlántico',
        startsAt: new Date('2027-03-28T09:00:00Z'),
        timeZone: 'Atlantic/Canary',
      }),
    ).toBe(
      'Hola Luis, te recordamos tu cita en Clínica Atlántico el 28/03/2027 a las 10:00. Responde SI para confirmar o NO para cancelar.',
    );
  });

  it('rellena con ceros el día, el mes, la hora y los minutos', () => {
    expect(
      buildReminderText({
        patientName: 'Ana',
        clinicName: 'Clínica Dental Sonrisa',
        startsAt: new Date('2027-01-05T08:05:00Z'),
        timeZone: 'Europe/Madrid',
      }),
    ).toBe(
      'Hola Ana, te recordamos tu cita en Clínica Dental Sonrisa el 05/01/2027 a las 09:05. Responde SI para confirmar o NO para cancelar.',
    );
  });

  it('falla con una zona IANA que no existe en vez de escribir «Invalid DateTime»', () => {
    expect(() =>
      buildReminderText({
        patientName: 'Ana',
        clinicName: 'Clínica Dental Sonrisa',
        startsAt: new Date('2027-03-28T08:00:00Z'),
        timeZone: 'Mars/Olympus',
      }),
    ).toThrow('invalid time zone: Mars/Olympus');
  });
});

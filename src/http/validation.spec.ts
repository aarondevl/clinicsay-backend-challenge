import {
  isIsoDateTimeWithZone,
  parseIsoDateTimeWithZone,
} from './validation.js';

describe('parseIsoDateTimeWithZone', () => {
  it('convierte una fecha con offset en su instante', () => {
    expect(parseIsoDateTimeWithZone('2027-03-28T10:00:00+02:00')).toEqual(
      new Date('2027-03-28T08:00:00Z'),
    );
  });

  it.each([
    ['no tiene zona', '2027-03-28T10:00:00'],
    ['no tiene fecha', '10:00:00Z'],
    ['es una fecha ordinal', '2027-087T10:00:00Z'],
  ])('lanza si la fecha %s', (_l, value) => {
    expect(() => parseIsoDateTimeWithZone(value)).toThrow(
      'not an ISO 8601 date-time with a time zone',
    );
  });
});

describe('isIsoDateTimeWithZone', () => {
  it('acepta una fecha en UTC con Z', () => {
    expect(isIsoDateTimeWithZone('2027-03-28T08:00:00Z')).toBe(true);
  });

  it('acepta una fecha con offset', () => {
    expect(isIsoDateTimeWithZone('2027-03-28T10:00:00+02:00')).toBe(true);
  });

  it.each([
    ['con milisegundos', '2027-03-28T10:00:00.250+02:00'],
    ['sin segundos', '2027-03-28T10:00+02:00'],
  ])('acepta una fecha %s', (_label, value) => {
    expect(isIsoDateTimeWithZone(value)).toBe(true);
  });

  it('rechaza una fecha sin zona', () => {
    expect(isIsoDateTimeWithZone('2027-03-28T10:00:00')).toBe(false);
  });

  // `date-time` del contrato (RFC 3339): Luxon admite más formas ISO 8601 y
  // completa lo que falta con la fecha del sistema, no con la del `Clock`.
  it.each([
    ['solo una hora', '10:00:00Z'],
    ['un mes sin día', '2027-03T10:00:00Z'],
    ['un año sin mes', '2027T10:00:00Z'],
    ['una fecha ordinal', '2027-087T10:00:00Z'],
    ['una fecha de semana', '2027-W12-7T10:00:00Z'],
    ['el formato básico', '20270328T100000Z'],
    ['un año de 5 cifras', '+010000-01-01T00:00:00Z'],
    ['un offset de más de 23 h', '2027-03-28T10:00:00+99:00'],
    ['un offset con 60 minutos', '2027-03-28T10:00:00+02:60'],
    ['la hora 24', '2027-03-28T24:00:00Z'],
  ])('rechaza %s', (_label, value) => {
    expect(isIsoDateTimeWithZone(value)).toBe(false);
  });

  it('rechaza un día que no existe', () => {
    expect(isIsoDateTimeWithZone('2027-02-30T10:00:00Z')).toBe(false);
  });

  it('rechaza un texto que no es fecha', () => {
    expect(isIsoDateTimeWithZone('mañana')).toBe(false);
  });

  it('rechaza lo que no es texto', () => {
    expect(isIsoDateTimeWithZone(123)).toBe(false);
  });
});

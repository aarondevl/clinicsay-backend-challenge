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

  it('convierte también las formas ISO que acepta el validador y Date no entiende', () => {
    // Fecha ordinal: día 87 de 2027 (28 de marzo).
    expect(isIsoDateTimeWithZone('2027-087T10:00:00Z')).toBe(true);
    expect(parseIsoDateTimeWithZone('2027-087T10:00:00Z')).toEqual(
      new Date('2027-03-28T10:00:00Z'),
    );
  });

  it('lanza si la fecha no tiene zona en vez de usar la de la máquina', () => {
    expect(() => parseIsoDateTimeWithZone('2027-03-28T10:00:00')).toThrow(
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

  it('rechaza una fecha sin zona', () => {
    expect(isIsoDateTimeWithZone('2027-03-28T10:00:00')).toBe(false);
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

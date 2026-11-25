import { validateSync } from 'class-validator';
import {
  IsIsoDateTimeWithZone,
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
    ['cae en el año 0 en UTC', '0001-01-01T00:30:00+01:00'],
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

  // MikroORM envía las fechas con `toISOString()`: Postgres no tiene año 0 y
  // lee el `+010000-…` de un año de 5 cifras como un offset.
  it.each([
    ['el primer instante del año 1', '0001-01-01T00:00:00Z'],
    ['el último segundo del año 9999', '9999-12-31T23:59:59Z'],
    [
      'una fecha del año 9999 que es del 9999 en UTC',
      '9999-12-31T23:30:00+01:00',
    ],
  ])('acepta %s', (_label, value) => {
    expect(isIsoDateTimeWithZone(value)).toBe(true);
  });

  it.each([
    ['el año 0', '0000-01-01T00:00:00Z'],
    [
      'una fecha del año 1 que en UTC es del año 0',
      '0001-01-01T00:30:00+01:00',
    ],
    [
      'una fecha del año 9999 que en UTC es del 10000',
      '9999-12-31T23:30:00-01:00',
    ],
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

/** Mensajes de error de `value` con el decorador aplicado a la propiedad. */
function errorsOf(decorator: PropertyDecorator, value: unknown): string[] {
  class Body {
    value: unknown;
  }
  decorator(Body.prototype, 'value');
  const body = new Body();
  body.value = value;
  return validateSync(body).flatMap((e) => Object.values(e.constraints ?? {}));
}

describe('IsIsoDateTimeWithZone', () => {
  it('pide la forma date-time cuando la fecha no la tiene', () => {
    expect(errorsOf(IsIsoDateTimeWithZone(), '10:00:00Z')).toEqual([
      'value must be an ISO 8601 date-time with a time zone',
    ]);
  });

  it('dice el rango de años cuando la fecha tiene la forma pero no cabe', () => {
    expect(errorsOf(IsIsoDateTimeWithZone(), '0000-01-01T00:00:00Z')).toEqual([
      'value must be between the years 0001 and 9999 in UTC',
    ]);
  });
});

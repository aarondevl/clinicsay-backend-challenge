import { E164 } from './patient.js';

describe('E164', () => {
  it.each(['+34600111222', '+12345678', '+123456789012345'])(
    'acepta %s',
    (phone) => {
      expect(E164.test(phone)).toBe(true);
    },
  );

  it.each([
    ['sin el +', '600111222'],
    ['con un 0 tras el +', '+034600111222'],
    ['con menos de 8 cifras', '+1234567'],
    ['con más de 15 cifras', '+1234567890123456'],
    ['con espacios', '+34 600 111 222'],
    ['vacío', ''],
  ])('rechaza un número %s', (_label, phone) => {
    expect(E164.test(phone)).toBe(false);
  });
});

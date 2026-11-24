import {
  MAX_ATTEMPTS,
  nextRetryAt,
  RETRY_DELAYS_MINUTES,
} from './retry-policy.js';

describe('política de reintentos', () => {
  it('el enunciado pide reintentar a 1 y 5 minutos, 3 intentos como mucho', () => {
    expect(RETRY_DELAYS_MINUTES).toEqual([1, 5]);
    expect(MAX_ATTEMPTS).toBe(3);
  });

  it('el 2.º intento va 1 minuto después del primer fallo', () => {
    expect(nextRetryAt(1, new Date('2027-03-27T09:00:00Z'))).toEqual(
      new Date('2027-03-27T09:01:00Z'),
    );
  });

  it('el 3.º intento va 5 minutos después del 2.º fallo', () => {
    expect(nextRetryAt(2, new Date('2027-03-27T09:01:00Z'))).toEqual(
      new Date('2027-03-27T09:06:00Z'),
    );
  });

  it('tras el 3.er fallo no hay más intentos', () => {
    expect(nextRetryAt(3, new Date('2027-03-27T09:06:00Z'))).toBeNull();
  });

  it('cuenta desde la hora del fallo, con sus segundos', () => {
    expect(nextRetryAt(1, new Date('2027-03-27T09:00:04.500Z'))).toEqual(
      new Date('2027-03-27T09:01:04.500Z'),
    );
  });

  it('no espera a que acabe la franja de silencio', () => {
    // 21:00 de Madrid (CET): el reintento sale a las 21:01, dentro de la franja.
    expect(nextRetryAt(1, new Date('2027-03-10T20:00:00Z'))).toEqual(
      new Date('2027-03-10T20:01:00Z'),
    );
  });

  it.each([0, -1, 1.5])(
    'con %s intentos hechos es un fallo de programación',
    (attempts) => {
      expect(() =>
        nextRetryAt(attempts, new Date('2027-03-27T09:00:00Z')),
      ).toThrow(Error);
    },
  );
});

import { isDatabaseUnavailable } from './database-unavailable.js';

function withCode(code: string, message = 'boom'): Error {
  return Object.assign(new Error(message), { code });
}

describe('isDatabaseUnavailable', () => {
  // Lo que devuelve pg-pool al no poder abrir o mantener el socket.
  it.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND'])(
    'un error de red %s es base caída',
    (code) => {
      expect(isDatabaseUnavailable(withCode(code))).toBe(true);
    },
  );

  it('una conexión que pg da por terminada es base caída', () => {
    expect(
      isDatabaseUnavailable(new Error('Connection terminated unexpectedly')),
    ).toBe(true);
  });

  // SQLSTATE de Postgres: fallo de conexión, apagado o sin conexiones libres.
  it.each(['08006', '08001', '57P01', '57P03', '53300'])(
    'el SQLSTATE %s es base caída',
    (code) => {
      expect(isDatabaseUnavailable(withCode(code))).toBe(true);
    },
  );

  // 08P01 (protocol_violation) lo provoca también una entrada con un carácter
  // NUL: es un fallo de los datos, no de la base.
  it('el SQLSTATE 08P01 no es base caída', () => {
    expect(isDatabaseUnavailable(withCode('08P01'))).toBe(false);
  });

  it.each([
    ['una violación de clave foránea', withCode('23503')],
    ['un error sin código', new Error('bug')],
    ['algo que no es un Error', 'ECONNREFUSED'],
  ])('%s no es base caída', (_label, error) => {
    expect(isDatabaseUnavailable(error)).toBe(false);
  });

  // fetch envuelve el error de red en `cause`: si uno del proveedor se
  // escapara de su adaptador, no debe pasar por una caída de la base.
  it('no mira el cause: un fetch fallido no es base caída', () => {
    const fetchError = new TypeError('fetch failed', {
      cause: withCode('ECONNREFUSED'),
    });
    expect(isDatabaseUnavailable(fetchError)).toBe(false);
  });
});

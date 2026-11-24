// Errores de socket que pg-pool devuelve sin envolver.
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'EAI_AGAIN',
]);

// SQLSTATE de conexión (clase 08), apagado (57P0x) y sin conexiones libres
// (53300). Falta 08P01 a propósito: también lo provoca un dato con NUL.
const SQLSTATES = new Set([
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '57P01',
  '57P02',
  '57P03',
  '53300',
]);

/**
 * Dice si `error` significa que la base no responde, y no que la consulta o
 * los datos estén mal. Solo mira el propio error (su `code` o el mensaje con
 * que pg cierra una conexión), no su `cause`: un `fetch` fallido lleva el
 * código de red en `cause` y no es una caída de la base.
 */
export function isDatabaseUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? String(error.code) : undefined;
  if (code !== undefined) return NETWORK_CODES.has(code) || SQLSTATES.has(code);
  return error.message.startsWith('Connection terminated');
}

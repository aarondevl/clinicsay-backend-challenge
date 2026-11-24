/**
 * Minutos de espera antes de cada reintento: el 2.º intento va 1 minuto
 * después del primer fallo y el 3.º, 5 minutos después del 2.º. Es la única
 * definición de estos valores; cambiarlos cambia la política entera.
 */
export const RETRY_DELAYS_MINUTES = [1, 5] as const;

/** Llamadas al proveedor como mucho por recordatorio: la primera y sus reintentos. */
export const MAX_ATTEMPTS = RETRY_DELAYS_MINUTES.length + 1;

const MS_PER_MINUTE = 60_000;

/**
 * Devuelve cuándo toca el siguiente intento tras un fallo que se puede
 * reintentar, o `null` si ya se hicieron todos. No mira la franja de silencio:
 * los reintentos no esperan a que acabe.
 *
 * @param attemptsMade Llamadas hechas al proveedor, contando la que acaba de fallar.
 * @param failedAt Hora del servicio en que falló esa llamada.
 * @throws Error si `attemptsMade` no es un entero positivo (fallo de programación).
 */
export function nextRetryAt(attemptsMade: number, failedAt: Date): Date | null {
  if (!Number.isInteger(attemptsMade) || attemptsMade < 1) {
    throw new Error(`invalid attempts made: ${attemptsMade}`);
  }
  const delay = RETRY_DELAYS_MINUTES[attemptsMade - 1];
  if (delay === undefined) return null;
  return new Date(failedAt.getTime() + delay * MS_PER_MINUTE);
}

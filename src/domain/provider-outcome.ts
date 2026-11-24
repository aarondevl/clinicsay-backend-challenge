/**
 * Lo que pasó al llamar al proveedor: un código HTTP, un fallo de red o que no
 * respondió a tiempo. Lo produce el adaptador del proveedor, que no decide qué
 * significa.
 */
export type ProviderResult =
  | { kind: 'response'; status: number }
  | { kind: 'network_error' }
  | { kind: 'timeout' };

/**
 * Qué se hace con el recordatorio tras una llamada: `delivered` (queda
 * `sent`), `retry` (otro intento si quedan) o `rejected` (`failed` sin más
 * intentos).
 */
export type SendOutcome = 'delivered' | 'retry' | 'rejected';

/**
 * Traduce el resultado de una llamada al proveedor a lo que se hace con el
 * recordatorio. 202, o 200 (ya lo tenía con esa `Idempotency-Key` y no lo
 * reenvía), es entregado, como cualquier otro 2xx. Cualquier 4xx es un
 * rechazo: repetir la misma petición daría lo mismo. Un 5xx, un error de red
 * o un timeout se reintentan con la misma clave, que evita el duplicado si ya
 * se había entregado.
 */
export function classifyProviderResult(result: ProviderResult): SendOutcome {
  if (result.kind !== 'response') return 'retry';
  const { status } = result;
  // El enunciado solo nombra 202 y 200; un proveedor real puede aceptar con
  // otro 2xx (201, 204), y tratarlo como fallo dejaría `failed` lo entregado.
  if (status >= 200 && status < 300) return 'delivered';
  if (status >= 400 && status < 500) return 'rejected';
  // 5xx y lo que no es ni éxito ni rechazo: con la misma clave es seguro reintentar.
  return 'retry';
}

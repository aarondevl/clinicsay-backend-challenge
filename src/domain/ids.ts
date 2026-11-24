// Forma canónica 8-4-4-4-12 en hexadecimal. Todo lo que acepta lo puede
// convertir Postgres a `uuid`, así que un id raro nunca llega a dar 500.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Dice si `value` tiene forma de id (un UUID). Los casos de uso lo comprueban
 * antes de buscar: un id que no es UUID se trata igual que uno que no existe.
 */
export function isId(value: string): boolean {
  return UUID.test(value);
}

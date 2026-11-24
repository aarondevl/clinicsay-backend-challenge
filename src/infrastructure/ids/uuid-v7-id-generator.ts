import { v7 } from 'uuid';
import { IdGenerator } from '../../application/ports/id-generator.js';

/**
 * Ids UUIDv7: llevan la hora del sistema (no la de negocio) y un contador que
 * los mantiene en orden creciente dentro del mismo milisegundo.
 */
export class UuidV7IdGenerator extends IdGenerator {
  /** Devuelve un UUIDv7 mayor que todos los generados antes en este proceso. */
  next(): string {
    return v7();
  }
}

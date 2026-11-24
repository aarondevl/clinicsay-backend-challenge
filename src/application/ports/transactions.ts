import type { Repositories } from './repositories.js';

/** Única forma de leer y escribir en la base: una transacción por llamada. */
export abstract class Transactions {
  /**
   * Ejecuta `work` en una transacción nueva con repositorios ligados a ella.
   * Si `work` termina, confirma; si lanza, deshace y relanza el mismo error.
   */
  abstract run<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
}

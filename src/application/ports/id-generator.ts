/** Genera los ids de lo que crean los casos de uso. */
export abstract class IdGenerator {
  /**
   * Devuelve un id nuevo. Cada id es mayor que el anterior, así que ordenar
   * por id conserva el orden de creación aunque el reloj de negocio esté
   * congelado.
   */
  abstract next(): string;
}

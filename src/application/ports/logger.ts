/**
 * Registro de los errores que un caso de uso trata sin devolverlos a quien
 * lo llamó, para que no se pierdan.
 */
export abstract class Logger {
  /**
   * Registra un error tratado.
   * @param message Qué se estaba haciendo y con qué id; sin datos personales
   * (ni teléfonos ni textos de mensajes).
   * @param error El error capturado, tal cual, para conservar su pila.
   */
  abstract error(message: string, error: unknown): void;
}

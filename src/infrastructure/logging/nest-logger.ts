import { Logger as NestJsLogger } from '@nestjs/common';
import { Logger } from '../../application/ports/logger.js';

/**
 * `Logger` sobre el de Nest, que respeta la configuración de logs de la app.
 * Cada caso de uso recibe el suyo, con su nombre como contexto.
 */
export class NestLogger extends Logger {
  private readonly logger: NestJsLogger;

  /** @param context Quién registra (el nombre del caso de uso). */
  constructor(context: string) {
    super();
    this.logger = new NestJsLogger(context);
  }

  /** Escribe `message` en el log de errores de Nest, con la pila de `error`. */
  error(message: string, error: unknown): void {
    this.logger.error(message, error);
  }
}

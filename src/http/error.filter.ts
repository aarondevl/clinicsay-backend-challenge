import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from '../application/errors.js';

/** Todas las respuestas de error tienen la forma `{ "error": "<mensaje>" }`. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorFilter.name);

  /**
   * Traduce cualquier excepción a su código HTTP y responde `{ error }`. Lo
   * que no es un error propio ni una `HttpException` es un 500 y se registra.
   */
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const [status, error] = this.translate(exception);
    response.status(status).json({ error });
  }

  private translate(exception: unknown): [number, string] {
    if (exception instanceof ValidationError) return [400, exception.message];
    if (exception instanceof NotFoundError) return [404, exception.message];
    if (exception instanceof ConflictError) return [409, exception.message];
    if (exception instanceof ServiceUnavailableError) {
      return [503, exception.message];
    }
    if (exception instanceof HttpException) {
      return [exception.getStatus(), exception.message];
    }
    this.logger.error(exception);
    return [500, 'internal error'];
  }
}

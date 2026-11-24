/**
 * Errores propios de la aplicación. Solo `ErrorFilter` (en `src/http`) los
 * traduce a códigos HTTP: 400, 404, 409 y 503.
 */

/** Datos que no cumplen una regla de negocio (400). */
export class ValidationError extends Error {
  override name = 'ValidationError';
}

/** El recurso pedido no existe o su id no es válido (404). */
export class NotFoundError extends Error {
  override name = 'NotFoundError';
}

/** El estado actual del recurso no permite la operación (409). */
export class ConflictError extends Error {
  override name = 'ConflictError';
}

/** Una dependencia externa (la base de datos) no responde (503). */
export class ServiceUnavailableError extends Error {
  override name = 'ServiceUnavailableError';
}

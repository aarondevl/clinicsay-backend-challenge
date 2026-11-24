/** Errores de aplicación; el filtro HTTP los traduce a 400, 404 y 409. */
export class ValidationError extends Error {
  override name = 'ValidationError';
}

export class NotFoundError extends Error {
  override name = 'NotFoundError';
}

export class ConflictError extends Error {
  override name = 'ConflictError';
}

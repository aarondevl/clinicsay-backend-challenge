import { ValidationPipe } from '@nestjs/common';
import {
  ValidateBy,
  type ValidationError as ClassValidatorError,
  type ValidationOptions,
} from 'class-validator';
import { DateTime } from 'luxon';
import { ValidationError } from '../application/errors.js';

const ZONE_SUFFIX = /(Z|[+-]\d{2}:\d{2})$/;

/** Fecha-hora ISO 8601 válida y con zona explícita (`Z` u offset). */
export function isIsoDateTimeWithZone(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    ZONE_SUFFIX.test(value) &&
    DateTime.fromISO(value, { setZone: true }).isValid
  );
}

/**
 * Convierte en instante una fecha que ya pasó `@IsIsoDateTimeWithZone()`.
 * Usa el mismo parser que el validador: `new Date()` no entiende todas las
 * formas ISO que este acepta (fechas ordinales o de semana) y daría una fecha
 * inválida.
 *
 * @throws Error si `value` no tiene zona o no es una fecha ISO 8601. Es un
 * fallo de programación (el DTO la valida antes), así que el filtro da 500.
 */
export function parseIsoDateTimeWithZone(value: string): Date {
  if (!isIsoDateTimeWithZone(value)) {
    throw new Error(
      `not an ISO 8601 date-time with a time zone: ${JSON.stringify(value)}`,
    );
  }
  return DateTime.fromISO(value, { setZone: true }).toJSDate();
}

/** Decorador de DTO para {@link isIsoDateTimeWithZone}. */
export function IsIsoDateTimeWithZone(
  options?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isIsoDateTimeWithZone',
      validator: {
        validate: isIsoDateTimeWithZone,
        defaultMessage: (args) =>
          `${args?.property ?? 'value'} must be an ISO 8601 date-time with a time zone`,
      },
    },
    options,
  );
}

function messages(errors: ClassValidatorError[]): string[] {
  return errors.flatMap((e) => [
    ...Object.values(e.constraints ?? {}),
    ...messages(e.children ?? []),
  ]);
}

/** Pipe global: solo campos declarados y sin conversión implícita de tipos. */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    exceptionFactory: (errors) =>
      new ValidationError(messages(errors).join('; ') || 'invalid request'),
  });
}

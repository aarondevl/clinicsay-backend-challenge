import { ValidationPipe } from '@nestjs/common';
import {
  ValidateBy,
  type ValidationError as ClassValidatorError,
  type ValidationOptions,
} from 'class-validator';
import { DateTime } from 'luxon';
import { ValidationError } from '../application/errors.js';

// Forma `date-time` del contrato (RFC 3339), con los segundos opcionales:
// fecha completa con año de 4 cifras, hora 00-23, fracción opcional y zona
// `Z` u offset de ±23:59 como mucho. Luxon admite más formas ISO 8601 (solo la hora, fecha
// ordinal o de semana, año de 6 cifras) y completa lo que falta con la fecha
// del sistema, que no es la del `Clock`.
const RFC_3339_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

/**
 * Fecha-hora con la forma `date-time` del contrato y zona explícita (`Z` u
 * offset). Luxon comprueba además que el día exista (no hay 30 de febrero).
 */
export function isIsoDateTimeWithZone(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    RFC_3339_DATE_TIME.test(value) &&
    DateTime.fromISO(value, { setZone: true }).isValid
  );
}

/**
 * Convierte en instante una fecha que ya pasó `@IsIsoDateTimeWithZone()`, con
 * el mismo parser que el validador.
 *
 * @throws Error si `value` no tiene esa forma (sin zona, sin fecha completa).
 * Es un fallo de programación (el DTO la valida antes), así que el filtro da
 * 500; lo que nunca hace es completar la fecha con la de la máquina.
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

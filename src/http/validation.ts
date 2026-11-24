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

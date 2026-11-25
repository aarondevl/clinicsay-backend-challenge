import { ValidationPipe } from '@nestjs/common';
import {
  IsString,
  MaxLength,
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

// Años en UTC que llegan a Postgres. MikroORM envía las fechas con
// `toISOString()`: Postgres no tiene año 0 (22008) y lee el `+010000-…` de un
// año de 5 cifras como un offset (22009). Las dos acababan en 500.
const MIN_UTC_YEAR = 1;
const MAX_UTC_YEAR = 9999;

/** La fecha si tiene la forma `date-time` del contrato y el día existe. */
function parseRfc3339(value: unknown): DateTime<true> | null {
  if (typeof value !== 'string' || !RFC_3339_DATE_TIME.test(value)) {
    return null;
  }
  const parsed = DateTime.fromISO(value, { setZone: true });
  return parsed.isValid ? parsed : null;
}

function hasStorableYear(date: DateTime<true>): boolean {
  const { year } = date.toUTC();
  return year >= MIN_UTC_YEAR && year <= MAX_UTC_YEAR;
}

/**
 * Fecha-hora con la forma `date-time` del contrato y zona explícita (`Z` u
 * offset). Luxon comprueba además que el día exista (no hay 30 de febrero), y
 * en UTC tiene que caer entre los años 1 y 9999, los que Postgres guarda.
 */
export function isIsoDateTimeWithZone(value: unknown): boolean {
  const parsed = parseRfc3339(value);
  return parsed !== null && hasStorableYear(parsed);
}

/**
 * Convierte en instante una fecha que ya pasó `@IsIsoDateTimeWithZone()`, con
 * el mismo parser que el validador.
 *
 * @throws Error si `value` no tiene esa forma (sin zona, sin fecha completa)
 * o cae fuera de los años 1 a 9999 en UTC.
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
        defaultMessage: (args) => {
          const property = args?.property ?? 'value';
          return parseRfc3339(args?.value) === null
            ? `${property} must be an ISO 8601 date-time with a time zone`
            : `${property} must be between the years 0001 and 9999 in UTC`;
        },
      },
    },
    options,
  );
}

/**
 * Longitud máxima de los textos de entrada que llegan a Postgres. El contrato
 * no fija ninguna; son holgadas para cualquier dato real.
 */
export const MAX_TEXT_LENGTH = {
  /** Nombre de clínica o paciente: se guarda y va en el texto del recordatorio. */
  name: 200,
  /** `from` del webhook: un E.164 tiene 16 caracteres como mucho. */
  phone: 200,
  /**
   * `messageId` del webhook: es la clave primaria de `inbound_message` y una
   * clave btree no pasa de 2704 bytes. Tal como cuenta `@MaxLength`, un
   * carácter ocupa como mucho 7 bytes en UTF-8 (emoji y selector de variante),
   * así que 255 caracteres son unos 1,8 kB.
   */
  messageId: 255,
} as const;

// Postgres no admite el carácter NUL en `text`: rechaza la consulta entera
// con 08P01.
const NUL = '\u0000';

/**
 * Decorador de DTO para un texto que se guarda o se consulta en Postgres:
 * cadena (`@IsString()`) de `maxLength` caracteres como mucho
 * (`@MaxLength()`) y sin el carácter NUL. Sin él, Postgres rechazaba el valor
 * y la API respondía 500 en vez de 400.
 *
 * @param maxLength Uno de los valores de {@link MAX_TEXT_LENGTH}.
 */
export function IsStorableText(
  maxLength: number,
  options?: ValidationOptions,
): PropertyDecorator {
  const decorators = [
    IsString(options),
    MaxLength(maxLength, options),
    ValidateBy(
      {
        name: 'hasNoNul',
        validator: {
          // Lo que no es texto ya lo señala `@IsString()`.
          validate: (value: unknown) =>
            typeof value !== 'string' || !value.includes(NUL),
          defaultMessage: (args) =>
            `${args?.property ?? 'value'} must not contain NUL characters`,
        },
      },
      options,
    ),
  ];
  return (target, propertyKey) => {
    for (const decorate of decorators) decorate(target, propertyKey);
  };
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

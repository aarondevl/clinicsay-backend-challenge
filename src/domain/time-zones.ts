import { DateTime, IANAZone } from 'luxon';

/**
 * Zona de las citas virtuales: la hora peninsular, sea cual sea la zona de la
 * clínica. Se usa para la hora de envío, la franja de silencio y el texto.
 */
export const VIRTUAL_TIME_ZONE = 'Europe/Madrid';

/**
 * Devuelve la zona IANA con la que se calculan la hora de envío, la franja de
 * silencio y el texto de una cita.
 *
 * @param clinicTimeZone Zona IANA de la clínica.
 * @param virtual Si la cita es virtual; entonces manda {@link VIRTUAL_TIME_ZONE}.
 */
export function effectiveTimeZone(
  clinicTimeZone: string,
  virtual: boolean,
): string {
  return virtual ? VIRTUAL_TIME_ZONE : clinicTimeZone;
}

/**
 * Pasa un instante a la hora local de una zona IANA.
 *
 * @throws Error si `timeZone` no es una zona IANA válida. Es un fallo de
 * programación (la zona se valida al crear la clínica), así que no es un
 * error propio ni se traduce a un código de la API.
 */
export function localDateTime(instant: Date, timeZone: string): DateTime {
  const local = DateTime.fromJSDate(instant, { zone: timeZone });
  if (!local.isValid) throw new Error(`invalid time zone: ${timeZone}`);
  return local;
}

// Intl acepta offsets fijos (`+01:00`) como zona, pero no son zonas IANA ni
// tienen cambio de horario.
const UTC_OFFSET = /^[+-]/;

/**
 * Dice si `zone` es una zona IANA que existe (`Europe/Madrid`,
 * `Atlantic/Canary`). Rechaza `local` y `system`, que dependen de la máquina,
 * y los offsets fijos como `+01:00`.
 */
export function isValidTimeZone(zone: string): boolean {
  return !UTC_OFFSET.test(zone) && IANAZone.isValidZone(zone);
}

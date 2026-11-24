import { DateTime } from 'luxon';

/** Fecha de salida de la API: UTC con `Z`, sin milisegundos si son cero. */
export function toApiDate(date: Date): string {
  const iso = DateTime.fromJSDate(date, { zone: 'utc' }).toISO({
    suppressMilliseconds: true,
  });
  if (iso === null) throw new Error(`invalid date: ${String(date)}`);
  return iso.replace(/\+00:00$/, 'Z');
}

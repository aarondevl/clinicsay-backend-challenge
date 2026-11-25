import { DateTime } from 'luxon';
import { localDateTime } from './time-zones.js';

/**
 * Franja de silencio en hora local: `[start:00, end:00)`. Lo que cae dentro
 * se envía a las `end:00` siguientes.
 */
export const QUIET_HOURS = { start: 21, end: 9 } as const;

/** Hora de envío de un recordatorio y, si no llega a tiempo, por qué. */
export type ReminderPlan = {
  scheduledFor: Date;
  skipReason: 'too_late' | null;
};

/**
 * Calcula cuándo se envía el recordatorio de una cita: la misma hora local del
 * día anterior, o `now` si esa hora ya pasó, desplazada a las 09:00 siguientes
 * si cae en la franja de silencio. Si el resultado no queda antes del inicio
 * de la cita, el plan lleva `too_late`.
 *
 * @param input.startsAt Inicio de la cita.
 * @param input.timeZone Zona IANA efectiva de la cita (ver `effectiveTimeZone`).
 * @param input.now Hora actual del servicio, sacada del puerto `Clock`.
 * @throws Error si `timeZone` no es una zona IANA válida (el llamador la valida antes).
 */
export function planReminder(input: {
  startsAt: Date;
  timeZone: string;
  now: Date;
}): ReminderPlan {
  const { startsAt, timeZone, now } = input;

  // Día de calendario, no 24 h: con el cambio de horario hay 23 o 25 h.
  let candidate = localDateTime(startsAt, timeZone).minus({ days: 1 });
  if (candidate.toJSDate() < now) candidate = localDateTime(now, timeZone);

  const scheduled = endOfQuietHours(candidate) ?? candidate;
  const scheduledFor = scheduled.toJSDate();

  return {
    scheduledFor,
    skipReason: scheduledFor < startsAt ? null : 'too_late',
  };
}

/**
 * Dice si `instant` cae en la franja de silencio de `timeZone` y, si cae,
 * cuándo termina: las 09:00 locales siguientes. El job lo usa al enviar,
 * porque en la franja no se envía nada aunque el recordatorio ya toque.
 *
 * @param timeZone Zona IANA efectiva de la cita (ver `effectiveTimeZone`).
 * @returns El fin de la franja, o `null` si `instant` queda fuera de ella.
 * @throws Error si `timeZone` no es una zona IANA válida (el llamador la valida antes).
 */
export function quietHoursEnd(instant: Date, timeZone: string): Date | null {
  return endOfQuietHours(localDateTime(instant, timeZone))?.toJSDate() ?? null;
}

/**
 * Si `local` cae en `[21:00, 09:00)`, devuelve las 09:00 siguientes; si no,
 * `null`. Las horas que no existen o se repiten por el cambio de horario
 * (02:00-03:00) caen dentro de la franja y acaban también a las 09:00.
 */
function endOfQuietHours(local: DateTime): DateTime | null {
  if (local.hour >= QUIET_HOURS.start) {
    return atQuietHoursEnd(local.plus({ days: 1 }));
  }
  if (local.hour < QUIET_HOURS.end) return atQuietHoursEnd(local);
  return null;
}

function atQuietHoursEnd(day: DateTime): DateTime {
  return day.set({
    hour: QUIET_HOURS.end,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
}

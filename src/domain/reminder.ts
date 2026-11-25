import type { SendOutcome } from './provider-outcome.js';
import { quietHoursEnd, type ReminderPlan } from './reminder-schedule.js';
import { nextRetryAt } from './retry-policy.js';

/** Estado de un recordatorio. Solo `pending` se puede enviar. */
export type ReminderStatus =
  'pending' | 'sent' | 'failed' | 'skipped' | 'cancelled';

/** Por qué un recordatorio quedó `skipped`. */
export type SkipReason = 'too_late' | 'no_phone' | 'opted_out';

/**
 * Recordatorio de una cita. `scheduledFor` es la hora de envío prevista y no
 * cambia; los reintentos mueven `nextAttemptAt`. `sentTo` y `sendSeq` se fijan
 * al quedar `sent` y deciden a qué cita va una respuesta del paciente.
 */
export type Reminder = {
  id: string;
  appointmentId: string;
  scheduledFor: Date;
  status: ReminderStatus;
  skipReason: SkipReason | null;
  /** Llamadas hechas al proveedor. */
  attempts: number;
  /** Cuándo puede tomarlo el job; `null` si ya no está pendiente. */
  nextAttemptAt: Date | null;
  sentAt: Date | null;
  sentTo: string | null;
  sendSeq: number | null;
};

/**
 * Crea el recordatorio de una cita a partir de su plan: `pending` y listo para
 * el job a su hora, o ya `skipped` con `too_late` si no da tiempo a enviarlo.
 *
 * @param id Id nuevo del recordatorio (del puerto `IdGenerator`).
 * @param plan Resultado de `planReminder` para la cita.
 */
export function newReminder(
  id: string,
  appointmentId: string,
  plan: ReminderPlan,
): Reminder {
  const onTime = plan.skipReason === null;
  return {
    id,
    appointmentId,
    scheduledFor: plan.scheduledFor,
    status: onTime ? 'pending' : 'skipped',
    skipReason: plan.skipReason,
    attempts: 0,
    nextAttemptAt: onTime ? plan.scheduledFor : null,
    sentAt: null,
    sentTo: null,
    sendSeq: null,
  };
}

/**
 * Cancela el recordatorio si sigue `pending` y le quita el próximo intento;
 * conserva `attempts`. Uno en cualquier otro estado se devuelve igual: un
 * `sent` se queda `sent` aunque la cita se reprograme o se cancele.
 */
export function cancelReminder(reminder: Reminder): Reminder {
  if (reminder.status !== 'pending') return reminder;
  return { ...reminder, status: 'cancelled', nextAttemptAt: null };
}

/**
 * Dice si un recordatorio que toca enviar se descarta, y por qué. Se evalúa
 * en cada intento, con la hora del servicio, y en este orden: `too_late` si
 * la cita ya empezó (`startsAt <= now`, como `hasStarted`), `no_phone` si el
 * paciente no tiene teléfono y `opted_out` si se dio de baja.
 *
 * @param input.now Hora del servicio (puerto `Clock`).
 * @returns El motivo, o `null` si se puede llamar al proveedor.
 */
export function skipReasonAtSendTime(input: {
  startsAt: Date;
  now: Date;
  phone: string | null;
  acceptsReminders: boolean;
}): SkipReason | null {
  if (input.startsAt <= input.now) return 'too_late';
  if (input.phone === null) return 'no_phone';
  if (!input.acceptsReminders) return 'opted_out';
  return null;
}

/**
 * Descarta un recordatorio pendiente: queda `skipped` con `reason` y sin
 * próximo intento. Conserva `attempts`: un reintento descartado sigue
 * contando las llamadas que ya se hicieron.
 *
 * @throws Error si no está `pending` (fallo de programación: el job solo
 * descarta lo que tiene bloqueado y pendiente).
 */
export function skipReminder(reminder: Reminder, reason: SkipReason): Reminder {
  assertPending(reminder);
  return {
    ...reminder,
    status: 'skipped',
    skipReason: reason,
    nextAttemptAt: null,
  };
}

/**
 * Aplaza un recordatorio pendiente hasta `until` sin llamar al proveedor:
 * sigue `pending` con los mismos `attempts` y `scheduledFor`, y solo cambia
 * `nextAttemptAt`, como un reintento.
 *
 * @throws Error si no está `pending` (fallo de programación).
 */
export function postponeReminder(reminder: Reminder, until: Date): Reminder {
  assertPending(reminder);
  return { ...reminder, nextAttemptAt: until };
}

/**
 * Aplica la franja de silencio al ir a enviar. Entre las 21:00 y las 09:00
 * no se envía nada, salvo los reintentos, que no esperan a que acabe; así
 * que solo mira el primer intento (`attempts` 0). Se evalúa después de los
 * descartes de `skipReasonAtSendTime` y antes de llamar al proveedor.
 *
 * @param ctx.now Hora del servicio (puerto `Clock`).
 * @param ctx.startsAt Inicio de la cita.
 * @param ctx.timeZone Zona IANA efectiva de la cita (ver `effectiveTimeZone`).
 * @returns El recordatorio aplazado a las 09:00 siguientes, o ya `skipped`
 * con `too_late` si esa hora no queda antes del inicio de la cita (como al
 * planificarlo), o `null` si se puede enviar ya.
 * @throws Error si no está `pending` o si la zona no es válida (fallos de
 * programación).
 */
export function holdForQuietHours(
  reminder: Reminder,
  ctx: { now: Date; startsAt: Date; timeZone: string },
): Reminder | null {
  if (reminder.attempts > 0) return null;
  const end = quietHoursEnd(ctx.now, ctx.timeZone);
  if (end === null) return null;
  return end < ctx.startsAt
    ? postponeReminder(reminder, end)
    : skipReminder(reminder, 'too_late');
}

/**
 * Apunta una llamada al proveedor y su resultado; siempre suma 1 a
 * `attempts`. `delivered` lo deja `sent` (con `sentAt`, `sentTo` y
 * `sendSeq`), `rejected` lo deja `failed`, y `retry` lo deja `pending` para
 * el siguiente intento de la política de reintentos, o `failed` si ya no
 * quedan. `scheduledFor` no cambia nunca.
 *
 * @param ctx.now Hora del servicio en que respondió (o falló) el proveedor.
 * @param ctx.to Teléfono al que se envió.
 * @param ctx.sendSeq Número de envío (secuencia `reminder_send_seq`); solo
 * con `delivered`.
 * @throws Error si no está `pending`, o si es `delivered` sin `sendSeq`
 * (fallos de programación).
 */
export function recordAttempt(
  reminder: Reminder,
  outcome: SendOutcome,
  ctx: { now: Date; to: string; sendSeq: number | null },
): Reminder {
  assertPending(reminder);
  const attempts = reminder.attempts + 1;
  if (outcome === 'delivered') {
    if (ctx.sendSeq === null) {
      throw new Error(`reminder ${reminder.id} delivered without send seq`);
    }
    return {
      ...reminder,
      status: 'sent',
      attempts,
      nextAttemptAt: null,
      sentAt: ctx.now,
      sentTo: ctx.to,
      sendSeq: ctx.sendSeq,
    };
  }
  const retryAt = outcome === 'retry' ? nextRetryAt(attempts, ctx.now) : null;
  if (retryAt === null) {
    return { ...reminder, status: 'failed', attempts, nextAttemptAt: null };
  }
  return { ...reminder, attempts, nextAttemptAt: retryAt };
}

function assertPending(reminder: Reminder): void {
  if (reminder.status !== 'pending') {
    throw new Error(`reminder ${reminder.id} is ${reminder.status}`);
  }
}

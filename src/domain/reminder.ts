import type { ReminderPlan } from './reminder-schedule.js';

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

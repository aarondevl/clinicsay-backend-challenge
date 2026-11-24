import type { EntityManager } from '@mikro-orm/postgresql';
import { ReminderRepository } from '../../../application/ports/repositories.js';
import type { Reminder } from '../../../domain/reminder.js';
import { ReminderEntity, type ReminderRow } from '../entities.js';

/** Recordatorios en Postgres, dentro de la transacción de `tx`. */
export class MikroOrmReminderRepository extends ReminderRepository {
  constructor(private readonly tx: EntityManager) {
    super();
  }

  /** Recordatorios de la cita por id ascendente (índice `reminder_by_appointment`). */
  async listByAppointment(appointmentId: string): Promise<Reminder[]> {
    const rows = await this.tx.find(
      ReminderEntity,
      { appointmentId },
      { orderBy: { id: 'asc' } },
    );
    return rows.map(toReminder);
  }

  /** Inserta el recordatorio (sin pasar por el identity map). */
  async insert(reminder: Reminder): Promise<void> {
    await this.tx.insert(ReminderEntity, {
      id: reminder.id,
      appointmentId: reminder.appointmentId,
      scheduledFor: reminder.scheduledFor,
      status: reminder.status,
      skipReason: reminder.skipReason,
      attempts: reminder.attempts,
      nextAttemptAt: reminder.nextAttemptAt,
      sentAt: reminder.sentAt,
      sentTo: reminder.sentTo,
      sendSeq: reminder.sendSeq,
    });
  }
}

function toReminder(row: ReminderRow): Reminder {
  return {
    id: row.id,
    appointmentId: row.appointmentId,
    scheduledFor: row.scheduledFor,
    status: row.status,
    skipReason: row.skipReason ?? null,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt ?? null,
    sentAt: row.sentAt ?? null,
    sentTo: row.sentTo ?? null,
    sendSeq: row.sendSeq ?? null,
  };
}

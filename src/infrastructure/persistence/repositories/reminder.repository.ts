import { type EntityManager, LockMode } from '@mikro-orm/postgresql';
import { ReminderRepository } from '../../../application/ports/repositories.js';
import type { Reminder } from '../../../domain/reminder.js';
import { ReminderEntity, type ReminderRow } from '../entities.js';

/** Opciones de toda lectura: sin identity map (ver la clase). */
const READ = { disableIdentityMap: true } as const;

/**
 * Recordatorios en Postgres, dentro de la transacción de `tx`. Las escrituras son
 * sentencias directas y las lecturas no usan el identity map: con él, una
 * lectura tras un `update` en la misma transacción devolvía la fila vieja
 * (`findOne` ni consulta, y `find` no pisa un valor con `null`).
 */
export class MikroOrmReminderRepository extends ReminderRepository {
  constructor(private readonly tx: EntityManager) {
    super();
  }

  /** Recordatorios de la cita por id ascendente (índice `reminder_by_appointment`). */
  async listByAppointment(appointmentId: string): Promise<Reminder[]> {
    const rows = await this.tx.find(
      ReminderEntity,
      { appointmentId },
      { ...READ, orderBy: { id: 'asc' } },
    );
    return rows.map(toReminder);
  }

  /** Pendientes de la cita con `SELECT ... FOR UPDATE`, por id ascendente. */
  async lockPendingByAppointment(appointmentId: string): Promise<Reminder[]> {
    const rows = await this.tx.find(
      ReminderEntity,
      { appointmentId, status: 'pending' },
      { ...READ, orderBy: { id: 'asc' }, lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return rows.map(toReminder);
  }

  /**
   * Siguiente pendiente que toca con `SELECT ... FOR UPDATE SKIP LOCKED`
   * (índice `reminder_due`); se salta las filas que otra transacción tiene
   * bloqueadas en vez de esperarlas.
   */
  async lockNextDue(now: Date, excludeIds: string[]): Promise<Reminder | null> {
    const row = await this.tx.findOne(
      ReminderEntity,
      {
        status: 'pending',
        nextAttemptAt: { $lte: now },
        // Sin ids que excluir no se añade la condición: `not in ()` no es SQL válido.
        ...(excludeIds.length > 0 ? { id: { $nin: excludeIds } } : {}),
      },
      {
        ...READ,
        orderBy: { nextAttemptAt: 'asc', id: 'asc' },
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
      },
    );
    return row ? toReminder(row) : null;
  }

  /** `nextval('reminder_send_seq')`; Postgres devuelve el `bigint` como texto. */
  async nextSendSequence(): Promise<number> {
    const row = await this.tx.execute<{ seq: string }>(
      `select nextval('reminder_send_seq') as seq`,
      [],
      'get',
    );
    return Number(row.seq);
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

  /** Sobrescribe la fila con un `UPDATE` directo (sin pasar por el identity map). */
  async update(reminder: Reminder): Promise<void> {
    await this.tx.nativeUpdate(
      ReminderEntity,
      { id: reminder.id },
      {
        appointmentId: reminder.appointmentId,
        scheduledFor: reminder.scheduledFor,
        status: reminder.status,
        skipReason: reminder.skipReason,
        attempts: reminder.attempts,
        nextAttemptAt: reminder.nextAttemptAt,
        sentAt: reminder.sentAt,
        sentTo: reminder.sentTo,
        sendSeq: reminder.sendSeq,
      },
    );
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

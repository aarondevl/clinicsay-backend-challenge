import { type EntityManager, LockMode } from '@mikro-orm/postgresql';
import { AppointmentRepository } from '../../../application/ports/repositories.js';
import type { Appointment } from '../../../domain/appointment.js';
import { AppointmentEntity, type AppointmentRow } from '../entities.js';

/** Opciones de toda lectura: sin identity map (ver la clase). */
const READ = { disableIdentityMap: true } as const;

/**
 * Citas en Postgres, dentro de la transacción de `tx`. Las escrituras son
 * sentencias directas y las lecturas no usan el identity map: con él, una
 * lectura tras un `update` en la misma transacción devolvía la fila vieja
 * (`findOne` ni consulta, y `find` no pisa un valor con `null`).
 */
export class MikroOrmAppointmentRepository extends AppointmentRepository {
  constructor(private readonly tx: EntityManager) {
    super();
  }

  /** Busca la cita por id; `null` si no existe. */
  async findById(id: string): Promise<Appointment | null> {
    const row = await this.tx.findOne(AppointmentEntity, { id }, READ);
    return row ? toAppointment(row) : null;
  }

  /** Busca la cita por id con `SELECT ... FOR UPDATE`; `null` si no existe. */
  async lockById(id: string): Promise<Appointment | null> {
    const row = await this.tx.findOne(
      AppointmentEntity,
      { id },
      { ...READ, lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return row ? toAppointment(row) : null;
  }

  /**
   * Una sentencia con `FOR UPDATE OF a` (índice `reminder_last_sent`): bloquea
   * la cita y no el recordatorio, que no cambia. Si espera el bloqueo,
   * Postgres vuelve a evaluar el `where` con la fila que confirmó la otra
   * transacción y, si ya no cumple, sigue con la siguiente por `send_seq`.
   * Después se lee la cita entera, ya bloqueada.
   */
  async lockLatestRepliable(
    phone: string,
    now: Date,
  ): Promise<Appointment | null> {
    const [row] = await this.tx.execute<{ id: string }[]>(
      `select a.id from appointment a
        join reminder r on r.appointment_id = a.id
        where r.status = 'sent' and r.sent_to = ?
          and a.status <> 'cancelled' and a.starts_at > ?
        order by r.send_seq desc
        limit 1
        for update of a`,
      [phone, now],
      'all',
    );
    return row ? this.findById(row.id) : null;
  }

  /** Inserta la cita (sin pasar por el identity map). */
  async insert(appointment: Appointment): Promise<void> {
    await this.tx.insert(AppointmentEntity, {
      id: appointment.id,
      clinicId: appointment.clinicId,
      patientId: appointment.patientId,
      startsAt: appointment.startsAt,
      status: appointment.status,
      virtual: appointment.virtual,
    });
  }

  /** Sobrescribe la fila con un `UPDATE` directo (sin pasar por el identity map). */
  async update(appointment: Appointment): Promise<void> {
    await this.tx.nativeUpdate(
      AppointmentEntity,
      { id: appointment.id },
      {
        clinicId: appointment.clinicId,
        patientId: appointment.patientId,
        startsAt: appointment.startsAt,
        status: appointment.status,
        virtual: appointment.virtual,
      },
    );
  }
}

function toAppointment(row: AppointmentRow): Appointment {
  return {
    id: row.id,
    clinicId: row.clinicId,
    patientId: row.patientId,
    startsAt: row.startsAt,
    status: row.status,
    virtual: row.virtual,
  };
}

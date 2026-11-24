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

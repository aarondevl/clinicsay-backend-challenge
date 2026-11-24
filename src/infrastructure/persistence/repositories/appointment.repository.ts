import type { EntityManager } from '@mikro-orm/postgresql';
import { AppointmentRepository } from '../../../application/ports/repositories.js';
import type { Appointment } from '../../../domain/appointment.js';
import { AppointmentEntity, type AppointmentRow } from '../entities.js';

/** Citas en Postgres, dentro de la transacción de `tx`. */
export class MikroOrmAppointmentRepository extends AppointmentRepository {
  constructor(private readonly tx: EntityManager) {
    super();
  }

  /** Busca la cita por id; `null` si no existe. */
  async findById(id: string): Promise<Appointment | null> {
    const row = await this.tx.findOne(AppointmentEntity, { id });
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

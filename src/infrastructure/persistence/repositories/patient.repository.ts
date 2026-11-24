import type { EntityManager } from '@mikro-orm/postgresql';
import { PatientRepository } from '../../../application/ports/repositories.js';
import type { Patient } from '../../../domain/patient.js';
import { PatientEntity, type PatientRow } from '../entities.js';

/** Pacientes en Postgres, dentro de la transacción de `tx`. */
export class MikroOrmPatientRepository extends PatientRepository {
  constructor(private readonly tx: EntityManager) {
    super();
  }

  /** Busca el paciente por id; `null` si no existe. */
  async findById(id: string): Promise<Patient | null> {
    const row = await this.tx.findOne(PatientEntity, { id });
    return row ? toPatient(row) : null;
  }

  /** Inserta el paciente (sin pasar por el identity map). */
  async insert(patient: Patient): Promise<void> {
    await this.tx.insert(PatientEntity, {
      id: patient.id,
      clinicId: patient.clinicId,
      name: patient.name,
      phone: patient.phone,
      acceptsReminders: patient.acceptsReminders,
    });
  }
}

function toPatient(row: PatientRow): Patient {
  return {
    id: row.id,
    clinicId: row.clinicId,
    name: row.name,
    phone: row.phone ?? null,
    acceptsReminders: row.acceptsReminders,
  };
}

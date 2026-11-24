import type { EntityManager } from '@mikro-orm/postgresql';
import { ClinicRepository } from '../../../application/ports/repositories.js';
import type { Clinic } from '../../../domain/clinic.js';
import { ClinicEntity, type ClinicRow } from '../entities.js';

/** Clínicas en Postgres, dentro de la transacción de `tx`. */
export class MikroOrmClinicRepository extends ClinicRepository {
  constructor(private readonly tx: EntityManager) {
    super();
  }

  /** Busca la clínica por id; `null` si no existe. */
  async findById(id: string): Promise<Clinic | null> {
    const row = await this.tx.findOne(ClinicEntity, { id });
    return row ? toClinic(row) : null;
  }

  /** Inserta la clínica (sin pasar por el identity map). */
  async insert(clinic: Clinic): Promise<void> {
    await this.tx.insert(ClinicEntity, {
      id: clinic.id,
      name: clinic.name,
      timezone: clinic.timezone,
    });
  }
}

function toClinic(row: ClinicRow): Clinic {
  return { id: row.id, name: row.name, timezone: row.timezone };
}

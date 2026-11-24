import type { Clinic } from '../../domain/clinic.js';
import type { Patient } from '../../domain/patient.js';

/** Clínicas guardadas. */
export abstract class ClinicRepository {
  /**
   * Devuelve la clínica con ese id, o `null` si no existe.
   * @param id Un UUID (el caso de uso lo comprueba antes con `isId`).
   */
  abstract findById(id: string): Promise<Clinic | null>;

  /** Guarda una clínica nueva. */
  abstract insert(clinic: Clinic): Promise<void>;
}

/** Pacientes guardados. */
export abstract class PatientRepository {
  /**
   * Devuelve el paciente con ese id, o `null` si no existe.
   * @param id Un UUID (el caso de uso lo comprueba antes con `isId`).
   */
  abstract findById(id: string): Promise<Patient | null>;

  /** Guarda un paciente nuevo. */
  abstract insert(patient: Patient): Promise<void>;
}

/** Repositorios ligados a una transacción; los entrega `Transactions.run`. */
export interface Repositories {
  clinics: ClinicRepository;
  patients: PatientRepository;
}

import { isId } from '../../domain/ids.js';
import type { Patient } from '../../domain/patient.js';
import { NotFoundError } from '../errors.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { Transactions } from '../ports/transactions.js';

export type CreatePatientInput = {
  clinicId: string;
  name: string;
  phone: string | null;
  acceptsReminders: boolean;
};

/** Caso de uso: crear un paciente de una clínica que existe. */
export class CreatePatient {
  constructor(
    private readonly transactions: Transactions,
    private readonly ids: IdGenerator,
  ) {}

  /**
   * Guarda un paciente nuevo con un id generado y lo devuelve. El formato del
   * teléfono ya viene validado (E.164 o `null`).
   * @throws {NotFoundError} si `clinicId` no es un UUID o la clínica no existe.
   */
  async execute(input: CreatePatientInput): Promise<Patient> {
    // Un id que no es UUID ni se busca: Postgres fallaría al convertirlo.
    if (!isId(input.clinicId)) throw new NotFoundError('clinic not found');
    return this.transactions.run(async (repos) => {
      const clinic = await repos.clinics.findById(input.clinicId);
      if (!clinic) throw new NotFoundError('clinic not found');
      const patient: Patient = {
        id: this.ids.next(),
        clinicId: clinic.id,
        name: input.name,
        phone: input.phone,
        acceptsReminders: input.acceptsReminders,
      };
      await repos.patients.insert(patient);
      return patient;
    });
  }
}

import type { Clinic } from '../../domain/clinic.js';
import { isValidTimeZone } from '../../domain/time-zones.js';
import { ValidationError } from '../errors.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { Transactions } from '../ports/transactions.js';

export type CreateClinicInput = { name: string; timezone: string };

/** Caso de uso: crear una clínica. */
export class CreateClinic {
  constructor(
    private readonly transactions: Transactions,
    private readonly ids: IdGenerator,
  ) {}

  /**
   * Guarda una clínica nueva con un id generado y la devuelve.
   * @throws {ValidationError} si `timezone` no es una zona IANA que exista.
   */
  async execute(input: CreateClinicInput): Promise<Clinic> {
    if (!isValidTimeZone(input.timezone)) {
      throw new ValidationError('timezone must be a valid IANA time zone');
    }
    const clinic: Clinic = {
      id: this.ids.next(),
      name: input.name,
      timezone: input.timezone,
    };
    await this.transactions.run((repos) => repos.clinics.insert(clinic));
    return clinic;
  }
}

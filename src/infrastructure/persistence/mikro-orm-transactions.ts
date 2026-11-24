import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { Logger } from '@nestjs/common';
import { ServiceUnavailableError } from '../../application/errors.js';
import type { Repositories } from '../../application/ports/repositories.js';
import { Transactions } from '../../application/ports/transactions.js';
import { isDatabaseUnavailable } from './database-unavailable.js';
import { MikroOrmAppointmentRepository } from './repositories/appointment.repository.js';
import { MikroOrmClinicRepository } from './repositories/clinic.repository.js';
import { MikroOrmPatientRepository } from './repositories/patient.repository.js';
import { MikroOrmReminderRepository } from './repositories/reminder.repository.js';

/**
 * Cada `run` abre un fork del EntityManager y una transacción en él. Es
 * también la fábrica de repositorios: se crean aquí, uno por transacción,
 * porque viven ligados a su `tx`. El EntityManager global no se usa nunca.
 */
export class MikroOrmTransactions extends Transactions {
  private readonly logger = new Logger(MikroOrmTransactions.name);

  constructor(private readonly orm: MikroORM) {
    super();
  }

  /**
   * Ejecuta `work` en una transacción; MikroORM hace rollback si lanza.
   * @throws {ServiceUnavailableError} si la base no responde (503). Cualquier
   * otro error, propio o no, se relanza tal cual.
   */
  async run<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em
        .fork()
        .transactional((tx) => work(buildRepositories(tx)));
    } catch (error) {
      if (!isDatabaseUnavailable(error)) throw error;
      this.logger.error('database unavailable', error);
      throw new ServiceUnavailableError('database unavailable', {
        cause: error,
      });
    }
  }
}

function buildRepositories(tx: EntityManager): Repositories {
  return {
    clinics: new MikroOrmClinicRepository(tx),
    patients: new MikroOrmPatientRepository(tx),
    appointments: new MikroOrmAppointmentRepository(tx),
    reminders: new MikroOrmReminderRepository(tx),
  };
}

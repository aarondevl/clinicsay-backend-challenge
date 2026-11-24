import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { Repositories } from '../../application/ports/repositories.js';
import { Transactions } from '../../application/ports/transactions.js';
import { MikroOrmClinicRepository } from './repositories/clinic.repository.js';
import { MikroOrmPatientRepository } from './repositories/patient.repository.js';

/**
 * Cada `run` abre un fork del EntityManager y una transacción en él. Los
 * repositorios se crean aquí, por transacción, porque viven ligados a su
 * `tx`; el EntityManager global no se usa nunca.
 */
export class MikroOrmTransactions extends Transactions {
  constructor(private readonly orm: MikroORM) {
    super();
  }

  /** Ejecuta `work` en una transacción; MikroORM hace rollback si lanza. */
  run<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    return this.orm.em
      .fork()
      .transactional((tx) => work(buildRepositories(tx)));
  }
}

function buildRepositories(tx: EntityManager): Repositories {
  return {
    clinics: new MikroOrmClinicRepository(tx),
    patients: new MikroOrmPatientRepository(tx),
  };
}

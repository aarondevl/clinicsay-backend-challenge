import type { Repositories } from '../../src/application/ports/repositories.js';
import type { Transactions } from '../../src/application/ports/transactions.js';

/** Transacción abierta por `holdLock` que retiene sus bloqueos. */
export interface HeldLock {
  /** Deja seguir a la transacción: ejecuta `then` y confirma. */
  release: () => void;
  /** Termina cuando la transacción confirma (o rechaza si falla). */
  done: Promise<void>;
}

/**
 * Abre una transacción que ejecuta `lock` y se queda con el bloqueo hasta
 * que se llame a `release`; entonces ejecuta `then` y confirma. Vuelve en
 * cuanto `lock` terminó, así que el bloqueo ya está tomado.
 */
export async function holdLock(
  transactions: Transactions,
  lock: (repos: Repositories) => Promise<unknown>,
  then: (repos: Repositories) => Promise<void> = async () => {},
): Promise<HeldLock> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  const done = transactions.run(async (repos) => {
    await lock(repos);
    locked();
    await released;
    await then(repos);
  });
  // Si la transacción falla antes de bloquear, el test falla ya y no espera.
  await Promise.race([
    isLocked,
    done.then(() => {
      throw new Error('transaction finished without holding the lock');
    }),
  ]);
  return { release, done };
}

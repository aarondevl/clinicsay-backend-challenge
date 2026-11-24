import { ShutdownCoordinator } from './shutdown-coordinator.js';

/** Promesa que el test resuelve o rechaza cuando quiere. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Deja correr las microtareas y los temporizadores pendientes. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('ShutdownCoordinator', () => {
  it('track devuelve el mismo valor que el trabajo', async () => {
    const coordinator = new ShutdownCoordinator();
    await expect(coordinator.track(Promise.resolve(7))).resolves.toBe(7);
  });

  it('track devuelve el mismo error que el trabajo', async () => {
    const coordinator = new ShutdownCoordinator();
    const error = new Error('boom');
    await expect(coordinator.track(Promise.reject(error))).rejects.toBe(error);
  });

  it('la señal solo se aborta al empezar el cierre', async () => {
    const coordinator = new ShutdownCoordinator();
    expect(coordinator.signal.aborted).toBe(false);
    await coordinator.beforeApplicationShutdown();
    expect(coordinator.signal.aborted).toBe(true);
  });

  it('el cierre aborta la señal en cuanto empieza y espera a lo que está en curso', async () => {
    const coordinator = new ShutdownCoordinator();
    const work = deferred<string>();
    const tracked = coordinator.track(work.promise);

    let shutDown = false;
    const shutdown = coordinator.beforeApplicationShutdown().then(() => {
      shutDown = true;
    });
    await settle();
    expect(coordinator.signal.aborted).toBe(true);
    expect(shutDown).toBe(false);

    work.resolve('done');
    await shutdown;
    expect(shutDown).toBe(true);
    await expect(tracked).resolves.toBe('done');
  });

  it('el cierre espera también a un trabajo que acaba fallando, sin fallar él', async () => {
    const coordinator = new ShutdownCoordinator();
    const work = deferred<string>();
    const tracked = coordinator.track(work.promise);
    const failed = expect(tracked).rejects.toThrow('boom');

    let shutDown = false;
    const shutdown = coordinator.beforeApplicationShutdown().then(() => {
      shutDown = true;
    });
    await settle();
    expect(shutDown).toBe(false);

    work.reject(new Error('boom'));
    await expect(shutdown).resolves.toBeUndefined();
    await failed;
  });
});

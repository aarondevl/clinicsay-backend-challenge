import { type BeforeApplicationShutdown, Injectable } from '@nestjs/common';

/**
 * Cierre ordenado de las pasadas del job. Al apagar la app (SIGTERM o
 * `app.close()`), aborta `signal` para que ninguna pasada tome otro
 * recordatorio y espera a las que estén en curso, que terminan y guardan el
 * que tienen entre manos.
 *
 * Lo hace en `beforeApplicationShutdown` porque Nest lo llama antes de
 * cerrar el servidor HTTP y antes de `onApplicationShutdown`, que es cuando
 * MikroORM cierra la base: así la pasada todavía puede confirmar.
 */
@Injectable()
export class ShutdownCoordinator implements BeforeApplicationShutdown {
  private readonly controller = new AbortController();
  private readonly running = new Set<Promise<unknown>>();

  /** Se aborta al empezar el cierre; las pasadas lo miran antes de cada recordatorio. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /**
   * Registra `work` para que el cierre lo espere y lo devuelve tal cual
   * (mismo valor o mismo error).
   */
  track<T>(work: Promise<T>): Promise<T> {
    this.running.add(work);
    return work.finally(() => {
      this.running.delete(work);
    });
  }

  /** Aborta `signal` y espera a todo lo registrado con `track`, acabe bien o mal. */
  async beforeApplicationShutdown(): Promise<void> {
    this.controller.abort();
    await Promise.allSettled(this.running);
  }
}

import { SettableClock } from '../../application/ports/clock.js';

/**
 * Hasta el primer `set` devuelve la hora del sistema; después queda congelado
 * en la hora fijada hasta el siguiente `set`.
 */
export class TestClock extends SettableClock {
  private frozen: Date | null = null;

  now(): Date {
    return this.frozen ? new Date(this.frozen) : new Date();
  }

  set(now: Date): void {
    this.frozen = new Date(now);
  }
}

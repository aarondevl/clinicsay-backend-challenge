/** Única fuente de la hora de negocio. */
export abstract class Clock {
  abstract now(): Date;
}

/** Reloj que se puede fijar desde fuera; solo existe con CLOCK_MODE=test. */
export abstract class SettableClock extends Clock {
  abstract set(now: Date): void;
}

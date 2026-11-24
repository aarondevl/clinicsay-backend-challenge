import { hasStarted, rescheduleAppointment } from '../../domain/appointment.js';
import { isId } from '../../domain/ids.js';
import { cancelReminder, newReminder } from '../../domain/reminder.js';
import { planReminder } from '../../domain/reminder-schedule.js';
import { effectiveTimeZone } from '../../domain/time-zones.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import type { Clock } from '../ports/clock.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { Transactions } from '../ports/transactions.js';
import type { AppointmentView } from './appointment-view.js';

/** Caso de uso: mover una cita a otra hora con un recordatorio nuevo. */
export class RescheduleAppointment {
  constructor(
    private readonly transactions: Transactions,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  /**
   * Mueve la cita a `startsAt`: su recordatorio pendiente pasa a `cancelled`
   * (uno ya `sent` se queda `sent`), se crea otro planificado para la hora
   * nueva con la zona efectiva de la cita y una cita `confirmed` vuelve a
   * `scheduled`.
   *
   * @throws {NotFoundError} si la cita no existe o `id` no es un UUID.
   * @throws {ConflictError} si la cita está cancelada o ya empezó.
   * @throws {ValidationError} si `startsAt` no es posterior a la hora del
   * servicio.
   */
  async execute(id: string, startsAt: Date): Promise<AppointmentView> {
    // Un id que no es UUID ni se busca: Postgres fallaría al convertirlo.
    if (!isId(id)) throw new NotFoundError('appointment not found');
    return this.transactions.run(async (repos) => {
      // Primero la cita y después sus pendientes, siempre en este orden: dos
      // PATCH a la vez se ponen en fila aquí y el segundo ve el pendiente nuevo.
      const appointment = await repos.appointments.lockById(id);
      if (!appointment) throw new NotFoundError('appointment not found');

      // Estado (409) antes que la regla de negocio (400).
      const now = this.clock.now();
      if (appointment.status === 'cancelled') {
        throw new ConflictError('appointment is cancelled');
      }
      if (hasStarted(appointment, now)) {
        throw new ConflictError('appointment has already started');
      }
      if (startsAt <= now) {
        throw new ValidationError('startsAt must be in the future');
      }

      const clinic = await repos.clinics.findById(appointment.clinicId);
      // La clave foránea lo garantiza: si falta, es un fallo de programación.
      if (!clinic) throw new Error(`clinic of appointment ${id} not found`);

      const rescheduled = rescheduleAppointment(appointment, startsAt);
      // El índice `reminder_one_pending` obliga a cancelar antes de insertar.
      const pending = await repos.reminders.lockPendingByAppointment(id);
      for (const reminder of pending) {
        await repos.reminders.update(cancelReminder(reminder));
      }
      const plan = planReminder({
        startsAt,
        timeZone: effectiveTimeZone(clinic.timezone, rescheduled.virtual),
        now,
      });
      await repos.reminders.insert(newReminder(this.ids.next(), id, plan));
      await repos.appointments.update(rescheduled);
      const reminders = await repos.reminders.listByAppointment(id);
      return { appointment: rescheduled, reminders };
    });
  }
}

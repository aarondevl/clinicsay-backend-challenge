import { cancelAppointment } from '../../domain/appointment.js';
import { isId } from '../../domain/ids.js';
import { cancelReminder } from '../../domain/reminder.js';
import { NotFoundError } from '../errors.js';
import type { Transactions } from '../ports/transactions.js';
import type { AppointmentView } from './appointment-view.js';

/** Caso de uso: cancelar una cita y su recordatorio pendiente. */
export class CancelAppointment {
  constructor(private readonly transactions: Transactions) {}

  /**
   * Deja la cita `cancelled` y su recordatorio pendiente `cancelled`; los
   * demás recordatorios se quedan como están. Si ya estaba cancelada, devuelve
   * la cita sin escribir nada.
   *
   * @throws {NotFoundError} si la cita no existe o `id` no es un UUID.
   */
  async execute(id: string): Promise<AppointmentView> {
    // Un id que no es UUID ni se busca: Postgres fallaría al convertirlo.
    if (!isId(id)) throw new NotFoundError('appointment not found');
    return this.transactions.run(async (repos) => {
      // Mismo orden de bloqueo que al reprogramar: la cita y luego los pendientes.
      const appointment = await repos.appointments.lockById(id);
      if (!appointment) throw new NotFoundError('appointment not found');
      if (appointment.status === 'cancelled') {
        return {
          appointment,
          reminders: await repos.reminders.listByAppointment(id),
        };
      }

      const cancelled = cancelAppointment(appointment);
      const pending = await repos.reminders.lockPendingByAppointment(id);
      for (const reminder of pending) {
        await repos.reminders.update(cancelReminder(reminder));
      }
      await repos.appointments.update(cancelled);
      const reminders = await repos.reminders.listByAppointment(id);
      return { appointment: cancelled, reminders };
    });
  }
}

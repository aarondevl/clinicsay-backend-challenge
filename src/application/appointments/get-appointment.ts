import { isId } from '../../domain/ids.js';
import { NotFoundError } from '../errors.js';
import type { Transactions } from '../ports/transactions.js';
import type { AppointmentView } from './appointment-view.js';

/** Caso de uso: ver una cita con todos sus recordatorios. */
export class GetAppointment {
  constructor(private readonly transactions: Transactions) {}

  /**
   * Devuelve la cita y sus recordatorios ordenados por id (orden de creación).
   * @throws {NotFoundError} si la cita no existe o `id` no es un UUID.
   */
  async execute(id: string): Promise<AppointmentView> {
    // Un id que no es UUID ni se busca: Postgres fallaría al convertirlo.
    if (!isId(id)) throw new NotFoundError('appointment not found');
    return this.transactions.run(async (repos) => {
      const appointment = await repos.appointments.findById(id);
      if (!appointment) throw new NotFoundError('appointment not found');
      const reminders = await repos.reminders.listByAppointment(id);
      return { appointment, reminders };
    });
  }
}

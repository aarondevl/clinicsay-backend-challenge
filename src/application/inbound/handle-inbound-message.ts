import {
  cancelAppointment,
  canReceiveReply,
  confirmAppointment,
} from '../../domain/appointment.js';
import { parseReply } from '../../domain/patient-reply.js';
import { cancelReminder } from '../../domain/reminder.js';
import type { Clock } from '../ports/clock.js';
import type { Transactions } from '../ports/transactions.js';

/** Mensaje de un paciente tal como lo reenvía el proveedor. */
export type InboundMessage = {
  /** Único por mensaje; el proveedor puede repetir el aviso. */
  messageId: string;
  /** Teléfono desde el que respondió. */
  from: string;
  text: string;
  /** Cuándo lo recibió el proveedor; solo se guarda. */
  receivedAt: Date;
};

/**
 * Caso de uso: aplicar la respuesta de un paciente. SI confirma la cita y NO
 * la cancela junto con su recordatorio pendiente. Va a la cita del último
 * recordatorio enviado a ese teléfono entre las que no han empezado ni están
 * canceladas; cualquier otro texto, o un teléfono sin esa cita, se ignora.
 */
export class HandleInboundMessage {
  constructor(
    private readonly transactions: Transactions,
    private readonly clock: Clock,
  ) {}

  /**
   * Trata el mensaje en una transacción. Su `messageId` se registra en la
   * misma transacción que el efecto, así que uno repetido no hace nada,
   * aunque la primera vez se ignorara. No lanza errores propios por el
   * contenido: un mensaje que no se aplica termina sin cambios.
   *
   * @throws {ServiceUnavailableError} si la base no responde.
   */
  async execute(message: InboundMessage): Promise<void> {
    await this.transactions.run(async (repos) => {
      const isNew = await repos.inboundMessages.insertIfNew(
        message.messageId,
        message.receivedAt,
      );
      if (!isNew) return;
      const reply = parseReply(message.text);
      if (reply === null) return;

      // «No ha empezado» se mira con la hora del servicio, no con `receivedAt`.
      const now = this.clock.now();
      // Mismo orden de bloqueo que reprogramar y cancelar: la cita y después
      // sus pendientes.
      const appointment = await repos.appointments.lockLatestRepliable(
        message.from,
        now,
      );
      // Se vuelve a comprobar con la fila ya bloqueada: el puerto lo promete,
      // pero es la regla de negocio y vive en el dominio.
      if (!appointment || !canReceiveReply(appointment, now)) return;

      if (reply === 'yes') {
        await repos.appointments.update(confirmAppointment(appointment));
        return;
      }
      const pending = await repos.reminders.lockPendingByAppointment(
        appointment.id,
      );
      for (const reminder of pending) {
        await repos.reminders.update(cancelReminder(reminder));
      }
      await repos.appointments.update(cancelAppointment(appointment));
    });
  }
}

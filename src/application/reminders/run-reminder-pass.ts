import { classifyProviderResult } from '../../domain/provider-outcome.js';
import {
  recordAttempt,
  skipReasonAtSendTime,
  skipReminder,
} from '../../domain/reminder.js';
import { buildReminderText } from '../../domain/reminder-message.js';
import { effectiveTimeZone } from '../../domain/time-zones.js';
import { ServiceUnavailableError } from '../errors.js';
import type { Clock } from '../ports/clock.js';
import type { Logger } from '../ports/logger.js';
import type { MessageProvider } from '../ports/message-provider.js';
import type { Repositories } from '../ports/repositories.js';
import type { Transactions } from '../ports/transactions.js';

/** Resultado de una pasada del job. */
export type ReminderPassResult = {
  /** Recordatorios que trató esta pasada: enviados, reintentados, fallidos o descartados. */
  processed: number;
};

/**
 * Caso de uso: una pasada del job de envío. Trata, uno a uno y de todas las
 * clínicas, los recordatorios pendientes a los que ya les toca según el reloj
 * del servicio. Varias pasadas a la vez no toman nunca el mismo.
 */
export class RunReminderPass {
  constructor(
    private readonly transactions: Transactions,
    private readonly clock: Clock,
    private readonly provider: MessageProvider,
    private readonly logger: Logger,
  ) {}

  /**
   * Trata recordatorios hasta que no quede ninguno que toque o se aborte
   * `signal`. Cada uno va en su propia transacción: se bloquea, se vuelven a
   * comprobar los descartes con la hora del servicio, se llama al proveedor
   * con `Idempotency-Key` = id del recordatorio y se guarda el resultado
   * antes del `COMMIT`.
   *
   * Si un recordatorio lanza cualquier otro error, su transacción se deshace,
   * se registra con su id y la pasada sigue con los demás. No cuenta en
   * `processed` y sigue `pending` para las pasadas siguientes.
   *
   * @param signal Al abortarse no se toma ningún recordatorio más; el que
   * esté en curso termina y se guarda (cierre ordenado).
   * @throws {ServiceUnavailableError} si la base no responde; lo ya tratado
   * queda guardado.
   * @throws el error tal cual si llega antes de tomar ningún recordatorio.
   */
  async execute(signal?: AbortSignal): Promise<ReminderPassResult> {
    // Los que ya tomó esta pasada, tratados o con error, no se vuelven a
    // tomar aunque sigan pendientes: así la pasada siempre termina.
    const taken: string[] = [];
    let processed = 0;
    while (!signal?.aborted) {
      const before = taken.length;
      try {
        const found = await this.transactions.run((repos) =>
          this.handleNext(repos, taken),
        );
        if (!found) break;
        processed++;
      } catch (error) {
        // `handleNext` apunta el id en cuanto lo bloquea, así que sigue ahí
        // aunque la transacción se haya deshecho.
        const failedId = taken.length > before ? taken.at(-1) : undefined;
        // La base caída corta la pasada (503). Sin recordatorio tomado no hay
        // a quién apartar, y seguir repetiría el mismo error sin fin.
        if (
          error instanceof ServiceUnavailableError ||
          failedId === undefined
        ) {
          throw error;
        }
        // No se marca `failed`: el error pudo llegar después de que el
        // proveedor lo aceptara. La pasada siguiente lo repite con la misma
        // `Idempotency-Key`, sin duplicar el mensaje.
        this.logger.error(
          `reminder ${failedId} failed and stays pending`,
          error,
        );
      }
    }
    return { processed };
  }

  /**
   * Trata el siguiente recordatorio que toca y apunta su id en `taken` en
   * cuanto lo bloquea. Devuelve `false` si no queda ninguno.
   */
  private async handleNext(
    repos: Repositories,
    taken: string[],
  ): Promise<boolean> {
    const reminder = await repos.reminders.lockNextDue(this.clock.now(), taken);
    if (!reminder) return false;
    taken.push(reminder.id);

    // La cita se lee sin bloquearla. Con el recordatorio bloqueado, esperar
    // el bloqueo de la cita cerraría un ciclo con un PATCH o un cancelar, que
    // bloquean primero la cita y después esperan a este recordatorio, y
    // Postgres abortaría uno con 40P01. Ellos esperan a que esto confirme y
    // ven el estado final.
    const appointment = await repos.appointments.findById(
      reminder.appointmentId,
    );
    // Las claves foráneas lo garantizan: si falta algo, es un fallo de programación.
    if (!appointment) {
      throw new Error(`appointment of reminder ${reminder.id} not found`);
    }
    const patient = await repos.patients.findById(appointment.patientId);
    if (!patient) {
      throw new Error(`patient of appointment ${appointment.id} not found`);
    }
    const clinic = await repos.clinics.findById(appointment.clinicId);
    if (!clinic) {
      throw new Error(`clinic of appointment ${appointment.id} not found`);
    }

    // Se comprueba en cada intento: la cita puede empezar entre dos.
    const reason = skipReasonAtSendTime({
      startsAt: appointment.startsAt,
      now: this.clock.now(),
      phone: patient.phone,
      acceptsReminders: patient.acceptsReminders,
    });
    const to = patient.phone;
    // Sin motivo, `to` nunca es null (sería `no_phone`): esto solo estrecha el tipo.
    if (reason !== null || to === null) {
      await repos.reminders.update(
        skipReminder(reminder, reason ?? 'no_phone'),
      );
      return true;
    }

    const result = await this.provider.send({
      idempotencyKey: reminder.id,
      to,
      text: buildReminderText({
        patientName: patient.name,
        clinicName: clinic.name,
        startsAt: appointment.startsAt,
        timeZone: effectiveTimeZone(clinic.timezone, appointment.virtual),
      }),
    });
    const outcome = classifyProviderResult(result);
    const sendSeq =
      outcome === 'delivered' ? await repos.reminders.nextSendSequence() : null;
    // La hora de después de la llamada: `sentAt` es cuando el proveedor lo
    // aceptó, y el reintento cuenta desde el fallo.
    await repos.reminders.update(
      recordAttempt(reminder, outcome, { now: this.clock.now(), to, sendSeq }),
    );
    return true;
  }
}

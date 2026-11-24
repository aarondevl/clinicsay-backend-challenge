import type { Appointment } from '../../domain/appointment.js';
import { isId } from '../../domain/ids.js';
import { newReminder } from '../../domain/reminder.js';
import { planReminder } from '../../domain/reminder-schedule.js';
import { effectiveTimeZone } from '../../domain/time-zones.js';
import { NotFoundError, ValidationError } from '../errors.js';
import type { Clock } from '../ports/clock.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { Transactions } from '../ports/transactions.js';
import type { AppointmentView } from './appointment-view.js';

export type CreateAppointmentInput = {
  clinicId: string;
  patientId: string;
  startsAt: Date;
  virtual: boolean;
};

/** Caso de uso: crear una cita y su recordatorio. */
export class CreateAppointment {
  constructor(
    private readonly transactions: Transactions,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  /**
   * Guarda una cita `scheduled` y su recordatorio, planificado con la zona
   * efectiva de la cita (la de la clínica, o Madrid si es virtual). Si no da
   * tiempo a enviarlo, el recordatorio nace `skipped` con `too_late`.
   *
   * @throws {NotFoundError} si la clínica o el paciente no existen o su id no
   * es un UUID.
   * @throws {ValidationError} si el paciente es de otra clínica o `startsAt`
   * no es posterior a la hora del servicio.
   */
  async execute(input: CreateAppointmentInput): Promise<AppointmentView> {
    return this.transactions.run(async (repos) => {
      // Un id que no es UUID ni se busca: Postgres fallaría al convertirlo.
      const clinic = isId(input.clinicId)
        ? await repos.clinics.findById(input.clinicId)
        : null;
      if (!clinic) throw new NotFoundError('clinic not found');
      const patient = isId(input.patientId)
        ? await repos.patients.findById(input.patientId)
        : null;
      if (!patient) throw new NotFoundError('patient not found');

      // Reglas de negocio después de la existencia (404 antes que 400).
      if (patient.clinicId !== clinic.id) {
        throw new ValidationError('patient does not belong to clinic');
      }
      const now = this.clock.now();
      if (input.startsAt <= now) {
        throw new ValidationError('startsAt must be in the future');
      }

      const appointment: Appointment = {
        id: this.ids.next(),
        clinicId: clinic.id,
        patientId: patient.id,
        startsAt: input.startsAt,
        status: 'scheduled',
        virtual: input.virtual,
      };
      const plan = planReminder({
        startsAt: appointment.startsAt,
        timeZone: effectiveTimeZone(clinic.timezone, appointment.virtual),
        now,
      });
      const reminder = newReminder(this.ids.next(), appointment.id, plan);
      await repos.appointments.insert(appointment);
      await repos.reminders.insert(reminder);
      return { appointment, reminders: [reminder] };
    });
  }
}

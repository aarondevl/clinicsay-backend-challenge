import type { Appointment } from '../../domain/appointment.js';
import type { Clinic } from '../../domain/clinic.js';
import type { Patient } from '../../domain/patient.js';
import type { Reminder } from '../../domain/reminder.js';

/** Clínicas guardadas. */
export abstract class ClinicRepository {
  /**
   * Devuelve la clínica con ese id, o `null` si no existe.
   * @param id Un UUID (el caso de uso lo comprueba antes con `isId`).
   */
  abstract findById(id: string): Promise<Clinic | null>;

  /** Guarda una clínica nueva. */
  abstract insert(clinic: Clinic): Promise<void>;
}

/** Pacientes guardados. */
export abstract class PatientRepository {
  /**
   * Devuelve el paciente con ese id, o `null` si no existe.
   * @param id Un UUID (el caso de uso lo comprueba antes con `isId`).
   */
  abstract findById(id: string): Promise<Patient | null>;

  /** Guarda un paciente nuevo. */
  abstract insert(patient: Patient): Promise<void>;
}

/** Citas guardadas. */
export abstract class AppointmentRepository {
  /**
   * Devuelve la cita con ese id, o `null` si no existe.
   * @param id Un UUID (el caso de uso lo comprueba antes con `isId`).
   */
  abstract findById(id: string): Promise<Appointment | null>;

  /**
   * Como `findById`, pero bloquea la fila (`FOR UPDATE`) hasta el final de la
   * transacción; si otra la tiene, espera y devuelve lo que esa confirmó. Se
   * bloquea siempre la cita antes que sus recordatorios.
   * @param id Un UUID (el caso de uso lo comprueba antes con `isId`).
   */
  abstract lockById(id: string): Promise<Appointment | null>;

  /** Guarda una cita nueva. */
  abstract insert(appointment: Appointment): Promise<void>;

  /** Sobrescribe la cita guardada con ese id. */
  abstract update(appointment: Appointment): Promise<void>;
}

/** Recordatorios guardados. */
export abstract class ReminderRepository {
  /**
   * Devuelve todos los recordatorios de una cita, ordenados por id ascendente:
   * los ids crecen con cada creación y las fechas empatan con el reloj
   * congelado.
   */
  abstract listByAppointment(appointmentId: string): Promise<Reminder[]>;

  /**
   * Devuelve los recordatorios `pending` de la cita y los bloquea
   * (`FOR UPDATE`, sin `SKIP LOCKED`) hasta el final de la transacción. Si el
   * job está enviando uno, espera a que termine y ya no lo devuelve si dejó de
   * estar pendiente. Se llama después de bloquear la cita con `lockById`.
   */
  abstract lockPendingByAppointment(appointmentId: string): Promise<Reminder[]>;

  /**
   * Toma el siguiente recordatorio que le toca al job: `pending`, con
   * `nextAttemptAt <= now` y que no esté en `excludeIds`, el más antiguo por
   * `nextAttemptAt` y después por id. Lo bloquea (`FOR UPDATE SKIP LOCKED`)
   * hasta el final de la transacción y se salta, sin esperar, los que tenga
   * bloqueados otra; así varias pasadas a la vez nunca toman el mismo.
   * Devuelve `null` si no queda ninguno.
   *
   * @param now Hora del servicio (puerto `Clock`).
   * @param excludeIds Recordatorios que esta pasada ya trató.
   */
  abstract lockNextDue(
    now: Date,
    excludeIds: string[],
  ): Promise<Reminder | null>;

  /**
   * Devuelve el siguiente número de envío (secuencia `reminder_send_seq`).
   * Crece con cada llamada y ordena los envíos aunque `sentAt` empate con el
   * reloj congelado; solo se pide al quedar `sent`.
   */
  abstract nextSendSequence(): Promise<number>;

  /** Guarda un recordatorio nuevo. */
  abstract insert(reminder: Reminder): Promise<void>;

  /** Sobrescribe el recordatorio guardado con ese id. */
  abstract update(reminder: Reminder): Promise<void>;
}

/** Repositorios ligados a una transacción; los entrega `Transactions.run`. */
export interface Repositories {
  clinics: ClinicRepository;
  patients: PatientRepository;
  appointments: AppointmentRepository;
  reminders: ReminderRepository;
}

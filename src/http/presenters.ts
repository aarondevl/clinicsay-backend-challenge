import type { AppointmentView } from '../application/appointments/appointment-view.js';
import type { AppointmentStatus } from '../domain/appointment.js';
import type { Clinic } from '../domain/clinic.js';
import type { Patient } from '../domain/patient.js';
import type {
  Reminder,
  ReminderStatus,
  SkipReason,
} from '../domain/reminder.js';
import { toApiDate } from './api-date.js';

/** `Clinic` del contrato. */
export type ClinicResponse = { id: string; name: string; timezone: string };

/** `Patient` del contrato. */
export type PatientResponse = {
  id: string;
  clinicId: string;
  name: string;
  phone: string | null;
  acceptsReminders: boolean;
};

/** `Reminder` del contrato: sin los campos internos del job y del webhook. */
export type ReminderResponse = {
  id: string;
  scheduledFor: string;
  status: ReminderStatus;
  attempts: number;
  sentAt: string | null;
  skipReason: SkipReason | null;
};

/**
 * `Appointment` del contrato. `virtual` es una extensión: solo aparece, con
 * `true`, en las citas virtuales.
 */
export type AppointmentResponse = {
  id: string;
  clinicId: string;
  patientId: string;
  startsAt: string;
  status: AppointmentStatus;
  virtual?: true;
  reminders: ReminderResponse[];
};

/** Da a una clínica la forma de la respuesta del contrato. */
export function presentClinic(clinic: Clinic): ClinicResponse {
  return { id: clinic.id, name: clinic.name, timezone: clinic.timezone };
}

/** Da a un paciente la forma de la respuesta del contrato. */
export function presentPatient(patient: Patient): PatientResponse {
  return {
    id: patient.id,
    clinicId: patient.clinicId,
    name: patient.name,
    phone: patient.phone,
    acceptsReminders: patient.acceptsReminders,
  };
}

/**
 * Da a una cita y sus recordatorios la forma de la respuesta del contrato, con
 * las fechas en UTC por `toApiDate`. Una cita no virtual responde sin la clave
 * `virtual`, exactamente con la forma del contrato.
 */
export function presentAppointment(view: AppointmentView): AppointmentResponse {
  const { appointment } = view;
  return {
    id: appointment.id,
    clinicId: appointment.clinicId,
    patientId: appointment.patientId,
    startsAt: toApiDate(appointment.startsAt),
    status: appointment.status,
    ...(appointment.virtual ? { virtual: true as const } : {}),
    reminders: view.reminders.map(presentReminder),
  };
}

function presentReminder(reminder: Reminder): ReminderResponse {
  return {
    id: reminder.id,
    scheduledFor: toApiDate(reminder.scheduledFor),
    status: reminder.status,
    attempts: reminder.attempts,
    sentAt: reminder.sentAt ? toApiDate(reminder.sentAt) : null,
    skipReason: reminder.skipReason,
  };
}

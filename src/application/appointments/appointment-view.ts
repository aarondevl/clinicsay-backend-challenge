import type { Appointment } from '../../domain/appointment.js';
import type { Reminder } from '../../domain/reminder.js';

/** Una cita con todos sus recordatorios, del más antiguo al más nuevo. */
export type AppointmentView = {
  appointment: Appointment;
  reminders: Reminder[];
};

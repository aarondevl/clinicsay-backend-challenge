/** Estado de una cita. Nace `scheduled`; SI la confirma y NO la cancela. */
export type AppointmentStatus = 'scheduled' | 'confirmed' | 'cancelled';

/**
 * Cita de un paciente en una clínica. Con `virtual`, la hora de envío, la
 * franja de silencio y el texto usan la hora de Madrid (ver
 * `effectiveTimeZone`).
 */
export type Appointment = {
  id: string;
  clinicId: string;
  patientId: string;
  startsAt: Date;
  status: AppointmentStatus;
  virtual: boolean;
};

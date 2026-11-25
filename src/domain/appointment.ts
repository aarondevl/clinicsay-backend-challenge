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

/**
 * Indica si la cita ya empezó: su inicio es igual o anterior a `now`. Una cita
 * que empezó no se reprograma y su recordatorio queda `too_late`.
 *
 * @param now Hora del servicio (puerto `Clock`).
 */
export function hasStarted(appointment: Appointment, now: Date): boolean {
  return appointment.startsAt <= now;
}

/**
 * Mueve la cita a `startsAt`. Una cita `confirmed` vuelve a `scheduled`: la
 * confirmación era para la hora anterior. El caso de uso comprueba antes que
 * no esté cancelada ni haya empezado.
 */
export function rescheduleAppointment(
  appointment: Appointment,
  startsAt: Date,
): Appointment {
  return { ...appointment, startsAt, status: 'scheduled' };
}

/** Deja la cita `cancelled`, venga del estado que venga. */
export function cancelAppointment(appointment: Appointment): Appointment {
  return { ...appointment, status: 'cancelled' };
}

/** Deja la cita `confirmed` (el paciente respondió SI). */
export function confirmAppointment(appointment: Appointment): Appointment {
  return { ...appointment, status: 'confirmed' };
}

/**
 * Indica si una respuesta SI o NO del paciente se puede aplicar a la cita: no
 * está cancelada y no ha empezado (`hasStarted`).
 *
 * @param now Hora del servicio (puerto `Clock`), no la de recepción del mensaje.
 */
export function canReceiveReply(appointment: Appointment, now: Date): boolean {
  return appointment.status !== 'cancelled' && !hasStarted(appointment, now);
}

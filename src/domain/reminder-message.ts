import { localDateTime } from './time-zones.js';

/**
 * Compone el texto del recordatorio, carácter por carácter como en
 * `openapi.yaml`, con la fecha y la hora de inicio en la zona indicada.
 *
 * @param input.timeZone Zona IANA efectiva de la cita (ver `effectiveTimeZone`).
 * @throws Error si `timeZone` no es una zona IANA válida (el llamador la valida antes).
 */
export function buildReminderText(input: {
  patientName: string;
  clinicName: string;
  startsAt: Date;
  timeZone: string;
}): string {
  const local = localDateTime(input.startsAt, input.timeZone);
  const date = local.toFormat('dd/MM/yyyy');
  const time = local.toFormat('HH:mm');
  return `Hola ${input.patientName}, te recordamos tu cita en ${input.clinicName} el ${date} a las ${time}. Responde SI para confirmar o NO para cancelar.`;
}

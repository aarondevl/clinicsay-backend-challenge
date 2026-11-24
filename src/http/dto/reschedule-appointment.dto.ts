import { IsIsoDateTimeWithZone } from '../validation.js';

/** Cuerpo de `PATCH /appointments/{id}`: la nueva hora de inicio, con zona. */
export class RescheduleAppointmentDto {
  @IsIsoDateTimeWithZone()
  startsAt!: string;
}

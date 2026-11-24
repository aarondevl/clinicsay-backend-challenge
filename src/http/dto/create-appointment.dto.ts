import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { IsIsoDateTimeWithZone } from '../validation.js';

/**
 * Cuerpo de `POST /appointments`. Los ids solo se comprueban como texto: si no
 * son UUID, `CreateAppointment` responde 404 como con uno que no existe.
 */
export class CreateAppointmentDto {
  @IsString()
  clinicId!: string;

  @IsString()
  patientId!: string;

  @IsIsoDateTimeWithZone()
  startsAt!: string;

  // Extensión del contrato: ausente (o `null`) equivale a `false`.
  @IsOptional()
  @IsBoolean()
  virtual?: boolean | null;
}

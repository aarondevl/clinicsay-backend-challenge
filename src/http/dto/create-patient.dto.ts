import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';
import { E164 } from '../../domain/patient.js';
import { IsStorableText, MAX_TEXT_LENGTH } from '../validation.js';

/**
 * Cuerpo de `POST /patients`. `clinicId` solo se comprueba como texto: si no
 * es un UUID, `CreatePatient` responde 404 como con una clínica que no existe.
 */
export class CreatePatientDto {
  @IsString()
  clinicId!: string;

  @IsStorableText(MAX_TEXT_LENGTH.name)
  @MinLength(1)
  name!: string;

  // `@IsOptional` deja pasar `null` y la ausencia; las dos son «sin teléfono».
  @IsOptional()
  @Matches(E164, { message: 'phone must be an E.164 number or null' })
  phone?: string | null;

  @IsBoolean()
  acceptsReminders!: boolean;
}

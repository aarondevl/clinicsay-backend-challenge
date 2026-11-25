import { IsString, MinLength } from 'class-validator';
import { IsStorableText, MAX_TEXT_LENGTH } from '../validation.js';

/** Cuerpo de `POST /clinics`. La zona se valida en `CreateClinic`. */
export class CreateClinicDto {
  @IsStorableText(MAX_TEXT_LENGTH.name)
  @MinLength(1)
  name!: string;

  @IsString()
  timezone!: string;
}

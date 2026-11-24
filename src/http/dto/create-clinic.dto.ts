import { IsString, MinLength } from 'class-validator';

/** Cuerpo de `POST /clinics`. La zona se valida en `CreateClinic`. */
export class CreateClinicDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsString()
  timezone!: string;
}

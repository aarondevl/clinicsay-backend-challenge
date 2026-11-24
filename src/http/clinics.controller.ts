import { Body, Controller, Post } from '@nestjs/common';
import { CreateClinic } from '../application/clinics/create-clinic.js';
import { CreateClinicDto } from './dto/create-clinic.dto.js';
import { type ClinicResponse, presentClinic } from './presenters.js';

@Controller('clinics')
export class ClinicsController {
  constructor(private readonly createClinic: CreateClinic) {}

  /**
   * `POST /clinics` → 201 con la clínica.
   * @throws {ValidationError} (400) si la zona no es IANA; ver `CreateClinic`.
   */
  @Post()
  async create(@Body() body: CreateClinicDto): Promise<ClinicResponse> {
    const clinic = await this.createClinic.execute({
      name: body.name,
      timezone: body.timezone,
    });
    return presentClinic(clinic);
  }
}

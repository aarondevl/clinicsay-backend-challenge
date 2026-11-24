import { Body, Controller, Post } from '@nestjs/common';
import { CreatePatient } from '../application/patients/create-patient.js';
import { CreatePatientDto } from './dto/create-patient.dto.js';
import { type PatientResponse, presentPatient } from './presenters.js';

@Controller('patients')
export class PatientsController {
  constructor(private readonly createPatient: CreatePatient) {}

  /**
   * `POST /patients` → 201 con el paciente; sin `phone`, queda `null`.
   * @throws {NotFoundError} (404) si la clínica no existe; ver `CreatePatient`.
   */
  @Post()
  async create(@Body() body: CreatePatientDto): Promise<PatientResponse> {
    const patient = await this.createPatient.execute({
      clinicId: body.clinicId,
      name: body.name,
      phone: body.phone ?? null,
      acceptsReminders: body.acceptsReminders,
    });
    return presentPatient(patient);
  }
}

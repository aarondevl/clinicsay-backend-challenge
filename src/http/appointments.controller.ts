import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CreateAppointment } from '../application/appointments/create-appointment.js';
import { GetAppointment } from '../application/appointments/get-appointment.js';
import { CreateAppointmentDto } from './dto/create-appointment.dto.js';
import { type AppointmentResponse, presentAppointment } from './presenters.js';
import { parseIsoDateTimeWithZone } from './validation.js';

@Controller('appointments')
export class AppointmentsController {
  constructor(
    private readonly createAppointment: CreateAppointment,
    private readonly getAppointment: GetAppointment,
  ) {}

  /**
   * `POST /appointments` → 201 con la cita y su recordatorio.
   * @throws {NotFoundError} (404) si la clínica o el paciente no existen.
   * @throws {ValidationError} (400) si el paciente es de otra clínica o
   * `startsAt` no es futura; ver `CreateAppointment`.
   */
  @Post()
  async create(
    @Body() body: CreateAppointmentDto,
  ): Promise<AppointmentResponse> {
    const view = await this.createAppointment.execute({
      clinicId: body.clinicId,
      patientId: body.patientId,
      startsAt: parseIsoDateTimeWithZone(body.startsAt),
      virtual: body.virtual ?? false,
    });
    return presentAppointment(view);
  }

  /**
   * `GET /appointments/{id}` → 200 con la cita y todos sus recordatorios.
   * @throws {NotFoundError} (404) si no existe o el id no es un UUID.
   */
  @Get(':id')
  async get(@Param('id') id: string): Promise<AppointmentResponse> {
    return presentAppointment(await this.getAppointment.execute(id));
  }
}

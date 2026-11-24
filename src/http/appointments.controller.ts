import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { CancelAppointment } from '../application/appointments/cancel-appointment.js';
import { CreateAppointment } from '../application/appointments/create-appointment.js';
import { GetAppointment } from '../application/appointments/get-appointment.js';
import { RescheduleAppointment } from '../application/appointments/reschedule-appointment.js';
import { CreateAppointmentDto } from './dto/create-appointment.dto.js';
import { RescheduleAppointmentDto } from './dto/reschedule-appointment.dto.js';
import { type AppointmentResponse, presentAppointment } from './presenters.js';
import { parseIsoDateTimeWithZone } from './validation.js';

@Controller('appointments')
export class AppointmentsController {
  constructor(
    private readonly createAppointment: CreateAppointment,
    private readonly getAppointment: GetAppointment,
    private readonly rescheduleAppointment: RescheduleAppointment,
    private readonly cancelAppointment: CancelAppointment,
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

  /**
   * `PATCH /appointments/{id}` → 200 con la cita reprogramada y todos sus
   * recordatorios.
   * @throws {NotFoundError} (404) si no existe o el id no es un UUID.
   * @throws {ConflictError} (409) si está cancelada o ya empezó.
   * @throws {ValidationError} (400) si `startsAt` no es futura; ver
   * `RescheduleAppointment`.
   */
  @Patch(':id')
  async reschedule(
    @Param('id') id: string,
    @Body() body: RescheduleAppointmentDto,
  ): Promise<AppointmentResponse> {
    const view = await this.rescheduleAppointment.execute(
      id,
      parseIsoDateTimeWithZone(body.startsAt),
    );
    return presentAppointment(view);
  }

  /**
   * `POST /appointments/{id}/cancel` → 200 con la cita cancelada, también si
   * ya lo estaba.
   * @throws {NotFoundError} (404) si no existe o el id no es un UUID.
   */
  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(@Param('id') id: string): Promise<AppointmentResponse> {
    return presentAppointment(await this.cancelAppointment.execute(id));
  }
}

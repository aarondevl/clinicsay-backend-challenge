import { Body, Controller, HttpCode, Put } from '@nestjs/common';
import { SettableClock } from '../application/ports/clock.js';
import { IsIsoDateTimeWithZone } from './validation.js';

class SetClockDto {
  @IsIsoDateTimeWithZone()
  now!: string;
}

/** Solo se registra con CLOCK_MODE=test (ver AppModule). */
@Controller('test/clock')
export class TestClockController {
  constructor(private readonly clock: SettableClock) {}

  @Put()
  @HttpCode(204)
  set(@Body() body: SetClockDto): void {
    this.clock.set(new Date(body.now));
  }
}

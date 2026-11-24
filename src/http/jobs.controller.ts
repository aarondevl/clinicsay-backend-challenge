import { Controller, HttpCode, Post } from '@nestjs/common';
import {
  type ReminderPassResult,
  RunReminderPass,
} from '../application/reminders/run-reminder-pass.js';
import { ShutdownCoordinator } from './shutdown-coordinator.js';

@Controller('jobs/reminders')
export class JobsController {
  constructor(
    private readonly runReminderPass: RunReminderPass,
    private readonly shutdown: ShutdownCoordinator,
  ) {}

  /**
   * `POST /jobs/reminders/run` → 200 `{ processed }` al terminar la pasada:
   * los recordatorios que trató esta pasada (enviados, reintentados o
   * descartados). Durante el cierre de la app responde `{ processed: 0 }` sin
   * tomar ninguno.
   * @throws {ServiceUnavailableError} (503) si la base no responde.
   */
  @Post('run')
  @HttpCode(200)
  async run(): Promise<ReminderPassResult> {
    return this.shutdown.track(
      this.runReminderPass.execute(this.shutdown.signal),
    );
  }
}

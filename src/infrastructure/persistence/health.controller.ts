import { MikroORM } from '@mikro-orm/postgresql';
import { Controller, Get, Logger } from '@nestjs/common';
import { ServiceUnavailableError } from '../../application/errors.js';

/**
 * `GET /health`. Las migraciones corren antes de abrir el puerto, así que si
 * la base responde, está migrada.
 */
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly orm: MikroORM) {}

  /**
   * Comprueba la base con `select 1`.
   * @throws {ServiceUnavailableError} si la base no responde (503).
   */
  @Get()
  async check(): Promise<{ status: 'ok' }> {
    try {
      await this.orm.em.getConnection().execute('select 1');
    } catch (error) {
      this.logger.error('database check failed', error);
      throw new ServiceUnavailableError('database unavailable');
    }
    return { status: 'ok' };
  }
}

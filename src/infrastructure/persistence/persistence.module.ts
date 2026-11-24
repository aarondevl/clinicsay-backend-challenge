import { MikroOrmModule } from '@mikro-orm/nestjs';
import { type DynamicModule, Module } from '@nestjs/common';
import type { AppConfig } from '../../config/app-config.js';
import { HealthController } from './health.controller.js';
import { createOrmConfig } from './mikro-orm.config.js';

/** MikroORM (global para la app) y el controlador de `/health`. */
@Module({})
export class PersistenceModule {
  /** Registra MikroORM con la configuración de `createOrmConfig`. */
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: PersistenceModule,
      imports: [
        MikroOrmModule.forRoot({
          ...createOrmConfig(config),
          // Sin contexto por petición: cada caso de uso abre su propio fork
          // con `Transactions`, y usar el EntityManager global falla.
          registerRequestContext: false,
        }),
      ],
      controllers: [HealthController],
    };
  }
}

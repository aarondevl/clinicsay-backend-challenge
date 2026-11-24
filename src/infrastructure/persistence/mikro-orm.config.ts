import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import type { AppConfig } from '../../config/app-config.js';
import { entities } from './entities.js';
import { Migration20261123000000_initial } from './migrations/Migration20261123000000_initial.js';

/**
 * Única configuración de MikroORM, para la app y los tests. Las migraciones
 * se listan a mano: son SQL escrito a mano y no se generan desde las entidades.
 */
export function createOrmConfig(config: AppConfig) {
  return defineConfig({
    clientUrl: config.databaseUrl,
    entities,
    extensions: [Migrator],
    migrations: {
      migrationsList: [Migration20261123000000_initial],
      snapshot: false,
    },
  });
}

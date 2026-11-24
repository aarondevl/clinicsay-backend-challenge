import { MikroORM } from '@mikro-orm/postgresql';
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { CreateAppointment } from './application/appointments/create-appointment.js';
import { GetAppointment } from './application/appointments/get-appointment.js';
import { CreateClinic } from './application/clinics/create-clinic.js';
import { CreatePatient } from './application/patients/create-patient.js';
import { Clock, SettableClock } from './application/ports/clock.js';
import { IdGenerator } from './application/ports/id-generator.js';
import { Transactions } from './application/ports/transactions.js';
import type { AppConfig } from './config/app-config.js';
import { AppointmentsController } from './http/appointments.controller.js';
import { ClinicsController } from './http/clinics.controller.js';
import { PatientsController } from './http/patients.controller.js';
import { TestClockController } from './http/test-clock.controller.js';
import { SystemClock } from './infrastructure/clock/system-clock.js';
import { TestClock } from './infrastructure/clock/test-clock.js';
import { UuidV7IdGenerator } from './infrastructure/ids/uuid-v7-id-generator.js';
import { MikroOrmTransactions } from './infrastructure/persistence/mikro-orm-transactions.js';
import { PersistenceModule } from './infrastructure/persistence/persistence.module.js';

export const APP_CONFIG = Symbol('APP_CONFIG');

/** Puertos de `application` con la implementación que usa la app. */
const portProviders: Provider[] = [
  { provide: IdGenerator, useValue: new UuidV7IdGenerator() },
  {
    provide: Transactions,
    useFactory: (orm: MikroORM) => new MikroOrmTransactions(orm),
    inject: [MikroORM],
  },
];

/** Casos de uso: clases sin decoradores que reciben sus puertos. */
const useCaseProviders: Provider[] = [
  {
    provide: CreateClinic,
    useFactory: (transactions: Transactions, ids: IdGenerator) =>
      new CreateClinic(transactions, ids),
    inject: [Transactions, IdGenerator],
  },
  {
    provide: CreatePatient,
    useFactory: (transactions: Transactions, ids: IdGenerator) =>
      new CreatePatient(transactions, ids),
    inject: [Transactions, IdGenerator],
  },
  {
    provide: CreateAppointment,
    useFactory: (transactions: Transactions, ids: IdGenerator, clock: Clock) =>
      new CreateAppointment(transactions, ids, clock),
    inject: [Transactions, IdGenerator, Clock],
  },
  {
    provide: GetAppointment,
    useFactory: (transactions: Transactions) =>
      new GetAppointment(transactions),
    inject: [Transactions],
  },
];

/** Composición de la app: aquí se eligen las implementaciones de los puertos. */
@Module({})
export class AppModule {
  /**
   * Módulo raíz para `config`. El reloj de test y su controlador solo se
   * registran con `clockMode === 'test'`.
   */
  static forRoot(config: AppConfig): DynamicModule {
    const testMode = config.clockMode === 'test';
    const clockProviders: Provider[] = testMode
      ? [
          { provide: SettableClock, useValue: new TestClock() },
          { provide: Clock, useExisting: SettableClock },
        ]
      : [{ provide: Clock, useValue: new SystemClock() }];

    return {
      module: AppModule,
      imports: [PersistenceModule.forRoot(config)],
      controllers: [
        ClinicsController,
        PatientsController,
        AppointmentsController,
        ...(testMode ? [TestClockController] : []),
      ],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        ...clockProviders,
        ...portProviders,
        ...useCaseProviders,
      ],
    };
  }
}

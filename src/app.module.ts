import { MikroORM } from '@mikro-orm/postgresql';
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { CancelAppointment } from './application/appointments/cancel-appointment.js';
import { CreateAppointment } from './application/appointments/create-appointment.js';
import { GetAppointment } from './application/appointments/get-appointment.js';
import { RescheduleAppointment } from './application/appointments/reschedule-appointment.js';
import { CreateClinic } from './application/clinics/create-clinic.js';
import { HandleInboundMessage } from './application/inbound/handle-inbound-message.js';
import { CreatePatient } from './application/patients/create-patient.js';
import { Clock, SettableClock } from './application/ports/clock.js';
import { IdGenerator } from './application/ports/id-generator.js';
import { MessageProvider } from './application/ports/message-provider.js';
import { Transactions } from './application/ports/transactions.js';
import { RunReminderPass } from './application/reminders/run-reminder-pass.js';
import type { AppConfig } from './config/app-config.js';
import { AppointmentsController } from './http/appointments.controller.js';
import { ClinicsController } from './http/clinics.controller.js';
import { JobsController } from './http/jobs.controller.js';
import { PatientsController } from './http/patients.controller.js';
import { ShutdownCoordinator } from './http/shutdown-coordinator.js';
import { TestClockController } from './http/test-clock.controller.js';
import { WebhooksController } from './http/webhooks.controller.js';
import { SystemClock } from './infrastructure/clock/system-clock.js';
import { TestClock } from './infrastructure/clock/test-clock.js';
import { UuidV7IdGenerator } from './infrastructure/ids/uuid-v7-id-generator.js';
import { MikroOrmTransactions } from './infrastructure/persistence/mikro-orm-transactions.js';
import { PersistenceModule } from './infrastructure/persistence/persistence.module.js';
import { HttpMessageProvider } from './infrastructure/provider/http-message-provider.js';

export const APP_CONFIG = Symbol('APP_CONFIG');

/** Puertos de `application` con la implementación que usa la app. */
const portProviders: Provider[] = [
  { provide: IdGenerator, useValue: new UuidV7IdGenerator() },
  {
    provide: Transactions,
    useFactory: (orm: MikroORM) => new MikroOrmTransactions(orm),
    inject: [MikroORM],
  },
  {
    provide: MessageProvider,
    useFactory: (config: AppConfig) =>
      new HttpMessageProvider(config.providerUrl, config.providerTimeoutMs),
    inject: [APP_CONFIG],
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
  {
    provide: RescheduleAppointment,
    useFactory: (transactions: Transactions, ids: IdGenerator, clock: Clock) =>
      new RescheduleAppointment(transactions, ids, clock),
    inject: [Transactions, IdGenerator, Clock],
  },
  {
    provide: CancelAppointment,
    useFactory: (transactions: Transactions) =>
      new CancelAppointment(transactions),
    inject: [Transactions],
  },
  {
    provide: RunReminderPass,
    useFactory: (
      transactions: Transactions,
      clock: Clock,
      provider: MessageProvider,
    ) => new RunReminderPass(transactions, clock, provider),
    inject: [Transactions, Clock, MessageProvider],
  },
  {
    provide: HandleInboundMessage,
    useFactory: (transactions: Transactions, clock: Clock) =>
      new HandleInboundMessage(transactions, clock),
    inject: [Transactions, Clock],
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
        JobsController,
        WebhooksController,
        ...(testMode ? [TestClockController] : []),
      ],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        ...clockProviders,
        ...portProviders,
        ...useCaseProviders,
        ShutdownCoordinator,
      ],
    };
  }
}

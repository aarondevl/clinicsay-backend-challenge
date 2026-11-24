import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { Clock, SettableClock } from './application/ports/clock.js';
import type { AppConfig } from './config/app-config.js';
import { TestClockController } from './http/test-clock.controller.js';
import { SystemClock } from './infrastructure/clock/system-clock.js';
import { TestClock } from './infrastructure/clock/test-clock.js';

export const APP_CONFIG = Symbol('APP_CONFIG');

@Module({})
export class AppModule {
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
      controllers: testMode ? [TestClockController] : [],
      providers: [{ provide: APP_CONFIG, useValue: config }, ...clockProviders],
    };
  }
}

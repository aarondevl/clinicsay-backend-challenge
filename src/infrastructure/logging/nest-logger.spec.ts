import { ConsoleLogger } from '@nestjs/common';
import { NestLogger } from './nest-logger.js';

describe('NestLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('error() llega al log de Nest con el error (para la pila) y su contexto', () => {
    const printed = vi
      .spyOn(ConsoleLogger.prototype, 'error')
      .mockImplementation(() => undefined);
    const error = new Error('invalid time zone: Nope/Zone');

    new NestLogger('RunReminderPass').error('reminder r-1 failed', error);

    expect(printed).toHaveBeenCalledExactlyOnceWith(
      'reminder r-1 failed',
      error,
      'RunReminderPass',
    );
  });
});

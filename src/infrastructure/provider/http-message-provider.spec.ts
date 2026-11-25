import { Logger } from '@nestjs/common';
import {
  type ResetServer,
  startResetServer,
} from '../../../test/support/reset-server.js';
import {
  type BodyEnding,
  startTruncatedBodyServer,
  type TruncatedBodyServer,
} from '../../../test/support/truncated-body-server.js';
import { HttpMessageProvider } from './http-message-provider.js';

const MESSAGE = {
  idempotencyKey: 'k-1',
  to: '+34600111222',
  text: 'Hola',
};

describe('HttpMessageProvider', () => {
  let warnings: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnings = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('con las cabeceras recibidas y el cuerpo sin completar', () => {
    let server: TruncatedBodyServer;

    beforeAll(async () => {
      server = await startTruncatedBodyServer();
    });

    afterAll(async () => {
      await server.close();
    });

    it.each<{ status: number; ending: BodyEnding }>([
      { status: 422, ending: 'cut' },
      { status: 422, ending: 'stall' },
      { status: 202, ending: 'cut' },
      { status: 202, ending: 'stall' },
    ])(
      '$status y cuerpo $ending → el código, y el fallo del cuerpo queda en el log',
      async ({ status, ending }) => {
        server.respondWith(status, ending);
        const provider = new HttpMessageProvider(
          `http://127.0.0.1:${server.port}`,
          200,
        );

        expect(await provider.send(MESSAGE)).toEqual({
          kind: 'response',
          status,
        });
        expect(warnings).toHaveBeenCalledWith(
          expect.stringContaining('idempotency key k-1'),
          expect.any(Error),
        );
      },
    );
  });

  describe('sin cabeceras', () => {
    let resetting: ResetServer;

    beforeAll(async () => {
      resetting = await startResetServer();
    });

    afterAll(async () => {
      await resetting.close();
    });

    it('una conexión cortada al aceptarla sigue siendo network_error', async () => {
      const provider = new HttpMessageProvider(
        `http://127.0.0.1:${resetting.port}`,
        200,
      );

      expect(await provider.send(MESSAGE)).toEqual({ kind: 'network_error' });
    });
  });
});

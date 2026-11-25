import { createServer } from 'node:net';

/** Servidor TCP local que corta cada conexión en cuanto la acepta. */
export interface ResetServer {
  port: number;
  close(): Promise<void>;
}

/**
 * Abre en un puerto libre de 127.0.0.1 un servidor que corta en seco (RST)
 * cada conexión al aceptarla, sin leer ni responder nada: el cliente ve un
 * error de red. Sustituye a un puerto recién liberado, que otro proceso puede
 * ocupar y contestar; este puerto es del servidor hasta que se cierra.
 */
export async function startResetServer(): Promise<ResetServer> {
  const server = createServer((socket) => {
    socket.resetAndDestroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('reset server: no TCP address');
  }
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

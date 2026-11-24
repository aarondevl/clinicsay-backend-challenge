import { createConnection, createServer, type Socket } from 'node:net';

/**
 * Proxy TCP local que se puede cortar para simular la caída de un servicio, o
 * dejar sin respuestas para simular uno que tarda más que el timeout.
 */
export interface TcpProxy {
  port: number;
  /**
   * Con `true`, lo que envía el cliente sigue llegando al destino, pero lo que
   * responde el destino se descarta: el servicio procesa la petición y el
   * cliente nunca ve la respuesta ni el cierre de la conexión. Con `false`
   * vuelve a reenviarlo todo.
   */
  dropResponses(drop: boolean): void;
  /** Deja de aceptar conexiones y corta las abiertas. Se puede llamar varias veces. */
  close(): Promise<void>;
}

/** Abre en un puerto libre de 127.0.0.1 un proxy hacia `targetHost:targetPort`. */
export async function startTcpProxy(
  targetHost: string,
  targetPort: number,
): Promise<TcpProxy> {
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // Los cortes son lo que se quiere provocar: no son errores del test.
    socket.on('error', () => socket.destroy());
  };

  let dropping = false;
  const server = createServer((client) => {
    const upstream = createConnection(targetPort, targetHost);
    track(client);
    track(upstream);
    client.pipe(upstream);
    // Se mira en cada trozo, así que también vale para conexiones ya abiertas.
    upstream.on('data', (chunk: Buffer) => {
      if (!dropping) client.write(chunk);
    });
    client.on('close', () => upstream.destroy());
    // Sin respuestas, el cliente tampoco se entera de que el destino cerró
    // (el proveedor cierra a los 5 s una conexión inactiva): solo le queda
    // su propio timeout. `close()` corta igualmente estos sockets.
    upstream.on('close', () => {
      if (!dropping) client.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('tcp proxy: no TCP address');
  }

  let closing: Promise<void> | null = null;
  return {
    port: address.port,
    dropResponses(drop) {
      dropping = drop;
    },
    close() {
      closing ??= new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      });
      return closing;
    },
  };
}

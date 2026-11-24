import { createConnection, createServer, type Socket } from 'node:net';

/** Proxy TCP local que se puede cortar para simular la caída de un servicio. */
export interface TcpProxy {
  port: number;
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

  const server = createServer((client) => {
    const upstream = createConnection(targetPort, targetHost);
    track(client);
    track(upstream);
    client.pipe(upstream).pipe(client);
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
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
    close() {
      closing ??= new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      });
      return closing;
    },
  };
}

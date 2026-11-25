import { createServer, type Socket } from 'node:net';

/**
 * Cómo sigue la respuesta tras las cabeceras: `cut` cierra la conexión a
 * mitad del cuerpo y `stall` la deja abierta sin enviar nada más.
 */
export type BodyEnding = 'cut' | 'stall';

/**
 * Servidor HTTP mínimo que contesta con un código y las cabeceras, pero sin el
 * cuerpo completo que anuncia su `content-length`.
 */
export interface TruncatedBodyServer {
  port: number;
  /** Fija el código y el final de las respuestas a las peticiones siguientes. */
  respondWith(status: number, ending: BodyEnding): void;
  /** `Idempotency-Key` de cada petición recibida, en orden de llegada. */
  requests(): string[];
  /** Olvida las peticiones recibidas. */
  clear(): void;
  /** Deja de aceptar conexiones y corta las abiertas. */
  close(): Promise<void>;
}

const HEADER_END = '\r\n\r\n';
const PARTIAL_BODY = '{"error":';

/**
 * Abre en un puerto libre de 127.0.0.1 un servidor que lee cada petición
 * entera y responde con la línea de estado, un `content-length` de 1000 y
 * solo los primeros bytes del cuerpo. `fetch` resuelve con el código, y lo que
 * falla después es la lectura del cuerpo. El proveedor falso no puede hacerlo:
 * siempre envía el cuerpo completo.
 */
export async function startTruncatedBodyServer(): Promise<TruncatedBodyServer> {
  let status = 202;
  let ending: BodyEnding = 'cut';
  const keys: string[] = [];
  const sockets = new Set<Socket>();

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // El cliente corta la conexión al rendirse: no es un error del test.
    socket.on('error', () => socket.destroy());
    let received = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const request = completeRequest(received);
      if (request === null) return;
      received = Buffer.alloc(0);
      keys.push(request.idempotencyKey);
      const head =
        `HTTP/1.1 ${status} Truncated\r\n` +
        'content-type: application/json\r\n' +
        `content-length: 1000${HEADER_END}`;
      if (ending === 'cut') socket.end(head + PARTIAL_BODY);
      else socket.write(head + PARTIAL_BODY);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('truncated body server: no TCP address');
  }
  return {
    port: address.port,
    respondWith(nextStatus, nextEnding) {
      status = nextStatus;
      ending = nextEnding;
    },
    requests: () => [...keys],
    clear() {
      keys.length = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/**
 * La petición si ya llegó entera (cabeceras y el cuerpo de su
 * `content-length`), o `null` si falta algo.
 */
function completeRequest(received: Buffer): { idempotencyKey: string } | null {
  const headerEnd = received.indexOf(HEADER_END);
  if (headerEnd < 0) return null;
  const headers = received.subarray(0, headerEnd).toString('latin1');
  const length = Number(/^content-length:\s*(\d+)/im.exec(headers)?.[1] ?? 0);
  if (received.length < headerEnd + HEADER_END.length + length) return null;
  const idempotencyKey = /^idempotency-key:\s*(\S+)/im.exec(headers)?.[1] ?? '';
  return { idempotencyKey };
}

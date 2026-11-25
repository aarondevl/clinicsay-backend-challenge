import { Logger } from '@nestjs/common';
import {
  MessageProvider,
  type OutgoingMessage,
} from '../../application/ports/message-provider.js';
import type { ProviderResult } from '../../domain/provider-outcome.js';

/**
 * Cliente del proveedor de mensajes por HTTP (`POST {baseUrl}/messages`). Solo
 * cuenta lo que pasó: qué hacer con cada resultado lo decide el dominio.
 */
export class HttpMessageProvider extends MessageProvider {
  private readonly logger = new Logger(HttpMessageProvider.name);

  /**
   * @param baseUrl URL del proveedor, sin `/` final (`PROVIDER_URL`).
   * @param timeoutMs Tiempo máximo de espera por la respuesta, cuerpo
   * incluido.
   */
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {
    super();
  }

  /**
   * Envía el mensaje con su `Idempotency-Key`. En cuanto llegan las cabeceras
   * el resultado es un `response` con su código, aunque después falle la
   * lectura del cuerpo. Si no llegan en `timeoutMs` es `timeout`, y cualquier
   * otro fallo de `fetch` antes de las cabeceras (conexión rechazada, DNS,
   * socket cortado) es `network_error`. Nunca lanza.
   */
  async send(message: OutgoingMessage): Promise<ProviderResult> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': message.idempotencyKey,
        },
        body: JSON.stringify({ to: message.to, text: message.text }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const result: ProviderResult = isTimeout(error)
        ? { kind: 'timeout' }
        : { kind: 'network_error' };
      this.logger.warn(
        `provider ${result.kind} (idempotency key ${message.idempotencyKey})`,
        error,
      );
      return result;
    }
    await this.discardBody(response, message.idempotencyKey);
    return { kind: 'response', status: response.status };
  }

  /**
   * Lee y descarta el cuerpo para liberar la conexión. Solo cuenta el código,
   * que ya llegó con las cabeceras: si la conexión se corta o salta el
   * timeout a mitad del cuerpo, se registra y el código se mantiene. Tratarlo
   * como si no hubiera respondido reintentaría un 4xx, que podría entregar
   * lo que el operador rechazó, y repetiría un 2xx ya aceptado.
   */
  private async discardBody(
    response: Response,
    idempotencyKey: string,
  ): Promise<void> {
    try {
      await response.arrayBuffer();
    } catch (error) {
      this.logger.warn(
        `provider body of a ${response.status} not read (idempotency key ${idempotencyKey})`,
        error,
      );
    }
  }
}

/** `AbortSignal.timeout` rechaza `fetch` con un `DOMException` `TimeoutError`. */
function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError';
}

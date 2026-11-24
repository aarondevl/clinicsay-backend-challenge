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
   * @param timeoutMs Tiempo máximo de espera por la respuesta completa.
   */
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {
    super();
  }

  /**
   * Envía el mensaje con su `Idempotency-Key`. Cualquier código HTTP es un
   * `response`; si no responde en `timeoutMs` es `timeout`, y cualquier otro
   * fallo de `fetch` (conexión rechazada, DNS, socket cortado) es
   * `network_error`. Nunca lanza.
   */
  async send(message: OutgoingMessage): Promise<ProviderResult> {
    try {
      const response = await fetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': message.idempotencyKey,
        },
        body: JSON.stringify({ to: message.to, text: message.text }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      // Solo cuenta el código, pero el cuerpo se lee para liberar la conexión.
      // Si falla al leerlo, se trata como si no hubiera respondido: reintentar
      // con la misma clave es seguro.
      await response.arrayBuffer();
      return { kind: 'response', status: response.status };
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
  }
}

/** `AbortSignal.timeout` rechaza `fetch` con un `DOMException` `TimeoutError`. */
function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError';
}

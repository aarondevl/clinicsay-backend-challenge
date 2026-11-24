import type { ProviderResult } from '../../domain/provider-outcome.js';

/** Mensaje que se pide al proveedor que entregue al paciente. */
export type OutgoingMessage = {
  /**
   * Clave de idempotencia: el id del recordatorio, la misma en todos sus
   * intentos. Si el proveedor ya entregó un mensaje con esta clave, no lo
   * reenvía y responde 200.
   */
  idempotencyKey: string;
  /** Teléfono E.164 del paciente. */
  to: string;
  text: string;
};

/** Proveedor externo de mensajes (WhatsApp/SMS). */
export abstract class MessageProvider {
  /**
   * Pide el envío de `message` y cuenta qué pasó. Nunca lanza: un fallo de
   * red o un timeout también son un `ProviderResult`, y decidir qué hacer
   * con él es cosa del dominio (`classifyProviderResult`).
   */
  abstract send(message: OutgoingMessage): Promise<ProviderResult>;
}

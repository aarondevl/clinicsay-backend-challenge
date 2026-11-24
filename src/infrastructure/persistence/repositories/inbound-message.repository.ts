import type { EntityManager } from '@mikro-orm/postgresql';
import { InboundMessageRepository } from '../../../application/ports/repositories.js';

/** Mensajes entrantes en Postgres, dentro de la transacción de `tx`. */
export class MikroOrmInboundMessageRepository extends InboundMessageRepository {
  constructor(private readonly tx: EntityManager) {
    super();
  }

  /**
   * `insert ... on conflict do nothing` sobre la clave primaria `message_id`:
   * si otra transacción insertó el mismo y no ha confirmado, Postgres espera
   * a que termine y, si confirma, no inserta. `returning` devuelve la fila
   * solo cuando insertó.
   */
  async insertIfNew(messageId: string, receivedAt: Date): Promise<boolean> {
    const inserted = await this.tx.execute<{ message_id: string }[]>(
      `insert into inbound_message (message_id, received_at) values (?, ?)
        on conflict (message_id) do nothing returning message_id`,
      [messageId, receivedAt],
      'all',
    );
    return inserted.length > 0;
  }
}

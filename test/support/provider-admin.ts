/** Modos de fallo que admite `POST /admin/rules` del proveedor falso. */
export type ProviderRuleMode = 'unavailable' | 'lost-response' | 'reject';

/** Mensaje entregado al paciente, según `GET /admin/messages`. */
export interface ProviderMessage {
  text: string;
  idempotencyKey: string;
}

/** Petición recibida por el proveedor y su resultado, según `GET /admin/requests`. */
export interface ProviderRequest {
  idempotencyKey: string;
  status: number;
}

/** Cliente de la API de administración de `provider/server.mjs`. */
export interface ProviderAdmin {
  /** Las próximas `count` peticiones a `to` se comportan como `mode`. */
  rule(to: string, mode: ProviderRuleMode, count: number): Promise<void>;
  /** Mensajes entregados a `to`, en orden de entrega. */
  messages(to: string): Promise<ProviderMessage[]>;
  /**
   * Peticiones recibidas para `to` (o todas, sin `to`), en orden de llegada y
   * con el código que devolvió.
   */
  requests(to?: string): Promise<ProviderRequest[]>;
  /** Olvida mensajes, peticiones y reglas. */
  reset(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function expectStatus(res: Response, status: number): Promise<void> {
  if (res.status !== status) {
    throw new Error(
      `provider admin: expected ${status}, got ${res.status}: ${await res.text()}`,
    );
  }
}

async function readList(res: Response): Promise<Record<string, unknown>[]> {
  await expectStatus(res, 200);
  const body: unknown = await res.json();
  if (!Array.isArray(body) || !body.every(isRecord)) {
    throw new Error('provider admin: expected a JSON array of objects');
  }
  return body;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`provider admin: ${field} is not a string`);
  }
  return value;
}

/**
 * Crea el cliente de administración del proveedor que escucha en `baseUrl`.
 * Solo se usa en los tests: el servicio no conoce esta API.
 */
export function createProviderAdmin(baseUrl: string): ProviderAdmin {
  const query = (to?: string) =>
    to === undefined ? '' : `?to=${encodeURIComponent(to)}`;
  return {
    async rule(to, mode, count) {
      const res = await fetch(`${baseUrl}/admin/rules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to, mode, count }),
      });
      await expectStatus(res, 204);
    },
    async messages(to) {
      const list = await readList(
        await fetch(`${baseUrl}/admin/messages${query(to)}`),
      );
      return list.map((m) => ({
        text: asString(m.text, 'text'),
        idempotencyKey: asString(m.idempotencyKey, 'idempotencyKey'),
      }));
    },
    async requests(to) {
      const list = await readList(
        await fetch(`${baseUrl}/admin/requests${query(to)}`),
      );
      return list.map((r) => {
        if (typeof r.status !== 'number') {
          throw new Error('provider admin: status is not a number');
        }
        return {
          idempotencyKey: asString(r.idempotencyKey, 'idempotencyKey'),
          status: r.status,
        };
      });
    },
    async reset() {
      const res = await fetch(`${baseUrl}/admin/reset`, { method: 'POST' });
      await expectStatus(res, 204);
    },
  };
}

import {
  type ContractChecker,
  type ContractResponse,
  createContractChecker,
} from './contract.js';

const REMINDER = {
  id: 'r1',
  scheduledFor: '2027-03-27T09:00:00Z',
  status: 'pending',
  attempts: 0,
  sentAt: null,
  skipReason: null,
};

const APPOINTMENT = {
  id: 'a1',
  clinicId: 'c1',
  patientId: 'p1',
  startsAt: '2027-03-28T08:00:00Z',
  status: 'scheduled',
  reminders: [REMINDER],
};

/** Respuesta con cuerpo JSON, como la deja supertest. */
function json(status: number, body: unknown): ContractResponse {
  return { status, body, text: JSON.stringify(body), type: 'application/json' };
}

/** Respuesta sin cuerpo, como la deja supertest. */
function empty(status: number): ContractResponse {
  return { status, body: {}, text: '', type: '' };
}

/** Cita del contrato con `over` aplicado a su primer recordatorio. */
function withReminder(over: Record<string, unknown>) {
  return { ...APPOINTMENT, reminders: [{ ...REMINDER, ...over }] };
}

describe('expectContract (test/support/contract.ts)', () => {
  let contract: ContractChecker;

  beforeEach(() => {
    contract = createContractChecker();
  });

  it('acepta una cita con la forma del contrato', () => {
    expect(() =>
      contract.check(json(201, APPOINTMENT), 'post', '/appointments'),
    ).not.toThrow();
  });

  it('falla si la operación no está en el contrato', () => {
    expect(() => contract.check(json(200, {}), 'delete', '/clinics')).toThrow(
      /DELETE \/clinics is not in openapi\.yaml/,
    );
  });

  it.each([409, 500])(
    'falla con un código que la operación no documenta (%i)',
    (status) => {
      expect(() =>
        contract.check(json(status, { error: 'x' }), 'post', '/appointments'),
      ).toThrow(new RegExp(`POST /appointments: ${status} is not documented`));
    },
  );

  describe('modo estricto', () => {
    it('falla con una propiedad que el contrato no declara', () => {
      expect(() =>
        contract.check(
          json(201, { ...APPOINTMENT, sentTo: '+34600111222' }),
          'post',
          '/appointments',
        ),
      ).toThrow(/must NOT have additional properties.*sentTo/);
    });

    it('falla con una propiedad de más dentro de un $ref anidado', () => {
      expect(() =>
        contract.check(
          json(200, withReminder({ nextAttemptAt: null })),
          'get',
          '/appointments/{id}',
        ),
      ).toThrow(/\/reminders\/0 must NOT have additional.*nextAttemptAt/);
    });

    it('falla si falta una propiedad obligatoria', () => {
      const { reminders: _omitted, ...withoutReminders } = APPOINTMENT;
      expect(() =>
        contract.check(json(201, withoutReminders), 'post', '/appointments'),
      ).toThrow(/must have required property 'reminders'/);
    });

    it('falla con un tipo o un enum fuera del contrato', () => {
      expect(() =>
        contract.check(
          json(200, withReminder({ status: 'queued' })),
          'get',
          '/appointments/{id}',
        ),
      ).toThrow(/\/reminders\/0\/status must be equal to one of the allowed/);
    });

    it('acepta virtual: true en una cita', () => {
      expect(() =>
        contract.check(
          json(201, { ...APPOINTMENT, virtual: true }),
          'post',
          '/appointments',
        ),
      ).not.toThrow();
    });

    it('falla con virtual: false en una cita', () => {
      expect(() =>
        contract.check(
          json(201, { ...APPOINTMENT, virtual: false }),
          'post',
          '/appointments',
        ),
      ).toThrow(/\/virtual must be equal to constant/);
    });

    it('falla con virtual fuera de la cita', () => {
      expect(() =>
        contract.check(
          json(201, {
            id: 'c1',
            name: 'Clínica',
            timezone: 'Europe/Madrid',
            virtual: true,
          }),
          'post',
          '/clinics',
        ),
      ).toThrow(/must NOT have additional properties.*virtual/);
    });

    it('también es estricto con un esquema que no es un $ref', () => {
      expect(() =>
        contract.check(
          json(200, { processed: 1, skipped: 0 }),
          'post',
          '/jobs/reminders/run',
        ),
      ).toThrow(/must NOT have additional properties.*skipped/);
    });
  });

  describe('fechas de las respuestas', () => {
    it.each([
      ['sin milisegundos', '2027-03-27T09:00:00Z'],
      ['con milisegundos que no son cero', '2027-03-27T09:00:00.250Z'],
    ])('acepta una fecha UTC con Z %s', (_label, sentAt) => {
      expect(() =>
        contract.check(
          json(200, withReminder({ status: 'sent', attempts: 1, sentAt })),
          'get',
          '/appointments/{id}',
        ),
      ).not.toThrow();
    });

    it.each([
      ['con .000', '2027-03-27T09:00:00.000Z'],
      ['con +00:00', '2027-03-27T09:00:00+00:00'],
      ['con otro offset', '2027-03-27T11:00:00+02:00'],
      ['sin zona', '2027-03-27T09:00:00'],
      ['con milisegundos de menos', '2027-03-27T09:00:00.25Z'],
      ['con un día que no existe', '2027-02-30T09:00:00Z'],
    ])('falla con una fecha %s', (_label, sentAt) => {
      expect(() =>
        contract.check(
          json(200, withReminder({ status: 'sent', attempts: 1, sentAt })),
          'get',
          '/appointments/{id}',
        ),
      ).toThrow(/\/reminders\/0\/sentAt must/);
    });

    it('aplica la misma regla a las fechas que no admiten null', () => {
      expect(() =>
        contract.check(
          json(201, { ...APPOINTMENT, startsAt: '2027-03-28T08:00:00.000Z' }),
          'post',
          '/appointments',
        ),
      ).toThrow(/\/startsAt must match pattern/);
    });
  });

  describe('respuestas 4xx', () => {
    it('acepta { error: <string> }', () => {
      expect(() =>
        contract.check(
          json(404, { error: 'appointment not found' }),
          'get',
          '/appointments/{id}',
        ),
      ).not.toThrow();
    });

    it.each([
      ['con otra propiedad', { error: 'not found', statusCode: 404 }],
      ['con otro nombre', { message: 'not found' }],
      ['con un error que no es texto', { error: ['not found'] }],
      ['con un error vacío', { error: '' }],
    ])('falla con un cuerpo %s', (_label, body) => {
      expect(() =>
        contract.check(json(404, body), 'get', '/appointments/{id}'),
      ).toThrow(/GET \/appointments\/\{id\} 404: error body/);
    });

    it('falla con un 4xx sin cuerpo JSON', () => {
      expect(() =>
        contract.check(empty(404), 'get', '/appointments/{id}'),
      ).toThrow(/404: expected application\/json/);
    });
  });

  describe('respuestas sin contenido en el contrato', () => {
    it('acepta un 204 sin cuerpo', () => {
      expect(() =>
        contract.check(empty(204), 'put', '/test/clock'),
      ).not.toThrow();
    });

    it('falla con un 204 con cuerpo', () => {
      expect(() =>
        contract.check(json(204, { ok: true }), 'put', '/test/clock'),
      ).toThrow(/PUT \/test\/clock 204: expected an empty body/);
    });

    it('falla con un 200 del webhook con cuerpo', () => {
      expect(() =>
        contract.check(
          json(200, { ignored: true }),
          'post',
          '/webhooks/inbound-messages',
        ),
      ).toThrow(/expected an empty body/);
    });

    it('acepta el { status: "ok" } de /health, que es convención del repo', () => {
      expect(() =>
        contract.check(json(200, { status: 'ok' }), 'get', '/health'),
      ).not.toThrow();
    });

    it('falla con otro cuerpo en /health', () => {
      expect(() =>
        contract.check(json(200, { status: 'up' }), 'get', '/health'),
      ).toThrow(/GET \/health 200: expected the repo convention/);
    });
  });

  it('falla con un esquema JSON si la respuesta no es application/json', () => {
    expect(() =>
      contract.check(
        { status: 200, body: {}, text: 'processed=1', type: 'text/plain' },
        'post',
        '/jobs/reminders/run',
      ),
    ).toThrow(/200: expected application\/json, got "text\/plain"/);
  });

  describe('cobertura', () => {
    it('lista todas las respuestas documentadas mientras no se ejercitan', () => {
      expect(contract.uncovered()).toEqual([
        'GET /health 200',
        'POST /clinics 201',
        'POST /clinics 400',
        'POST /patients 201',
        'POST /patients 400',
        'POST /patients 404',
        'POST /appointments 201',
        'POST /appointments 400',
        'POST /appointments 404',
        'GET /appointments/{id} 200',
        'GET /appointments/{id} 404',
        'PATCH /appointments/{id} 200',
        'PATCH /appointments/{id} 400',
        'PATCH /appointments/{id} 404',
        'PATCH /appointments/{id} 409',
        'POST /appointments/{id}/cancel 200',
        'POST /appointments/{id}/cancel 404',
        'POST /jobs/reminders/run 200',
        'POST /webhooks/inbound-messages 200',
        'POST /webhooks/inbound-messages 400',
        'PUT /test/clock 204',
      ]);
    });

    it('quita una respuesta al verla cumplir el contrato', () => {
      contract.check(empty(204), 'put', '/test/clock');
      expect(contract.uncovered()).not.toContain('PUT /test/clock 204');
    });

    it('no la quita si no cumple el contrato', () => {
      expect(() =>
        contract.check(json(204, { ok: true }), 'put', '/test/clock'),
      ).toThrow();
      expect(contract.uncovered()).toContain('PUT /test/clock 204');
    });
  });
});

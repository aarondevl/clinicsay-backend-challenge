import { startTestApp, testConfig, type TestApp } from './support/app.js';

const CLINIC = '0190a000-0000-7000-8000-000000000001';
const PATIENT = '0190a000-0000-7000-8000-000000000002';
const APPOINTMENT = '0190a000-0000-7000-8000-000000000003';

describe('esquema y soporte de los e2e', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await t.reset();
  });

  async function sql(query: string): Promise<unknown[]> {
    return t.orm.em.getConnection().execute(query);
  }

  async function insertAppointment(): Promise<void> {
    await sql(
      `insert into clinic (id, name, timezone) values ('${CLINIC}', 'Clínica', 'Europe/Madrid')`,
    );
    await sql(
      `insert into patient (id, clinic_id, name, phone, accepts_reminders)
       values ('${PATIENT}', '${CLINIC}', 'Ana', '+34600111222', true)`,
    );
    await sql(
      `insert into appointment (id, clinic_id, patient_id, starts_at, status)
       values ('${APPOINTMENT}', '${CLINIC}', '${PATIENT}', '2027-03-28T08:00:00Z', 'scheduled')`,
    );
  }

  function insertReminder(id: string, status: string): Promise<unknown[]> {
    return sql(
      `insert into reminder (id, appointment_id, scheduled_for, status)
       values ('${id}', '${APPOINTMENT}', '2027-03-27T09:00:00Z', '${status}')`,
    );
  }

  it('reminder_one_pending admite un solo recordatorio pendiente por cita', async () => {
    await insertAppointment();
    await insertReminder('0190a000-0000-7000-8000-000000000010', 'sent');
    await insertReminder('0190a000-0000-7000-8000-000000000011', 'pending');
    await expect(
      insertReminder('0190a000-0000-7000-8000-000000000012', 'pending'),
    ).rejects.toThrow(/reminder_one_pending/);
  });

  it('el estado del recordatorio solo admite los valores del contrato', async () => {
    await insertAppointment();
    await expect(
      insertReminder('0190a000-0000-7000-8000-000000000013', 'queued'),
    ).rejects.toThrow(/check constraint/);
  });

  it('reset vacía las tablas y el proveedor', async () => {
    await insertAppointment();
    await sql(
      `insert into inbound_message (message_id, received_at) values ('m-1', '2027-03-01T00:00:00Z')`,
    );
    const sent = await fetch(`${testConfig().providerUrl}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'k-1',
      },
      body: JSON.stringify({ to: '+34600111222', text: 'hola' }),
    });
    expect(sent.status).toBe(202);

    await t.reset();

    for (const table of [
      'clinic',
      'patient',
      'appointment',
      'inbound_message',
    ]) {
      expect(await sql(`select 1 from ${table}`)).toEqual([]);
    }
    expect(await t.provider.messages('+34600111222')).toEqual([]);
  });
});

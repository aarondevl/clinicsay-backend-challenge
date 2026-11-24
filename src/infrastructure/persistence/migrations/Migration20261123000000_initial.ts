import { Migration } from '@mikro-orm/migrations';

/** Esquema inicial: clínicas, pacientes, citas, recordatorios y mensajes entrantes. */
export class Migration20261123000000_initial extends Migration {
  /** Crea las tablas, los índices y la secuencia de envíos. */
  override up(): void {
    this.addSql(
      `create table clinic (id uuid primary key, name text not null, timezone text not null);`,
    );
    this.addSql(
      `create table patient (id uuid primary key, clinic_id uuid not null references clinic(id),
        name text not null, phone text null, accepts_reminders boolean not null);`,
    );
    this.addSql(
      `create table appointment (id uuid primary key, clinic_id uuid not null references clinic(id),
        patient_id uuid not null references patient(id), starts_at timestamptz not null,
        status text not null check (status in ('scheduled','confirmed','cancelled')),
        virtual boolean not null default false);`,
    );
    this.addSql(
      `create table reminder (id uuid primary key, appointment_id uuid not null references appointment(id),
        scheduled_for timestamptz not null,
        status text not null check (status in ('pending','sent','failed','skipped','cancelled')),
        skip_reason text null check (skip_reason in ('too_late','no_phone','opted_out')),
        attempts int not null default 0, next_attempt_at timestamptz null,
        sent_at timestamptz null, sent_to text null, send_seq bigint null);`,
    );
    // Un solo recordatorio pendiente por cita.
    this.addSql(
      `create unique index reminder_one_pending on reminder (appointment_id) where status = 'pending';`,
    );
    // Lo que el job tiene que tratar, en orden.
    this.addSql(
      `create index reminder_due on reminder (next_attempt_at, id) where status = 'pending';`,
    );
    this.addSql(
      `create index reminder_by_appointment on reminder (appointment_id, id);`,
    );
    // Último recordatorio enviado a un teléfono, para el webhook.
    this.addSql(
      `create index reminder_last_sent on reminder (sent_to, send_seq desc) where status = 'sent';`,
    );
    this.addSql(`create sequence reminder_send_seq;`);
    this.addSql(
      `create table inbound_message (message_id text primary key, received_at timestamptz not null);`,
    );
  }
}

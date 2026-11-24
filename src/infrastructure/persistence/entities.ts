import { defineEntity, type InferEntity, p } from '@mikro-orm/core';

/*
 * Entidades de MikroORM sin clase. Replican las columnas de las migraciones
 * (que son la fuente del esquema) y guardan las relaciones como ids escalares:
 * los repositorios traducen estas filas a tipos del dominio y nadie fuera de
 * `infrastructure` las ve.
 */

export const ClinicEntity = defineEntity({
  name: 'Clinic',
  properties: {
    id: p.uuid().primary(),
    name: p.text(),
    timezone: p.text(),
  },
});
export type ClinicRow = InferEntity<typeof ClinicEntity>;

export const PatientEntity = defineEntity({
  name: 'Patient',
  properties: {
    id: p.uuid().primary(),
    clinicId: p.uuid(),
    name: p.text(),
    phone: p.text().nullable(),
    acceptsReminders: p.boolean(),
  },
});
export type PatientRow = InferEntity<typeof PatientEntity>;

export const AppointmentEntity = defineEntity({
  name: 'Appointment',
  properties: {
    id: p.uuid().primary(),
    clinicId: p.uuid(),
    patientId: p.uuid(),
    startsAt: p.datetime(),
    status: p.enum(['scheduled', 'confirmed', 'cancelled']).columnType('text'),
    virtual: p.boolean().default(false),
  },
});
export type AppointmentRow = InferEntity<typeof AppointmentEntity>;

export const ReminderEntity = defineEntity({
  name: 'Reminder',
  properties: {
    id: p.uuid().primary(),
    appointmentId: p.uuid(),
    scheduledFor: p.datetime(),
    status: p
      .enum(['pending', 'sent', 'failed', 'skipped', 'cancelled'])
      .columnType('text'),
    skipReason: p
      .enum(['too_late', 'no_phone', 'opted_out'])
      .columnType('text')
      .nullable(),
    attempts: p.integer().default(0),
    nextAttemptAt: p.datetime().nullable(),
    sentAt: p.datetime().nullable(),
    sentTo: p.text().nullable(),
    // Orden de envío (secuencia `reminder_send_seq`); no depende de `sentAt`.
    sendSeq: p.bigint('number').nullable(),
  },
});
export type ReminderRow = InferEntity<typeof ReminderEntity>;

export const InboundMessageEntity = defineEntity({
  name: 'InboundMessage',
  properties: {
    messageId: p.text().primary(),
    receivedAt: p.datetime(),
  },
});
export type InboundMessageRow = InferEntity<typeof InboundMessageEntity>;

/** Todas las entidades, para la configuración de MikroORM. */
export const entities = [
  ClinicEntity,
  PatientEntity,
  AppointmentEntity,
  ReminderEntity,
  InboundMessageEntity,
];

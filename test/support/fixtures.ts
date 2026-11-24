import type { TestApp } from './app.js';

export type ClinicBody = { id: string; name: string; timezone: string };

export type PatientBody = {
  id: string;
  clinicId: string;
  name: string;
  phone: string | null;
  acceptsReminders: boolean;
};

/** Crea una clínica por la API (Madrid por defecto) y devuelve el cuerpo del 201. */
export async function createClinic(
  t: TestApp,
  over: Partial<Omit<ClinicBody, 'id'>> = {},
): Promise<ClinicBody> {
  const res = await t.http
    .post('/clinics')
    .send({
      name: 'Clínica Dental Sonrisa',
      timezone: 'Europe/Madrid',
      ...over,
    })
    .expect(201);
  // Límite con supertest: el cuerpo llega sin tipo y el 201 garantiza su forma.
  return res.body as ClinicBody;
}

/** Crea un paciente de `clinicId` por la API y devuelve el cuerpo del 201. */
export async function createPatient(
  t: TestApp,
  clinicId: string,
  over: Partial<Omit<PatientBody, 'id' | 'clinicId'>> = {},
): Promise<PatientBody> {
  const res = await t.http
    .post('/patients')
    .send({
      clinicId,
      name: 'Ana',
      phone: '+34600111222',
      acceptsReminders: true,
      ...over,
    })
    .expect(201);
  // Límite con supertest: el cuerpo llega sin tipo y el 201 garantiza su forma.
  return res.body as PatientBody;
}

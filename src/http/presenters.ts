import type { Clinic } from '../domain/clinic.js';
import type { Patient } from '../domain/patient.js';

/** `Clinic` del contrato. */
export type ClinicResponse = { id: string; name: string; timezone: string };

/** `Patient` del contrato. */
export type PatientResponse = {
  id: string;
  clinicId: string;
  name: string;
  phone: string | null;
  acceptsReminders: boolean;
};

/** Da a una clínica la forma de la respuesta del contrato. */
export function presentClinic(clinic: Clinic): ClinicResponse {
  return { id: clinic.id, name: clinic.name, timezone: clinic.timezone };
}

/** Da a un paciente la forma de la respuesta del contrato. */
export function presentPatient(patient: Patient): PatientResponse {
  return {
    id: patient.id,
    clinicId: patient.clinicId,
    name: patient.name,
    phone: patient.phone,
    acceptsReminders: patient.acceptsReminders,
  };
}

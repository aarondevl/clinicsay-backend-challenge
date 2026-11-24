/**
 * Teléfono en formato E.164: `+`, una cifra del 1 al 9 y de 7 a 14 cifras más.
 * Es la misma expresión que usa el proveedor para aceptar un envío.
 */
export const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Paciente de una clínica. Sin teléfono (`null`) o con `acceptsReminders` a
 * `false`, sus recordatorios se descartan al ir a enviarlos.
 */
export type Patient = {
  id: string;
  clinicId: string;
  name: string;
  phone: string | null;
  acceptsReminders: boolean;
};

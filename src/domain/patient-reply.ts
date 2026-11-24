/** Respuesta del paciente al recordatorio: SI confirma la cita y NO la cancela. */
export type PatientReply = 'yes' | 'no';

// Lo que no es una letra al principio o al final: espacios, signos y emojis.
const AROUND_LETTERS = /^[^\p{L}]+|[^\p{L}]+$/gu;
// Marcas combinantes que quedan sueltas al descomponer (NFD) una letra con tilde.
const COMBINING_MARKS = /\p{M}/gu;

/**
 * Lee la respuesta de un paciente. Solo cuentan SI y NO, sin distinguir
 * mayúsculas ni tildes y con espacios o signos alrededor (`Sí`, `si.`,
 * `¡NO!`). Cualquier otro texto, también uno que empiece por SI (`Sí,
 * gracias`), no es una respuesta.
 *
 * @returns `'yes'`, `'no'` o `null` si el texto se ignora.
 */
export function parseReply(text: string): PatientReply | null {
  const word = text
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(AROUND_LETTERS, '')
    .toLowerCase();
  if (word === 'si') return 'yes';
  if (word === 'no') return 'no';
  return null;
}

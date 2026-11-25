/** Respuesta del paciente al recordatorio: SI confirma la cita y NO la cancela. */
export type PatientReply = 'yes' | 'no';

// Una sola palabra, con lo que no es una letra (espacios, signos, emojis)
// delante y detrás. Anclada y con clases disjuntas, se lee en tiempo lineal:
// `[^\p{L}]+$` con el flag `g` se probaba en cada posición y retrocedía hasta
// el final, y 100 000 caracteres tardaban segundos.
const ONE_WORD = /^[^\p{L}]*(\p{L}+)[^\p{L}]*$/u;
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
  const word = ONE_WORD.exec(
    text.normalize('NFD').replace(COMBINING_MARKS, ''),
  )?.[1]?.toLowerCase();
  if (word === 'si') return 'yes';
  if (word === 'no') return 'no';
  return null;
}

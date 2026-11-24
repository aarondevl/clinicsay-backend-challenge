import { parseReply } from './patient-reply.js';

describe('parseReply', () => {
  it.each([
    'Sí',
    'si.',
    'SI',
    '  sí  ',
    '¡SÍ!',
    // «Sí» con el acento como carácter combinado (NFD), como lo mandan algunos teclados.
    'Si\u0301',
    '\tsi\n',
    // Tilde en la primera letra: queda entre las dos y el recorte de los extremos no la quita.
    'Śi',
  ])('%j es yes', (text) => {
    expect(parseReply(text)).toBe('yes');
  });

  it.each(['NO!', 'no', 'No.', '  NO  ', '¡No!', '"no"'])(
    '%j es no',
    (text) => {
      expect(parseReply(text)).toBe('no');
    },
  );

  it.each([
    'Sí, gracias',
    'sip',
    'n o',
    '',
    '   ',
    '!!',
    'SI NO',
    'nos',
    'sino',
  ])('%j se ignora', (text) => {
    expect(parseReply(text)).toBeNull();
  });
});

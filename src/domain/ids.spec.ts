import { isId } from './ids.js';

describe('isId', () => {
  it('acepta un UUID en forma canónica', () => {
    expect(isId('0190a000-0000-7000-8000-000000000001')).toBe(true);
  });

  it('acepta un UUID en mayúsculas, que Postgres también lee', () => {
    expect(isId('0190A000-0000-7000-8000-00000000000F')).toBe(true);
  });

  it.each([
    ['un texto cualquiera', 'abc'],
    ['el texto vacío', ''],
    ['un UUID sin guiones', '0190a000000070008000000000000001'],
    ['un UUID entre llaves', '{0190a000-0000-7000-8000-000000000001}'],
    ['un UUID con un espacio detrás', '0190a000-0000-7000-8000-000000000001 '],
    [
      'un carácter que no es hexadecimal',
      '0190a000-0000-7000-8000-00000000000g',
    ],
  ])('rechaza %s', (_label, value) => {
    expect(isId(value)).toBe(false);
  });
});

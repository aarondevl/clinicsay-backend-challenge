import { isId } from '../../domain/ids.js';
import { UuidV7IdGenerator } from './uuid-v7-id-generator.js';

describe('UuidV7IdGenerator', () => {
  const ids = new UuidV7IdGenerator();

  it('genera UUID de la versión 7', () => {
    const id = ids.next();
    expect(isId(id)).toBe(true);
    expect(id[14]).toBe('7');
  });

  // Los recordatorios de una cita se listan por id: con el reloj de test
  // congelado, el id es lo único que conserva el orden de creación.
  it('cada id es mayor que el anterior, también dentro del mismo milisegundo', () => {
    const generated = Array.from({ length: 1000 }, () => ids.next());
    expect(generated).toEqual([...generated].sort());
    expect(new Set(generated).size).toBe(generated.length);
  });
});

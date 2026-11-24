import { toApiDate } from './api-date.js';

describe('toApiDate', () => {
  it('devuelve UTC con Z y sin milisegundos cuando son cero', () => {
    expect(toApiDate(new Date('2027-03-27T09:00:00.000Z'))).toBe(
      '2027-03-27T09:00:00Z',
    );
  });

  it('conserva los milisegundos cuando no son cero', () => {
    expect(toApiDate(new Date('2027-03-27T09:00:00.500Z'))).toBe(
      '2027-03-27T09:00:00.500Z',
    );
  });
});

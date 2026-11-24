import { isIsoDateTimeWithZone } from './validation.js';

describe('isIsoDateTimeWithZone', () => {
  it('acepta una fecha en UTC con Z', () => {
    expect(isIsoDateTimeWithZone('2027-03-28T08:00:00Z')).toBe(true);
  });

  it('acepta una fecha con offset', () => {
    expect(isIsoDateTimeWithZone('2027-03-28T10:00:00+02:00')).toBe(true);
  });

  it('rechaza una fecha sin zona', () => {
    expect(isIsoDateTimeWithZone('2027-03-28T10:00:00')).toBe(false);
  });

  it('rechaza un día que no existe', () => {
    expect(isIsoDateTimeWithZone('2027-02-30T10:00:00Z')).toBe(false);
  });

  it('rechaza un texto que no es fecha', () => {
    expect(isIsoDateTimeWithZone('mañana')).toBe(false);
  });

  it('rechaza lo que no es texto', () => {
    expect(isIsoDateTimeWithZone(123)).toBe(false);
  });
});

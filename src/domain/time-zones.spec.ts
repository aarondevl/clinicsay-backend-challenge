import {
  VIRTUAL_TIME_ZONE,
  effectiveTimeZone,
  isValidTimeZone,
} from './time-zones.js';

describe('effectiveTimeZone', () => {
  it('una cita virtual usa la hora de Madrid', () => {
    expect(effectiveTimeZone('Atlantic/Canary', true)).toBe('Europe/Madrid');
  });

  it('una cita presencial usa la zona de la clínica', () => {
    expect(effectiveTimeZone('Atlantic/Canary', false)).toBe('Atlantic/Canary');
  });

  it('la zona de las citas virtuales es Europe/Madrid', () => {
    expect(VIRTUAL_TIME_ZONE).toBe('Europe/Madrid');
  });
});

describe('isValidTimeZone', () => {
  it.each(['Europe/Madrid', 'Atlantic/Canary'])('acepta %s', (zone) => {
    expect(isValidTimeZone(zone)).toBe(true);
  });

  it('rechaza una zona que no existe', () => {
    expect(isValidTimeZone('Europe/Narnia')).toBe(false);
  });

  it('rechaza el texto vacío', () => {
    expect(isValidTimeZone('')).toBe(false);
  });

  // Luxon las acepta como zona (localDateTime no las rechaza), pero no son
  // zonas IANA: dependen de la máquina donde corre el servicio.
  it.each(['local', 'system'])('rechaza %s', (zone) => {
    expect(isValidTimeZone(zone)).toBe(false);
  });

  // Intl acepta un offset como zona, pero no es IANA ni cambia de horario.
  it.each(['+01:00', '-05:00'])('rechaza el offset %s', (zone) => {
    expect(isValidTimeZone(zone)).toBe(false);
  });
});

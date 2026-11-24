import { VIRTUAL_TIME_ZONE, effectiveTimeZone } from './time-zones.js';

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

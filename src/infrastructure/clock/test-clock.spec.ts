import { TestClock } from './test-clock.js';

describe('TestClock', () => {
  it('queda congelado en la hora fijada hasta el siguiente set', async () => {
    const clock = new TestClock();
    clock.set(new Date('2027-03-01T00:00:00Z'));
    await new Promise((r) => setTimeout(r, 5));
    expect(clock.now().toISOString()).toBe('2027-03-01T00:00:00.000Z');
    clock.set(new Date('2027-03-02T10:00:00Z'));
    expect(clock.now().toISOString()).toBe('2027-03-02T10:00:00.000Z');
  });

  it('no deja que quien lee la hora la modifique', () => {
    const clock = new TestClock();
    clock.set(new Date('2027-03-01T00:00:00Z'));
    clock.now().setUTCFullYear(2000);
    expect(clock.now().getUTCFullYear()).toBe(2027);
  });
});

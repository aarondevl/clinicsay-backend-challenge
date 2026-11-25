import { planReminder, quietHoursEnd } from './reminder-schedule.js';

const DEFAULT_NOW = '2027-03-01T00:00:00Z';
const MADRID = 'Europe/Madrid';

type Case = {
  name: string;
  startsAt: string;
  timeZone?: string;
  now?: string;
  scheduledFor: string;
  skipReason: 'too_late' | null;
};

// Valores esperados sacados del enunciado (día anterior, misma hora local,
// franja [21:00, 09:00), «ya pasó» y too_late) y de las fechas reales de los
// cambios de horario de 2027 (28 de marzo y 31 de octubre).
const cases: Case[] = [
  {
    name: 'ejemplo del enunciado: 23 h por el cambio de marzo',
    startsAt: '2027-03-28T08:00:00Z',
    scheduledFor: '2027-03-27T09:00:00Z',
    skipReason: null,
  },
  {
    name: 'Canarias en el cambio de marzo',
    startsAt: '2027-03-28T09:00:00Z',
    timeZone: 'Atlantic/Canary',
    scheduledFor: '2027-03-27T10:00:00Z',
    skipReason: null,
  },
  {
    name: 'cambio de octubre: 25 h',
    startsAt: '2027-10-31T09:00:00Z',
    scheduledFor: '2027-10-30T08:00:00Z',
    skipReason: null,
  },
  {
    name: 'franja por la noche (22:30) pasa a las 09:00 del día siguiente',
    startsAt: '2027-03-10T21:30:00Z',
    scheduledFor: '2027-03-10T08:00:00Z',
    skipReason: null,
  },
  {
    name: 'franja de madrugada (08:00) pasa a las 09:00 de ese día',
    startsAt: '2027-03-10T07:00:00Z',
    scheduledFor: '2027-03-09T08:00:00Z',
    skipReason: null,
  },
  {
    name: '21:00 en punto se mueve',
    startsAt: '2027-03-10T20:00:00Z',
    scheduledFor: '2027-03-10T08:00:00Z',
    skipReason: null,
  },
  {
    name: '09:00 en punto se envía',
    startsAt: '2027-03-10T08:00:00Z',
    scheduledFor: '2027-03-09T08:00:00Z',
    skipReason: null,
  },
  {
    name: 'ya pasó: se usa la hora actual',
    startsAt: '2027-03-10T17:00:00Z',
    now: '2027-03-10T12:00:00Z',
    scheduledFor: '2027-03-10T12:00:00Z',
    skipReason: null,
  },
  {
    name: 'ya pasó y la hora actual cae en la franja',
    startsAt: '2027-03-11T09:00:00Z',
    now: '2027-03-10T21:30:00Z',
    scheduledFor: '2027-03-11T08:00:00Z',
    skipReason: null,
  },
  {
    name: 'too_late: las 09:00 no quedan antes de las 08:30',
    startsAt: '2027-03-11T07:30:00Z',
    now: '2027-03-10T21:30:00Z',
    scheduledFor: '2027-03-11T08:00:00Z',
    skipReason: 'too_late',
  },
  {
    name: 'too_late por igualdad con el inicio',
    startsAt: '2027-03-11T08:00:00Z',
    now: '2027-03-10T21:30:00Z',
    scheduledFor: '2027-03-11T08:00:00Z',
    skipReason: 'too_late',
  },
  {
    name: 'hora que no existe el día del cambio de marzo (02:30) acaba a las 09:00',
    startsAt: '2027-03-29T00:30:00Z',
    scheduledFor: '2027-03-28T07:00:00Z',
    skipReason: null,
  },
  {
    name: 'hora repetida el día del cambio de octubre (02:30) acaba a las 09:00',
    startsAt: '2027-11-01T01:30:00Z',
    scheduledFor: '2027-10-31T08:00:00Z',
    skipReason: null,
  },
  {
    name: 'la franja salta al día del cambio y usa su nuevo desfase',
    startsAt: '2027-03-28T21:00:00Z',
    scheduledFor: '2027-03-28T07:00:00Z',
    skipReason: null,
  },
];

describe('planReminder', () => {
  it.each(cases)(
    '$name',
    ({ startsAt, timeZone, now, scheduledFor, skipReason }) => {
      const plan = planReminder({
        startsAt: new Date(startsAt),
        timeZone: timeZone ?? MADRID,
        now: new Date(now ?? DEFAULT_NOW),
      });

      expect(plan).toEqual({
        scheduledFor: new Date(scheduledFor),
        skipReason,
      });
    },
  );

  it('falla con una zona IANA que no existe en vez de devolver una fecha inválida', () => {
    expect(() =>
      planReminder({
        startsAt: new Date('2027-03-28T08:00:00Z'),
        timeZone: 'Mars/Olympus',
        now: new Date(DEFAULT_NOW),
      }),
    ).toThrow('invalid time zone: Mars/Olympus');
  });
});

// Bordes del enunciado: [21:00, 09:00) en hora local, las 09:00 siguientes, el
// cambio de horario de marzo y Canarias una hora por detrás.
const quietCases: {
  name: string;
  at: string;
  timeZone?: string;
  end: string | null;
}[] = [
  {
    name: '20:59:59 todavía no es franja',
    at: '2027-03-10T19:59:59Z',
    end: null,
  },
  {
    name: '21:00 en punto es franja: hasta las 09:00 del día siguiente',
    at: '2027-03-10T20:00:00Z',
    end: '2027-03-11T08:00:00Z',
  },
  {
    name: '23:00: hasta las 09:00 del día siguiente',
    at: '2027-03-10T22:00:00Z',
    end: '2027-03-11T08:00:00Z',
  },
  {
    name: 'madrugada (03:00): hasta las 09:00 de ese día',
    at: '2027-03-11T02:00:00Z',
    end: '2027-03-11T08:00:00Z',
  },
  {
    name: '08:59:59 todavía es franja',
    at: '2027-03-11T07:59:59Z',
    end: '2027-03-11T08:00:00Z',
  },
  {
    name: '09:00 en punto ya no es franja',
    at: '2027-03-11T08:00:00Z',
    end: null,
  },
  {
    name: 'las 09:00 siguientes caen después del cambio de marzo (CEST)',
    at: '2027-03-27T22:00:00Z',
    end: '2027-03-28T07:00:00Z',
  },
  {
    name: 'Canarias: 21:00 de Canarias son las 22:00 de Madrid',
    at: '2027-03-10T21:00:00Z',
    timeZone: 'Atlantic/Canary',
    end: '2027-03-11T09:00:00Z',
  },
  {
    name: 'Canarias: 20:30 de Canarias no es franja aunque en Madrid sí',
    at: '2027-03-10T20:30:00Z',
    timeZone: 'Atlantic/Canary',
    end: null,
  },
];

describe('quietHoursEnd', () => {
  it.each(quietCases)('$name', ({ at, timeZone, end }) => {
    expect(quietHoursEnd(new Date(at), timeZone ?? MADRID)).toEqual(
      end === null ? null : new Date(end),
    );
  });

  it('falla con una zona IANA que no existe', () => {
    expect(() =>
      quietHoursEnd(new Date('2027-03-10T20:00:00Z'), 'Mars/Olympus'),
    ).toThrow('invalid time zone: Mars/Olympus');
  });
});

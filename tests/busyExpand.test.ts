import { describe, expect, it } from 'vitest';
import { expandCalendarBusy } from '../api/_lib/busyExpand';

// ── fixtures ─────────────────────────────────────────────────────────────────

const vcal = (...lines: string[]): string =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...lines, 'END:VCALENDAR'].join('\r\n');

const vevent = (...lines: string[]): string[] => [
  'BEGIN:VEVENT',
  'DTSTAMP:20260701T000000Z',
  ...lines,
  'END:VEVENT',
];

// Apple-style IANA VTIMEZONE (US Eastern, DST rules).
const NEW_YORK_VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:America/New_York',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0400',
  'TZNAME:EDT',
  'DTSTART:20070311T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:-0400',
  'TZOFFSETTO:-0500',
  'TZNAME:EST',
  'DTSTART:20071104T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
];

// The chunk-36 smoke week: Mon 2026-07-27 → Mon 2026-08-03.
const WEEK = { from: '2026-07-27T00:00:00Z', to: '2026-08-03T00:00:00Z' };

// The "Pago Tarjeta Sergio" shape: TZID master + weekly-Friday RRULE.
const weeklyFridayEt = (...extra: string[]): string =>
  vcal(
    ...NEW_YORK_VTIMEZONE,
    ...vevent(
      'UID:pago-1',
      'DTSTART;TZID=America/New_York:20250701T100000',
      'DTEND;TZID=America/New_York:20250701T103000',
      'RRULE:FREQ=WEEKLY;BYDAY=FR',
      ...extra,
      'SUMMARY:Pago Tarjeta Sergio',
    ),
  );

// ── expandCalendarBusy ───────────────────────────────────────────────────────

describe('expandCalendarBusy', () => {
  it("expands a TZID master + weekly RRULE to this week's occurrence, not the series DTSTART", () => {
    const busy = expandCalendarBusy(weeklyFridayEt(), WEEK.from, WEEK.to);
    expect(busy).toEqual([
      {
        start: '2026-07-31T14:00:00.000Z', // Fri 10:00 ET = 14:00Z in EDT
        end: '2026-07-31T14:30:00.000Z',
        title: 'Pago Tarjeta Sergio',
      },
    ]);
    expect(new Date(busy[0]!.start).getUTCDay()).toBe(5); // Friday
  });

  it('converts a plain timed TZID event to UTC (the Smoke-A shape)', () => {
    const raw = vcal(
      ...NEW_YORK_VTIMEZONE,
      ...vevent(
        'UID:smoke-a',
        'DTSTART;TZID=America/New_York:20260728T100000',
        'DTEND;TZID=America/New_York:20260728T113000',
        'SUMMARY:Smoke A',
      ),
    );
    expect(expandCalendarBusy(raw, WEEK.from, WEEK.to)).toEqual([
      { start: '2026-07-28T14:00:00.000Z', end: '2026-07-28T15:30:00.000Z', title: 'Smoke A' },
    ]);
  });

  it('excludes all-day events from busy', () => {
    const raw = vcal(
      ...vevent(
        'UID:rent',
        'DTSTART;VALUE=DATE:20260729',
        'DTEND;VALUE=DATE:20260730',
        'SUMMARY:Rent Due',
      ),
    );
    expect(expandCalendarBusy(raw, WEEK.from, WEEK.to)).toEqual([]);
  });

  it('passes a UTC-suffixed event through unchanged', () => {
    const raw = vcal(
      ...vevent('UID:u1', 'DTSTART:20260729T140000Z', 'DTEND:20260729T150000Z', 'SUMMARY:UTC'),
    );
    expect(expandCalendarBusy(raw, WEEK.from, WEEK.to)).toEqual([
      { start: '2026-07-29T14:00:00.000Z', end: '2026-07-29T15:00:00.000Z', title: 'UTC' },
    ]);
  });

  it('honors EXDATE on the recurring fixture', () => {
    const busy = expandCalendarBusy(
      weeklyFridayEt('EXDATE;TZID=America/New_York:20260731T100000'),
      WEEK.from,
      '2026-08-10T00:00:00Z', // two weeks, so the exclusion leaves the next Friday
    );
    expect(busy.map((b) => b.start)).toEqual(['2026-08-07T14:00:00.000Z']);
  });
});

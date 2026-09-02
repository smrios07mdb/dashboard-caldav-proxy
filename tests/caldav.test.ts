import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createAccountMock,
  propfindMock,
  fetchCalendarObjectsMock,
  createCalendarObjectMock,
  updateCalendarObjectMock,
  deleteCalendarObjectMock,
  getBasicAuthHeadersMock,
} = vi.hoisted(() => ({
  createAccountMock: vi.fn(),
  propfindMock: vi.fn(),
  fetchCalendarObjectsMock: vi.fn(),
  createCalendarObjectMock: vi.fn(),
  updateCalendarObjectMock: vi.fn(),
  deleteCalendarObjectMock: vi.fn(),
  getBasicAuthHeadersMock: vi.fn(() => ({ authorization: 'Basic xxx' })),
}));

vi.mock('../api/_lib/tsdav', () => ({
  createAccount: createAccountMock,
  propfind: propfindMock,
  fetchCalendarObjects: fetchCalendarObjectsMock,
  createCalendarObject: createCalendarObjectMock,
  updateCalendarObject: updateCalendarObjectMock,
  deleteCalendarObject: deleteCalendarObjectMock,
  getBasicAuthHeaders: getBasicAuthHeadersMock,
}));

import {
  CalDavError,
  classifyError,
  createEvent,
  deleteEvent,
  discover,
  getBusy,
  getCalendarBusy,
  PLANNER_UID_PREFIX,
  updateEvent,
} from '../api/_lib/caldav';
import { normalizeColor, parseReadCalendars } from '../api/_lib/readSet';

beforeEach(() => {
  vi.clearAllMocks();
  getBasicAuthHeadersMock.mockReturnValue({ authorization: 'Basic xxx' });
});

// ── classifyError: the error-handling policy (contribution point) ────────────
describe('classifyError', () => {
  it('returns a CalDavError', () => {
    expect(classifyError(new Error('whatever'))).toBeInstanceOf(CalDavError);
  });

  it('classifies 401 / Unauthorized as kind="auth"', () => {
    expect(
      classifyError(new Error('Invalid credentials: PROPFIND ... returned 401 Unauthorized')).kind,
    ).toBe('auth');
    expect(classifyError(new Error('Collection query failed: 401 Unauthorized')).kind).toBe('auth');
    expect(classifyError(new Error('CalDAV request failed: 401')).kind).toBe('auth');
  });

  it('classifies fetch/connection failures as kind="network"', () => {
    expect(classifyError(new TypeError('fetch failed')).kind).toBe('network');
    expect(
      classifyError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
        .kind,
    ).toBe('network');
  });

  it('classifies anything else as kind="other"', () => {
    expect(classifyError(new Error('Collection query failed: 500 Server Error')).kind).toBe(
      'other',
    );
    expect(classifyError('a bare string').kind).toBe('other');
  });
});

// ── discover ─────────────────────────────────────────────────────────────────
describe('discover', () => {
  const ROOT = 'https://caldav.icloud.com/';
  const HOME_URL = 'https://caldav.icloud.com/1/calendars/';
  const resp = (
    href: string,
    props: Record<string, unknown>,
  ): {
    href: string;
    ok: boolean;
    status: number;
    statusText: string;
    props: Record<string, unknown>;
  } => ({
    href,
    ok: true,
    status: 207,
    statusText: 'Multi-Status',
    props,
  });
  const comps = (...names: string[]) => ({
    comp: names.map((name) => ({ _attributes: { name } })),
  });

  beforeEach(() => {
    createAccountMock.mockResolvedValue({
      serverUrl: ROOT,
      rootUrl: ROOT,
      principalUrl: 'https://caldav.icloud.com/1/principal/',
      homeUrl: HOME_URL,
      accountType: 'caldav',
    });
  });

  it('runs a Depth-1 PROPFIND on the calendar home with Basic auth against iCloud', async () => {
    propfindMock.mockResolvedValue([]);
    await discover('me@icloud.com', 'app-pw');
    expect(createAccountMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account: expect.objectContaining({
          serverUrl: ROOT,
          credentials: { username: 'me@icloud.com', password: 'app-pw' },
          accountType: 'caldav',
        }),
        headers: { authorization: 'Basic xxx' },
      }),
    );
    expect(propfindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: HOME_URL,
        depth: '1',
        headers: { authorization: 'Basic xxx' },
        props: expect.objectContaining({
          'd:resourcetype': {},
          'ca:calendar-color': {},
        }),
      }),
    );
  });

  it('keeps <calendar/> AND <cs:subscribed/> collections (chunk 51b), with name and #rrggbb color', async () => {
    propfindMock.mockResolvedValue([
      // The home collection itself: no calendar resourcetype → skipped.
      resp('/1/calendars/', { displayname: 'Sergio', resourcetype: { collection: '' } }),
      resp('/1/calendars/home/', {
        displayname: 'Home',
        resourcetype: { collection: '', calendar: '' },
        calendarColor: '#FF2968FF',
        supportedCalendarComponentSet: comps('VEVENT'),
      }),
      // A subscription (US Holidays): tsdav's fetchCalendars drops this one.
      resp('/1/calendars/holidays/', {
        displayname: 'US Holidays',
        resourcetype: { collection: '', subscribed: '' },
        calendarColor: { _cdata: '#63DA38FF' },
        supportedCalendarComponentSet: comps('VEVENT'),
      }),
      // Reminders (VTODO only) → excluded.
      resp('/1/calendars/tasks/', {
        displayname: 'Reminders',
        resourcetype: { collection: '', calendar: '' },
        supportedCalendarComponentSet: comps('VTODO'),
      }),
      // Scheduling inbox / notifications carry neither resourcetype → excluded.
      resp('/1/calendars/inbox/', { resourcetype: { collection: '', scheduleInbox: '' } }),
      resp('/1/calendars/notification/', { resourcetype: { collection: '', notification: '' } }),
    ]);

    const out = await discover('me@icloud.com', 'app-pw');

    expect(out.calendars).toEqual([
      { url: 'https://caldav.icloud.com/1/calendars/home/', name: 'Home', color: '#ff2968' },
      {
        url: 'https://caldav.icloud.com/1/calendars/holidays/',
        name: 'US Holidays',
        color: '#63da38',
        subscribed: true,
      },
    ]);
  });

  it('a calendar with no component set is kept; no displayname → url; bad color → no color', async () => {
    propfindMock.mockResolvedValue([
      resp('/1/calendars/x/', {
        resourcetype: { collection: '', calendar: '' },
        calendarColor: 'red',
      }),
    ]);
    const out = await discover('me@icloud.com', 'app-pw');
    expect(out.calendars).toEqual([
      {
        url: 'https://caldav.icloud.com/1/calendars/x/',
        name: 'https://caldav.icloud.com/1/calendars/x/',
      },
    ]);
  });

  it('maps a 401 during login to CalDavError(kind="auth")', async () => {
    createAccountMock.mockRejectedValue(
      new Error('Invalid credentials: PROPFIND returned 401 Unauthorized'),
    );
    await expect(discover('me@icloud.com', 'bad')).rejects.toMatchObject({ kind: 'auth' });
  });
});

// ── getBusy ──────────────────────────────────────────────────────────────────

const vobject = (...eventLines: string[]): string =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//test//EN',
    'BEGIN:VEVENT',
    'DTSTAMP:20260501T000000Z',
    ...eventLines,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

describe('getCalendarBusy (single calendar — the chunk-39 body)', () => {
  it('expands VEVENT objects into busy intervals without expand:true', async () => {
    fetchCalendarObjectsMock.mockResolvedValue([
      {
        url: 'https://caldav.icloud.com/1/calendars/home/evt.ics',
        data: vobject('UID:abc', 'DTSTART:20260528T140000Z', 'DTEND:20260528T150000Z'),
      },
    ]);

    const busy = await getCalendarBusy(
      'https://caldav.icloud.com/1/calendars/home/',
      'me@icloud.com',
      'app-pw',
      '2026-05-28T00:00:00Z',
      '2026-05-29T00:00:00Z',
    );

    expect(busy.intervals).toEqual([
      { start: '2026-05-28T14:00:00.000Z', end: '2026-05-28T15:00:00.000Z' },
    ]);
    expect(busy.plannerEvents).toEqual([]);
    // Expansion is local (busyExpand.ts) — tsdav's expand flag must stay off,
    // since multiget ignores it and returns raw masters anyway.
    expect(fetchCalendarObjectsMock.mock.calls[0]?.[0]).not.toHaveProperty('expand');
  });

  it("expands a TZID + RRULE master to the queried week's occurrence in UTC", async () => {
    fetchCalendarObjectsMock.mockResolvedValue([
      {
        url: 'https://caldav.icloud.com/1/calendars/home/pago.ics',
        data: [
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
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
          'BEGIN:VEVENT',
          'UID:pago',
          'DTSTAMP:20260501T000000Z',
          'DTSTART;TZID=America/New_York:20250701T100000',
          'DTEND;TZID=America/New_York:20250701T103000',
          'RRULE:FREQ=WEEKLY;BYDAY=FR',
          'SUMMARY:Pago Tarjeta Sergio',
          'END:VEVENT',
          'END:VCALENDAR',
        ].join('\r\n'),
      },
    ]);

    const busy = await getCalendarBusy(
      'https://caldav.icloud.com/1/calendars/home/',
      'me@icloud.com',
      'app-pw',
      '2026-07-27T00:00:00Z',
      '2026-08-03T00:00:00Z',
    );

    expect(busy.intervals).toEqual([
      {
        start: '2026-07-31T14:00:00.000Z',
        end: '2026-07-31T14:30:00.000Z',
        title: 'Pago Tarjeta Sergio',
      },
    ]);
  });

  it('skips a malformed object but keeps valid ones', async () => {
    fetchCalendarObjectsMock.mockResolvedValue([
      { url: 'https://caldav.icloud.com/1/calendars/home/bad.ics', data: 12345 },
      { url: 'https://caldav.icloud.com/1/calendars/home/junk.ics', data: 'not an icalendar' },
      {
        url: 'https://caldav.icloud.com/1/calendars/home/good.ics',
        data: vobject(
          'UID:good',
          'DTSTART:20260528T140000Z',
          'DTEND:20260528T150000Z',
          'SUMMARY:Kept',
        ),
      },
    ]);

    const busy = await getCalendarBusy(
      'https://caldav.icloud.com/1/calendars/home/',
      'me@icloud.com',
      'app-pw',
      '2026-05-28T00:00:00Z',
      '2026-05-29T00:00:00Z',
    );

    expect(busy.intervals).toEqual([
      { start: '2026-05-28T14:00:00.000Z', end: '2026-05-28T15:00:00.000Z', title: 'Kept' },
    ]);
  });

  it('excludes all-day objects from busy', async () => {
    fetchCalendarObjectsMock.mockResolvedValue([
      {
        url: 'https://caldav.icloud.com/1/calendars/home/rent.ics',
        data: vobject(
          'UID:rent',
          'DTSTART;VALUE=DATE:20260528',
          'DTEND;VALUE=DATE:20260529',
          'SUMMARY:Rent Due',
        ),
      },
    ]);

    const busy = await getCalendarBusy(
      'https://caldav.icloud.com/1/calendars/home/',
      'me@icloud.com',
      'app-pw',
      '2026-05-28T00:00:00Z',
      '2026-05-29T00:00:00Z',
    );

    expect(busy.intervals).toEqual([]);
  });

  it('routes hupo-block- objects to plannerEvents and keeps them out of intervals', async () => {
    fetchCalendarObjectsMock.mockResolvedValue([
      {
        url: 'https://caldav.icloud.com/1/calendars/home/hupo-block-1.ics',
        data: vobject(
          `UID:${PLANNER_UID_PREFIX}1`,
          'DTSTART:20260528T090000Z',
          'DTEND:20260528T093000Z',
          'SUMMARY:Draft brief',
          'DESCRIPTION:Planned in Hupomnemata',
        ),
      },
      {
        url: 'https://caldav.icloud.com/1/calendars/home/evt.ics',
        data: vobject(
          'UID:abc',
          'DTSTART:20260528T140000Z',
          'DTEND:20260528T150000Z',
          'SUMMARY:Standup',
        ),
      },
    ]);

    const busy = await getCalendarBusy(
      'https://caldav.icloud.com/1/calendars/home/',
      'me@icloud.com',
      'app-pw',
      '2026-05-28T00:00:00Z',
      '2026-05-29T00:00:00Z',
    );

    expect(busy.intervals).toEqual([
      { start: '2026-05-28T14:00:00.000Z', end: '2026-05-28T15:00:00.000Z', title: 'Standup' },
    ]);
    expect(busy.plannerEvents).toEqual([
      {
        uid: 'hupo-block-1',
        start: '2026-05-28T09:00:00.000Z',
        end: '2026-05-28T09:30:00.000Z',
      },
    ]);
  });

  it('a planner object outside the window is neither busy nor reported', async () => {
    fetchCalendarObjectsMock.mockResolvedValue([
      {
        url: 'https://caldav.icloud.com/1/calendars/home/hupo-block-2.ics',
        data: vobject(
          `UID:${PLANNER_UID_PREFIX}2`,
          'DTSTART:20260601T090000Z',
          'DTEND:20260601T093000Z',
        ),
      },
    ]);
    const busy = await getCalendarBusy(
      'https://caldav.icloud.com/1/calendars/home/',
      'me@icloud.com',
      'app-pw',
      '2026-05-28T00:00:00Z',
      '2026-05-29T00:00:00Z',
    );
    expect(busy).toEqual({ intervals: [], plannerEvents: [] });
  });

  it('maps a 401 to CalDavError(kind="auth")', async () => {
    fetchCalendarObjectsMock.mockRejectedValue(
      new Error('Collection query failed: 401 Unauthorized'),
    );
    await expect(
      getCalendarBusy('u', 'me@icloud.com', 'pw', '2026-05-28T00:00:00Z', '2026-05-29T00:00:00Z'),
    ).rejects.toMatchObject({ kind: 'auth' });
  });
});

// ── getBusy: multi-calendar read (chunk 51) ──────────────────────────────────

const HOME = 'https://caldav.icloud.com/1/calendars/home/';
const WORK = 'https://caldav.icloud.com/1/calendars/work/';
const FAMILY = 'https://caldav.icloud.com/1/calendars/family/';
const WINDOW = ['2026-05-28T00:00:00Z', '2026-05-29T00:00:00Z'] as const;

/** One plain VEVENT object at `hh:00–hh+1:00Z` on 2026-05-28. */
const evt = (uid: string, hh: number, summary = uid) => ({
  url: `${uid}.ics`,
  data: vobject(
    `UID:${uid}`,
    `DTSTART:20260528T${String(hh).padStart(2, '0')}0000Z`,
    `DTEND:20260528T${String(hh + 1).padStart(2, '0')}0000Z`,
    `SUMMARY:${summary}`,
  ),
});

/** Route `fetchCalendarObjects` by calendar url. */
function mockCalendars(byUrl: Record<string, unknown[] | Error>) {
  fetchCalendarObjectsMock.mockImplementation(async (args: { calendar: { url: string } }) => {
    const v = byUrl[args.calendar.url];
    if (v instanceof Error) throw v;
    return v ?? [];
  });
}

describe('getBusy (multi-calendar read, chunk 51)', () => {
  it('fans out across enabled calendars and merges intervals sorted, tagged with the calendar name', async () => {
    mockCalendars({
      [HOME]: [evt('h1', 14, 'Dentist')],
      [WORK]: [evt('w1', 9, 'Standup'), evt('w2', 16, 'Review')],
      [FAMILY]: [evt('f1', 12, 'Lunch')],
    });
    const out = await getBusy(
      [
        { url: HOME, name: 'Home', enabled: true },
        { url: WORK, name: 'Work', enabled: true },
        { url: FAMILY, name: 'Family', enabled: true },
      ],
      HOME,
      'me@icloud.com',
      'pw',
      ...WINDOW,
    );
    expect(out.intervals.map((i) => [i.title, i.calendar])).toEqual([
      ['Standup', 'Work'],
      ['Lunch', 'Family'],
      ['Dentist', 'Home'],
      ['Review', 'Work'],
    ]);
    expect(out.calendars).toEqual([
      { url: HOME, name: 'Home', ok: true },
      { url: WORK, name: 'Work', ok: true },
      { url: FAMILY, name: 'Family', ok: true },
    ]);
    // Each calendar fetched exactly once.
    expect(fetchCalendarObjectsMock).toHaveBeenCalledTimes(3);
  });

  it('tags every interval with its calendar’s color when the read set has one (chunk 51b)', async () => {
    mockCalendars({ [HOME]: [evt('h1', 14)], [WORK]: [evt('w1', 9)] });
    const out = await getBusy(
      [
        { url: HOME, name: 'Home', enabled: true, color: '#ff2968' },
        { url: WORK, name: 'Work', enabled: true },
      ],
      HOME,
      'me@icloud.com',
      'pw',
      ...WINDOW,
    );
    expect(out.intervals.map((i) => [i.calendar, i.color])).toEqual([
      ['Work', undefined],
      ['Home', '#ff2968'],
    ]);
    expect('color' in out.intervals[0]!).toBe(false);
  });

  it('a disabled calendar contributes nothing and is not fetched', async () => {
    mockCalendars({ [HOME]: [evt('h1', 14)], [WORK]: [evt('w1', 9)] });
    const out = await getBusy(
      [
        { url: HOME, name: 'Home', enabled: true },
        { url: WORK, name: 'Work', enabled: false },
      ],
      HOME,
      'me@icloud.com',
      'pw',
      ...WINDOW,
    );
    expect(out.intervals.map((i) => i.calendar)).toEqual(['Home']);
    expect(fetchCalendarObjectsMock).toHaveBeenCalledTimes(1);
    expect(out.calendars).toEqual([{ url: HOME, name: 'Home', ok: true }]);
  });

  it('a DISABLED write target is still fetched: its mirrors reach plannerEvents but its busy does not', async () => {
    mockCalendars({
      [HOME]: [
        evt('h1', 14, 'Dentist'),
        {
          url: 'hupo-block-1.ics',
          data: vobject(
            `UID:${PLANNER_UID_PREFIX}1`,
            'DTSTART:20260528T090000Z',
            'DTEND:20260528T093000Z',
          ),
        },
      ],
      [WORK]: [evt('w1', 16, 'Review')],
    });
    const out = await getBusy(
      [
        { url: HOME, name: 'Home', enabled: false },
        { url: WORK, name: 'Work', enabled: true },
      ],
      HOME,
      'me@icloud.com',
      'pw',
      ...WINDOW,
    );
    expect(out.intervals.map((i) => i.title)).toEqual(['Review']);
    expect(out.plannerEvents).toEqual([
      { uid: 'hupo-block-1', start: '2026-05-28T09:00:00.000Z', end: '2026-05-28T09:30:00.000Z' },
    ]);
    expect(fetchCalendarObjectsMock).toHaveBeenCalledTimes(2);
  });

  it('a write target absent from the read set is fetched for plannerEvents only, name left empty', async () => {
    mockCalendars({
      [HOME]: [
        evt('h1', 14, 'Dentist'),
        {
          url: 'hupo-block-2.ics',
          data: vobject(
            `UID:${PLANNER_UID_PREFIX}2`,
            'DTSTART:20260528T100000Z',
            'DTEND:20260528T110000Z',
          ),
        },
      ],
      [WORK]: [evt('w1', 16, 'Review')],
    });
    const out = await getBusy(
      [{ url: WORK, name: 'Work', enabled: true }],
      HOME,
      'me@icloud.com',
      'pw',
      ...WINDOW,
    );
    expect(out.intervals.map((i) => i.title)).toEqual(['Review']);
    expect(out.plannerEvents.map((e) => e.uid)).toEqual(['hupo-block-2']);
    expect(out.calendars).toEqual([
      { url: WORK, name: 'Work', ok: true },
      { url: HOME, name: '', ok: true },
    ]);
  });

  it('legacy null read set (write target only, empty name): intervals carry no `calendar`', async () => {
    mockCalendars({ [HOME]: [evt('h1', 14, 'Dentist')] });
    const out = await getBusy(
      [{ url: HOME, name: '', enabled: true }],
      HOME,
      'me@icloud.com',
      'pw',
      ...WINDOW,
    );
    expect(out.intervals).toEqual([
      { start: '2026-05-28T14:00:00.000Z', end: '2026-05-28T15:00:00.000Z', title: 'Dentist' },
    ]);
    expect(out.intervals[0]).not.toHaveProperty('calendar');
  });

  it('partial failure resolves with an ok:false entry and the other calendars’ intervals', async () => {
    mockCalendars({
      [HOME]: [evt('h1', 14, 'Dentist')],
      [WORK]: new Error('Collection query failed: 500 Server Error'),
    });
    const out = await getBusy(
      [
        { url: HOME, name: 'Home', enabled: true },
        { url: WORK, name: 'Work', enabled: true },
      ],
      HOME,
      'me@icloud.com',
      'pw',
      ...WINDOW,
    );
    expect(out.intervals.map((i) => i.title)).toEqual(['Dentist']);
    expect(out.calendars).toEqual([
      { url: HOME, name: 'Home', ok: true },
      { url: WORK, name: 'Work', ok: false, kind: 'other' },
    ]);
  });

  it('throws the first error when every calendar failed', async () => {
    mockCalendars({
      [HOME]: new Error('Collection query failed: 500 Server Error'),
      [WORK]: new TypeError('fetch failed'),
    });
    await expect(
      getBusy(
        [
          { url: HOME, name: 'Home', enabled: true },
          { url: WORK, name: 'Work', enabled: true },
        ],
        HOME,
        'me@icloud.com',
        'pw',
        ...WINDOW,
      ),
    ).rejects.toMatchObject({ kind: 'other' });
  });

  it('throws CalDavError(kind="auth") when every calendar failed with auth', async () => {
    mockCalendars({
      [HOME]: new Error('Collection query failed: 401 Unauthorized'),
      [WORK]: new Error('Collection query failed: 401 Unauthorized'),
    });
    const err = await getBusy(
      [
        { url: HOME, name: 'Home', enabled: true },
        { url: WORK, name: 'Work', enabled: true },
      ],
      HOME,
      'me@icloud.com',
      'pw',
      ...WINDOW,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CalDavError);
    expect((err as CalDavError).kind).toBe('auth');
  });

  it('an auth failure on ONE calendar with others fine is a partial failure, not an auth throw', async () => {
    mockCalendars({
      [HOME]: [evt('h1', 14, 'Dentist')],
      [WORK]: new Error('Collection query failed: 401 Unauthorized'),
    });
    const out = await getBusy(
      [
        { url: HOME, name: 'Home', enabled: true },
        { url: WORK, name: 'Work', enabled: true },
      ],
      HOME,
      'me@icloud.com',
      'pw',
      ...WINDOW,
    );
    expect(out.calendars[1]).toEqual({ url: WORK, name: 'Work', ok: false, kind: 'auth' });
  });

  it('never has more than 6 fetches in flight (concurrency pool)', async () => {
    let inFlight = 0;
    let peak = 0;
    fetchCalendarObjectsMock.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return [];
    });
    const calendars = Array.from({ length: 9 }, (_, i) => ({
      url: `https://caldav.icloud.com/1/calendars/c${i}/`,
      name: `C${i}`,
      enabled: true,
    }));
    const out = await getBusy(calendars, null, 'me@icloud.com', 'pw', ...WINDOW);
    expect(fetchCalendarObjectsMock).toHaveBeenCalledTimes(9);
    expect(peak).toBeLessThanOrEqual(6);
    expect(peak).toBeGreaterThan(1);
    expect(out.calendars).toHaveLength(9);
  });

  it('an empty fetch set (nothing enabled, no write target) resolves empty without throwing', async () => {
    const out = await getBusy(
      [{ url: HOME, name: 'Home', enabled: false }],
      null,
      'me@icloud.com',
      'pw',
      ...WINDOW,
    );
    expect(out).toEqual({ intervals: [], plannerEvents: [], calendars: [] });
    expect(fetchCalendarObjectsMock).not.toHaveBeenCalled();
  });
});

// ── parseReadCalendars (chunk 51) ────────────────────────────────────────────
describe('parseReadCalendars', () => {
  it('returns null for null / undefined / non-array input', () => {
    expect(parseReadCalendars(null)).toBeNull();
    expect(parseReadCalendars(undefined)).toBeNull();
    expect(parseReadCalendars('[]')).toBeNull();
    expect(parseReadCalendars({ url: HOME, name: 'Home', enabled: true })).toBeNull();
  });

  it('keeps well-formed entries and drops malformed ones', () => {
    expect(
      parseReadCalendars([
        { url: HOME, name: 'Home', enabled: true },
        { url: '', name: 'Empty url', enabled: true },
        { name: 'No url', enabled: true },
        { url: WORK, name: 'Work', enabled: 'yes' },
        { url: FAMILY, enabled: false },
        42,
        null,
      ]),
    ).toEqual([
      { url: HOME, name: 'Home', enabled: true },
      { url: FAMILY, name: '', enabled: false },
    ]);
  });

  it('dedupes by url, first occurrence wins', () => {
    expect(
      parseReadCalendars([
        { url: HOME, name: 'Home', enabled: true },
        { url: HOME, name: 'Home again', enabled: false },
      ]),
    ).toEqual([{ url: HOME, name: 'Home', enabled: true }]);
  });

  it('keeps a valid #rrggbb color (lower-cased) and drops anything else (chunk 51b)', () => {
    expect(
      parseReadCalendars([
        { url: HOME, name: 'Home', enabled: true, color: '#FF2968' },
        { url: WORK, name: 'Work', enabled: true, color: 'red' },
        { url: FAMILY, name: 'Family', enabled: true, color: '#ff2968ff' },
      ]),
    ).toEqual([
      { url: HOME, name: 'Home', enabled: true, color: '#ff2968' },
      { url: WORK, name: 'Work', enabled: true },
      { url: FAMILY, name: 'Family', enabled: true },
    ]);
  });

  it('an empty array is a valid (empty) read set, not null', () => {
    expect(parseReadCalendars([])).toEqual([]);
  });
});

// ── createEvent ──────────────────────────────────────────────────────────────
describe('createEvent', () => {
  it('POSTs a VEVENT and resolves on a 2xx response', async () => {
    createCalendarObjectMock.mockResolvedValue({ ok: true, status: 201 });

    await expect(
      createEvent('https://caldav.icloud.com/1/calendars/home/', 'me@icloud.com', 'pw', {
        title: 'Focus block',
        start: '2026-05-28T14:00:00Z',
        end: '2026-05-28T15:00:00Z',
        uid: 'uid-1',
      }),
    ).resolves.toBeUndefined();

    const arg = createCalendarObjectMock.mock.calls[0]?.[0] as {
      iCalString: string;
      filename: string;
    };
    expect(arg.iCalString).toContain('BEGIN:VEVENT');
    expect(arg.iCalString).toContain('UID:uid-1');
    expect(arg.iCalString).toContain('SUMMARY:Focus block');
    expect(arg.filename).toBe('uid-1.ics');
  });

  it('maps a 401 response to CalDavError(kind="auth")', async () => {
    createCalendarObjectMock.mockResolvedValue({ ok: false, status: 401 });
    await expect(
      createEvent('u', 'me@icloud.com', 'pw', {
        title: 'x',
        start: '2026-05-28T14:00:00Z',
        end: '2026-05-28T15:00:00Z',
        uid: 'u1',
      }),
    ).rejects.toMatchObject({ kind: 'auth' });
  });
});

// ── updateEvent / deleteEvent (chunk 39) ─────────────────────────────────────
describe('updateEvent', () => {
  it('PUTs a rebuilt VEVENT to <calendarUrl><uid>.ics with no If-Match', async () => {
    updateCalendarObjectMock.mockResolvedValue({ ok: true, status: 204 });

    await expect(
      updateEvent('https://caldav.icloud.com/1/calendars/home/', 'me@icloud.com', 'pw', {
        title: 'Draft brief',
        start: '2026-05-28T16:00:00Z',
        end: '2026-05-28T16:30:00Z',
        uid: 'hupo-block-abc',
      }),
    ).resolves.toBeUndefined();

    const arg = updateCalendarObjectMock.mock.calls[0]?.[0] as {
      calendarObject: { url: string; data: string; etag?: string };
      headers: Record<string, string>;
    };
    expect(arg.calendarObject.url).toBe(
      'https://caldav.icloud.com/1/calendars/home/hupo-block-abc.ics',
    );
    expect(arg.calendarObject.etag).toBeUndefined();
    expect(arg.headers).not.toHaveProperty('If-Match');
    expect(arg.calendarObject.data).toContain('UID:hupo-block-abc');
    expect(arg.calendarObject.data).toContain('SUMMARY:Draft brief');
    expect(arg.calendarObject.data).toContain('DTSTART:20260528T160000Z');
    expect(arg.calendarObject.data).toContain('DTEND:20260528T163000Z');
  });

  it('builds the object URL the way createCalendarObject resolves `filename`', async () => {
    createCalendarObjectMock.mockResolvedValue({ ok: true, status: 201 });
    updateCalendarObjectMock.mockResolvedValue({ ok: true, status: 204 });
    const calendarUrl = 'https://caldav.icloud.com/1/calendars/home/';
    const event = {
      title: 'x',
      start: '2026-05-28T16:00:00Z',
      end: '2026-05-28T16:30:00Z',
      uid: 'hupo-block-abc',
    };
    await createEvent(calendarUrl, 'me@icloud.com', 'pw', event);
    await updateEvent(calendarUrl, 'me@icloud.com', 'pw', event);
    const created = createCalendarObjectMock.mock.calls[0]?.[0] as {
      calendar: { url: string };
      filename: string;
    };
    const updated = updateCalendarObjectMock.mock.calls[0]?.[0] as {
      calendarObject: { url: string };
    };
    expect(updated.calendarObject.url).toBe(new URL(created.filename, created.calendar.url).href);
  });

  it('maps a non-2xx response through classifyError', async () => {
    updateCalendarObjectMock.mockResolvedValue({ ok: false, status: 401 });
    await expect(
      updateEvent('https://caldav.icloud.com/1/calendars/home/', 'me@icloud.com', 'pw', {
        title: 'x',
        start: '2026-05-28T16:00:00Z',
        end: '2026-05-28T16:30:00Z',
        uid: 'hupo-block-abc',
      }),
    ).rejects.toMatchObject({ kind: 'auth' });
  });
});

describe('deleteEvent', () => {
  it('DELETEs <calendarUrl><uid>.ics and resolves { missing: false } on 2xx', async () => {
    deleteCalendarObjectMock.mockResolvedValue({ ok: true, status: 204 });
    await expect(
      deleteEvent(
        'https://caldav.icloud.com/1/calendars/home/',
        'me@icloud.com',
        'pw',
        'hupo-block-abc',
      ),
    ).resolves.toEqual({ missing: false });
    const arg = deleteCalendarObjectMock.mock.calls[0]?.[0] as {
      calendarObject: { url: string; etag?: string };
    };
    expect(arg.calendarObject.url).toBe(
      'https://caldav.icloud.com/1/calendars/home/hupo-block-abc.ics',
    );
    expect(arg.calendarObject.etag).toBeUndefined();
  });

  it('treats an upstream 404 as already deleted ({ missing: true })', async () => {
    deleteCalendarObjectMock.mockResolvedValue({ ok: false, status: 404 });
    await expect(
      deleteEvent(
        'https://caldav.icloud.com/1/calendars/home/',
        'me@icloud.com',
        'pw',
        'hupo-block-abc',
      ),
    ).resolves.toEqual({ missing: true });
  });

  it('maps other failures through classifyError', async () => {
    const cal = 'https://caldav.icloud.com/1/calendars/home/';
    deleteCalendarObjectMock.mockResolvedValue({ ok: false, status: 500 });
    await expect(deleteEvent(cal, 'me@icloud.com', 'pw', 'hupo-block-abc')).rejects.toMatchObject({
      kind: 'other',
    });
    deleteCalendarObjectMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(deleteEvent(cal, 'me@icloud.com', 'pw', 'hupo-block-abc')).rejects.toMatchObject({
      kind: 'network',
    });
  });
});

describe('normalizeColor (chunk 51b)', () => {
  it('accepts #rrggbb and #rrggbbaa (alpha dropped), lower-cases, rejects the rest', () => {
    expect(normalizeColor('#FF2968FF')).toBe('#ff2968');
    expect(normalizeColor('#ff2968')).toBe('#ff2968');
    expect(normalizeColor(' #63DA38 ')).toBe('#63da38');
    expect(normalizeColor('#fff')).toBeUndefined();
    expect(normalizeColor('red')).toBeUndefined();
    expect(normalizeColor(undefined)).toBeUndefined();
    expect(normalizeColor(42)).toBeUndefined();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchIcsFeed, IcsError, parseIcsBusy } from '../api/_lib/ics';

// ── fixtures ─────────────────────────────────────────────────────────────────

const vcal = (...lines: string[]): string =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...lines, 'END:VCALENDAR'].join('\r\n');

const vevent = (...lines: string[]): string[] => [
  'BEGIN:VEVENT',
  'DTSTAMP:20260701T000000Z',
  ...lines,
  'END:VEVENT',
];

// Real Outlook-style VTIMEZONE (Windows tz name, DST rules).
const W_EUROPE_VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:W. Europe Standard Time',
  'BEGIN:STANDARD',
  'DTSTART:16010101T030000',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:16010101T020000',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
];

const WINDOW = { from: '2026-07-06T00:00:00Z', to: '2026-07-13T00:00:00Z' }; // Mon→Mon

// ── parseIcsBusy ─────────────────────────────────────────────────────────────

describe('parseIcsBusy', () => {
  it('includes a timed event inside the window with UTC times and title', () => {
    const raw = vcal(
      ...vevent(
        'UID:e1',
        'DTSTART:20260708T140000Z',
        'DTEND:20260708T150000Z',
        'SUMMARY:Design review',
      ),
    );
    expect(parseIcsBusy(raw, WINDOW.from, WINDOW.to)).toEqual([
      {
        start: '2026-07-08T14:00:00.000Z',
        end: '2026-07-08T15:00:00.000Z',
        title: 'Design review',
      },
    ]);
  });

  it('excludes events outside the window, includes straddlers', () => {
    const raw = vcal(
      ...vevent('UID:before', 'DTSTART:20260705T100000Z', 'DTEND:20260705T110000Z', 'SUMMARY:Out'),
      ...vevent(
        'UID:straddle',
        'DTSTART:20260705T230000Z',
        'DTEND:20260706T010000Z',
        'SUMMARY:Straddler',
      ),
    );
    const busy = parseIcsBusy(raw, WINDOW.from, WINDOW.to);
    expect(busy).toHaveLength(1);
    expect(busy[0]).toMatchObject({ title: 'Straddler', start: '2026-07-05T23:00:00.000Z' });
  });

  it('expands a weekly RRULE across a 7-day window (count and times)', () => {
    const raw = vcal(
      ...vevent(
        'UID:w1',
        'DTSTART:20260706T090000Z',
        'DTEND:20260706T093000Z',
        'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR',
        'SUMMARY:Standup',
      ),
    );
    const busy = parseIcsBusy(raw, WINDOW.from, WINDOW.to);
    expect(busy.map((b) => b.start)).toEqual([
      '2026-07-06T09:00:00.000Z',
      '2026-07-08T09:00:00.000Z',
      '2026-07-10T09:00:00.000Z',
    ]);
    expect(busy.every((b) => b.title === 'Standup')).toBe(true);
  });

  it('honors EXDATE exclusions', () => {
    const raw = vcal(
      ...vevent(
        'UID:x1',
        'DTSTART:20260706T090000Z',
        'DTEND:20260706T100000Z',
        'RRULE:FREQ=DAILY',
        'EXDATE:20260708T090000Z',
        'SUMMARY:Daily',
      ),
    );
    const starts = parseIcsBusy(raw, WINDOW.from, WINDOW.to).map((b) => b.start);
    expect(starts).toHaveLength(6); // 7 days − 1 exdate
    expect(starts).not.toContain('2026-07-08T09:00:00.000Z');
  });

  it('replaces the base instance with its RECURRENCE-ID override', () => {
    const raw = vcal(
      ...vevent(
        'UID:o1',
        'DTSTART:20260706T100000Z',
        'DTEND:20260706T110000Z',
        'RRULE:FREQ=WEEKLY;BYDAY=MO,WE',
        'SUMMARY:Sync',
      ),
      ...vevent(
        'UID:o1',
        'RECURRENCE-ID:20260708T100000Z',
        'DTSTART:20260708T110000Z',
        'DTEND:20260708T120000Z',
        'SUMMARY:Sync (moved)',
      ),
    );
    const busy = parseIcsBusy(raw, WINDOW.from, WINDOW.to);
    const starts = busy.map((b) => b.start);
    expect(starts).toContain('2026-07-08T11:00:00.000Z'); // override at the new time
    expect(starts).not.toContain('2026-07-08T10:00:00.000Z'); // base instance gone
    expect(busy.find((b) => b.start === '2026-07-08T11:00:00.000Z')?.title).toBe('Sync (moved)');
  });

  it('normalizes all-day events to UTC midnight boundaries', () => {
    const raw = vcal(
      ...vevent(
        'UID:a1',
        'DTSTART;VALUE=DATE:20260708',
        'DTEND;VALUE=DATE:20260709',
        'SUMMARY:Vacation',
      ),
    );
    expect(parseIcsBusy(raw, WINDOW.from, WINDOW.to)).toEqual([
      { start: '2026-07-08T00:00:00.000Z', end: '2026-07-09T00:00:00.000Z', title: 'Vacation' },
    ]);
  });

  it('converts TZID-qualified times to UTC correctly across a DST boundary', () => {
    // Europe DST starts Sun 2026-03-29: Mon 10:00 Berlin is 09:00Z before, 08:00Z after.
    const raw = vcal(
      ...W_EUROPE_VTIMEZONE,
      ...vevent(
        'UID:tz1',
        'DTSTART;TZID=W. Europe Standard Time:20260323T100000',
        'DTEND;TZID=W. Europe Standard Time:20260323T110000',
        'RRULE:FREQ=WEEKLY;BYDAY=MO',
        'SUMMARY:Berlin standup',
      ),
    );
    const busy = parseIcsBusy(raw, '2026-03-23T00:00:00Z', '2026-04-01T00:00:00Z');
    expect(busy.map((b) => [b.start, b.end])).toEqual([
      ['2026-03-23T09:00:00.000Z', '2026-03-23T10:00:00.000Z'],
      ['2026-03-30T08:00:00.000Z', '2026-03-30T09:00:00.000Z'],
    ]);
  });

  it('excludes cancelled and transparent events', () => {
    const raw = vcal(
      ...vevent(
        'UID:c1',
        'DTSTART:20260708T100000Z',
        'DTEND:20260708T110000Z',
        'STATUS:CANCELLED',
        'SUMMARY:Cancelled',
      ),
      ...vevent(
        'UID:t1',
        'DTSTART:20260708T120000Z',
        'DTEND:20260708T130000Z',
        'TRANSP:TRANSPARENT',
        'SUMMARY:Focus (free)',
      ),
      ...vevent('UID:k1', 'DTSTART:20260708T140000Z', 'DTEND:20260708T150000Z', 'SUMMARY:Kept'),
    );
    const busy = parseIcsBusy(raw, WINDOW.from, WINDOW.to);
    expect(busy).toHaveLength(1);
    expect(busy[0]?.title).toBe('Kept');
  });

  it('caps recurrence expansion at 1000 instances per event', () => {
    const raw = vcal(
      ...vevent(
        'UID:p1',
        'DTSTART:20260706T000000Z',
        'DTEND:20260706T000500Z',
        'RRULE:FREQ=MINUTELY',
        'SUMMARY:Pathological',
      ),
    );
    // 2-day window → 2881 raw instances → truncated to the cap.
    const busy = parseIcsBusy(raw, '2026-07-06T00:00:00Z', '2026-07-08T00:00:00Z');
    expect(busy).toHaveLength(1000);
  });

  it('returns intervals sorted by start across events', () => {
    const raw = vcal(
      ...vevent('UID:late', 'DTSTART:20260709T100000Z', 'DTEND:20260709T110000Z', 'SUMMARY:B'),
      ...vevent('UID:early', 'DTSTART:20260707T100000Z', 'DTEND:20260707T110000Z', 'SUMMARY:A'),
    );
    expect(parseIcsBusy(raw, WINDOW.from, WINDOW.to).map((b) => b.title)).toEqual(['A', 'B']);
  });
});

// ── fetchIcsFeed ─────────────────────────────────────────────────────────────

describe('fetchIcsFeed', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const stubFetch = (impl: (typeof globalThis)['fetch']): ReturnType<typeof vi.fn> => {
    const mock = vi.fn(impl);
    vi.stubGlobal('fetch', mock);
    return mock;
  };

  it.each([
    ['http://example.com/cal.ics', 'plain http'],
    ['https://192.168.1.10/cal.ics', 'RFC-1918 literal IP'],
    ['https://10.0.0.1/cal.ics', 'RFC-1918 literal IP'],
    ['https://169.254.169.254/latest/meta-data', 'link-local literal IP'],
    ['https://8.8.8.8/cal.ics', 'public literal IP'],
    ['https://2130706433/cal.ics', 'decimal-encoded IP'],
    ['https://[::1]/cal.ics', 'IPv6 literal'],
    ['https://localhost/cal.ics', 'localhost'],
    ['https://printer.local/cal.ics', '.local host'],
    ['not a url', 'unparseable'],
  ])('rejects %s (%s) with invalid_url before fetching', async (url) => {
    const mock = stubFetch(() => Promise.reject(new Error('should not fetch')));
    await expect(fetchIcsFeed(url)).rejects.toMatchObject({ kind: 'invalid_url' });
    expect(mock).not.toHaveBeenCalled();
  });

  it('returns raw body and X-WR-CALNAME feed name on success', async () => {
    const body = vcal('X-WR-CALNAME:Work Calendar');
    stubFetch(async () => new Response(body, { status: 200 }));
    await expect(
      fetchIcsFeed('https://outlook.office365.com/owa/calendar/x/calendar.ics'),
    ).resolves.toEqual({
      raw: body,
      feedName: 'Work Calendar',
    });
  });

  it('feedName is null when X-WR-CALNAME is absent', async () => {
    stubFetch(async () => new Response(vcal(), { status: 200 }));
    const { feedName } = await fetchIcsFeed('https://example.com/cal.ics');
    expect(feedName).toBeNull();
  });

  it('rejects a non-VCALENDAR body with invalid_feed', async () => {
    stubFetch(async () => new Response('<html>sign in</html>', { status: 200 }));
    await expect(fetchIcsFeed('https://example.com/cal.ics')).rejects.toMatchObject({
      kind: 'invalid_feed',
    });
  });

  it('maps non-2xx to unreachable', async () => {
    stubFetch(async () => new Response('nope', { status: 404 }));
    await expect(fetchIcsFeed('https://example.com/cal.ics')).rejects.toMatchObject({
      kind: 'unreachable',
    });
  });

  it('maps network failure to unreachable', async () => {
    stubFetch(() => Promise.reject(new TypeError('fetch failed')));
    await expect(fetchIcsFeed('https://example.com/cal.ics')).rejects.toMatchObject({
      kind: 'unreachable',
    });
  });

  it('times out after 10s with unreachable', async () => {
    vi.useFakeTimers();
    stubFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted', 'AbortError')),
          );
        }),
    );
    const pending = fetchIcsFeed('https://example.com/cal.ics');
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'unreachable' });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it('rejects an oversized response (content-length) with invalid_feed', async () => {
    stubFetch(
      async () =>
        new Response('x', { status: 200, headers: { 'content-length': String(3 * 1024 * 1024) } }),
    );
    await expect(fetchIcsFeed('https://example.com/cal.ics')).rejects.toMatchObject({
      kind: 'invalid_feed',
    });
  });

  it('refuses a redirect to a non-https target', async () => {
    stubFetch(
      async () =>
        new Response(null, { status: 302, headers: { location: 'http://example.com/cal.ics' } }),
    );
    await expect(fetchIcsFeed('https://example.com/cal.ics')).rejects.toMatchObject({
      kind: 'unreachable',
    });
  });

  it('follows an https redirect and validates the new target', async () => {
    const body = vcal();
    const mock = stubFetch(async (url) =>
      String(url).includes('moved')
        ? new Response(body, { status: 200 })
        : new Response(null, {
            status: 301,
            headers: { location: 'https://example.com/moved.ics' },
          }),
    );
    const { raw } = await fetchIcsFeed('https://example.com/cal.ics');
    expect(raw).toBe(body);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('IcsError carries its kind', () => {
    const err = new IcsError('invalid_url', 'nope');
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('invalid_url');
    expect(err.name).toBe('IcsError');
  });
});

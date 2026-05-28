import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createDAVClientMock,
  fetchCalendarObjectsMock,
  createCalendarObjectMock,
  getBasicAuthHeadersMock,
} = vi.hoisted(() => ({
  createDAVClientMock: vi.fn(),
  fetchCalendarObjectsMock: vi.fn(),
  createCalendarObjectMock: vi.fn(),
  getBasicAuthHeadersMock: vi.fn(() => ({ authorization: 'Basic xxx' })),
}));

vi.mock('../api/_lib/tsdav', () => ({
  createDAVClient: createDAVClientMock,
  fetchCalendarObjects: fetchCalendarObjectsMock,
  createCalendarObject: createCalendarObjectMock,
  getBasicAuthHeaders: getBasicAuthHeadersMock,
}));

import { CalDavError, classifyError, createEvent, discover, getBusy } from '../api/_lib/caldav';

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
  it('returns VEVENT-capable calendars as {url, name} and authenticates Basic against iCloud', async () => {
    createDAVClientMock.mockResolvedValue({
      fetchCalendars: vi.fn().mockResolvedValue([
        {
          url: 'https://caldav.icloud.com/1/calendars/home/',
          displayName: 'Home',
          components: ['VEVENT'],
        },
        {
          url: 'https://caldav.icloud.com/1/calendars/tasks/',
          displayName: 'Reminders',
          components: ['VTODO'],
        },
      ]),
    });

    const out = await discover('me@icloud.com', 'app-pw');

    expect(out.calendars).toEqual([
      { url: 'https://caldav.icloud.com/1/calendars/home/', name: 'Home' },
    ]);
    expect(createDAVClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl: 'https://caldav.icloud.com/',
        credentials: { username: 'me@icloud.com', password: 'app-pw' },
        authMethod: 'Basic',
        defaultAccountType: 'caldav',
      }),
    );
  });

  it('maps a 401 during login to CalDavError(kind="auth")', async () => {
    createDAVClientMock.mockRejectedValue(
      new Error('Invalid credentials: PROPFIND returned 401 Unauthorized'),
    );
    await expect(discover('me@icloud.com', 'bad')).rejects.toMatchObject({ kind: 'auth' });
  });
});

// ── getBusy ──────────────────────────────────────────────────────────────────
describe('getBusy', () => {
  it('parses VEVENT DTSTART/DTEND into busy intervals', async () => {
    fetchCalendarObjectsMock.mockResolvedValue([
      {
        url: 'https://caldav.icloud.com/1/calendars/home/evt.ics',
        data: 'BEGIN:VEVENT\r\nUID:abc\r\nDTSTART:20260528T140000Z\r\nDTEND:20260528T150000Z\r\nEND:VEVENT',
      },
    ]);

    const busy = await getBusy(
      'https://caldav.icloud.com/1/calendars/home/',
      'me@icloud.com',
      'app-pw',
      '2026-05-28T00:00:00Z',
      '2026-05-29T00:00:00Z',
    );

    expect(busy).toEqual([{ start: '2026-05-28T14:00:00.000Z', end: '2026-05-28T15:00:00.000Z' }]);
  });

  it('maps a 401 to CalDavError(kind="auth")', async () => {
    fetchCalendarObjectsMock.mockRejectedValue(
      new Error('Collection query failed: 401 Unauthorized'),
    );
    await expect(
      getBusy('u', 'me@icloud.com', 'pw', '2026-05-28T00:00:00Z', '2026-05-29T00:00:00Z'),
    ).rejects.toMatchObject({ kind: 'auth' });
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

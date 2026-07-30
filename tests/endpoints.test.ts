import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the lib layer; keep the real error/value classes via importOriginal so
// `instanceof` checks and pure helpers still work.
vi.mock('../api/_lib/auth', async (io) => ({
  ...(await io<typeof import('../api/_lib/auth')>()),
  requireUser: vi.fn(),
}));
vi.mock('../api/_lib/caldav', async (io) => ({
  ...(await io<typeof import('../api/_lib/caldav')>()),
  discover: vi.fn(),
  getBusy: vi.fn(),
  createEvent: vi.fn(),
}));
vi.mock('../api/_lib/supabase', async (io) => ({
  ...(await io<typeof import('../api/_lib/supabase')>()),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));
vi.mock('../api/_lib/crypto', () => ({ encrypt: vi.fn(), decrypt: vi.fn() }));
vi.mock('../api/_lib/ics', async (io) => ({
  ...(await io<typeof import('../api/_lib/ics')>()),
  fetchIcsFeed: vi.fn(),
  parseIcsBusy: vi.fn(),
}));

import { requireUser, UnauthorizedError } from '../api/_lib/auth';
import { CalDavError, createEvent, discover, getBusy } from '../api/_lib/caldav';
import { getSettings, updateSettings } from '../api/_lib/supabase';
import { decrypt, encrypt } from '../api/_lib/crypto';
import { fetchIcsFeed, IcsError, parseIcsBusy } from '../api/_lib/ics';

import health from '../api/health';
import testCredentials from '../api/calendar/test-credentials';
import saveCredentials from '../api/calendar/save-credentials';
import busy from '../api/calendar/busy';
import events from '../api/calendar/events';
import outlook from '../api/calendar/outlook';

const ORIGIN = 'https://user.github.io';
const SETTINGS = {
  caldav_apple_id: 'me@icloud.com',
  caldav_app_password_encrypted: '\\x6162', // bytea hex for "ab"
  caldav_calendar_url: 'https://caldav.icloud.com/1/calendars/home/',
  caldav_status: 'ok',
  outlook_ics_url_encrypted: null,
  outlook_feed_name: null,
  outlook_status: 'unconfigured',
  outlook_cached_busy: null,
  outlook_fetched_at: null,
};

// Both sources configured; cache holds one interval inside the test window.
const SETTINGS_BOTH = {
  ...SETTINGS,
  outlook_ics_url_encrypted: '\\x6f75', // bytea hex for "ou"
  outlook_feed_name: 'Work Calendar',
  outlook_status: 'ok',
  outlook_cached_busy: [
    { start: '2026-05-28T09:00:00.000Z', end: '2026-05-28T10:00:00.000Z', title: 'Cached' },
    { start: '2026-06-20T09:00:00.000Z', end: '2026-06-20T10:00:00.000Z', title: 'Outside' },
  ],
  outlook_fetched_at: '2026-05-27T08:00:00.000Z',
};

const SETTINGS_OUTLOOK_ONLY = {
  ...SETTINGS_BOTH,
  caldav_apple_id: null,
  caldav_app_password_encrypted: null,
  caldav_calendar_url: null,
  caldav_status: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ALLOWED_ORIGINS = `${ORIGIN},http://localhost:5173`;
  vi.mocked(requireUser).mockResolvedValue({ userId: 'user-1' });
});

function req(
  endpoint: { fetch: (r: Request) => Promise<Response> | Response },
  url: string,
  init: RequestInit = {},
): Promise<Response> | Response {
  return endpoint.fetch(
    new Request(url, {
      headers: { authorization: 'Bearer x', 'content-type': 'application/json', ...init.headers },
      ...init,
    }),
  );
}

const post = (
  endpoint: { fetch: (r: Request) => Promise<Response> | Response },
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
) => req(endpoint, url, { method: 'POST', body: JSON.stringify(body), headers });

describe('health', () => {
  it('returns { ok: true }', async () => {
    const res = await health.fetch(new Request('https://proxy/api/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('auth gate (shared)', () => {
  it('returns 401 when requireUser rejects', async () => {
    vi.mocked(requireUser).mockRejectedValue(new UnauthorizedError());
    const res = await post(testCredentials, 'https://proxy/api/calendar/test-credentials', {
      apple_id: 'me@icloud.com',
      app_password: 'pw',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false });
    expect(discover).not.toHaveBeenCalled();
  });
});

describe('CORS', () => {
  it('answers OPTIONS preflight with 204 and reflects an allowed origin', async () => {
    const res = await testCredentials.fetch(
      new Request('https://proxy/api/calendar/test-credentials', {
        method: 'OPTIONS',
        headers: { origin: ORIGIN },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it('never echoes a wildcard or a disallowed origin', async () => {
    const res = await testCredentials.fetch(
      new Request('https://proxy/api/calendar/test-credentials', {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example' },
      }),
    );
    const acao = res.headers.get('access-control-allow-origin');
    expect(acao).not.toBe('*');
    expect(acao).not.toBe('https://evil.example');
  });
});

describe('test-credentials', () => {
  it('returns the calendar list on success', async () => {
    vi.mocked(discover).mockResolvedValue({
      calendars: [{ url: 'https://cal/home/', name: 'Home' }],
    });
    const res = await post(testCredentials, 'https://proxy/api/calendar/test-credentials', {
      apple_id: 'me@icloud.com',
      app_password: 'pw',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      calendars: [{ url: 'https://cal/home/', name: 'Home' }],
    });
    expect(discover).toHaveBeenCalledWith('me@icloud.com', 'pw');
  });

  it('returns 401 { error: "auth" } on an iCloud auth failure (no settings write)', async () => {
    vi.mocked(discover).mockRejectedValue(new CalDavError('auth', '401 Unauthorized'));
    const res = await post(testCredentials, 'https://proxy/api/calendar/test-credentials', {
      apple_id: 'me@icloud.com',
      app_password: 'bad',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'auth' });
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('returns 400 on an invalid body', async () => {
    const res = await post(testCredentials, 'https://proxy/api/calendar/test-credentials', {
      apple_id: 'me@icloud.com',
    });
    expect(res.status).toBe(400);
    expect(discover).not.toHaveBeenCalled();
  });
});

describe('save-credentials', () => {
  it('encrypts the password and writes scoped settings with status ok', async () => {
    vi.mocked(encrypt).mockResolvedValue(Buffer.from([0x01, 0x02, 0x03]));
    const res = await post(saveCredentials, 'https://proxy/api/calendar/save-credentials', {
      apple_id: 'me@icloud.com',
      app_password: 'super-secret',
      calendar_url: 'https://cal/home/',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(encrypt).toHaveBeenCalledWith('super-secret');
    expect(updateSettings).toHaveBeenCalledWith('user-1', {
      caldav_apple_id: 'me@icloud.com',
      caldav_app_password_encrypted: '\\x010203',
      caldav_calendar_url: 'https://cal/home/',
      caldav_status: 'ok',
    });
  });

  it('returns 400 on an invalid body', async () => {
    const res = await post(saveCredentials, 'https://proxy/api/calendar/save-credentials', {
      apple_id: 'me@icloud.com',
      app_password: 'x',
    });
    expect(res.status).toBe(400);
    expect(updateSettings).not.toHaveBeenCalled();
  });
});

interface BusyBody {
  busy: Array<Record<string, unknown>>;
  sources: {
    icloud: { configured: boolean; ok: boolean };
    outlook: {
      configured: boolean;
      status: string;
      fetchedAt: string | null;
      feedName: string | null;
    };
  };
}
const busyBody = (res: Response): Promise<BusyBody> => res.json() as Promise<BusyBody>;

describe('busy', () => {
  const BUSY_URL =
    'https://proxy/api/calendar/busy?from=2026-05-28T00:00:00Z&to=2026-05-29T00:00:00Z';

  it('returns source-tagged intervals with titles (iCloud only)', async () => {
    vi.mocked(getSettings).mockResolvedValue(SETTINGS);
    vi.mocked(decrypt).mockResolvedValue('app-pw');
    vi.mocked(getBusy).mockResolvedValue([
      { start: '2026-05-28T14:00:00.000Z', end: '2026-05-28T15:00:00.000Z', title: 'Standup' },
    ]);

    const res = await req(busy, BUSY_URL);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      busy: [
        {
          start: '2026-05-28T14:00:00.000Z',
          end: '2026-05-28T15:00:00.000Z',
          title: 'Standup',
          source: 'icloud',
        },
      ],
      sources: {
        icloud: { configured: true, ok: true },
        outlook: { configured: false, status: 'unconfigured', fetchedAt: null, feedName: null },
      },
    });
    expect(getBusy).toHaveBeenCalledWith(
      SETTINGS.caldav_calendar_url,
      SETTINGS.caldav_apple_id,
      'app-pw',
      '2026-05-28T00:00:00Z',
      '2026-05-29T00:00:00Z',
    );
    expect(fetchIcsFeed).not.toHaveBeenCalled();
  });

  it('returns 412 only when NEITHER source is configured', async () => {
    vi.mocked(getSettings).mockResolvedValue(null);
    const res = await req(busy, BUSY_URL);
    expect(res.status).toBe(412);
    expect(getBusy).not.toHaveBeenCalled();
    expect(fetchIcsFeed).not.toHaveBeenCalled();
  });

  it('serves 200 from an Outlook-only config', async () => {
    vi.mocked(getSettings).mockResolvedValue(SETTINGS_OUTLOOK_ONLY);
    vi.mocked(decrypt).mockResolvedValue('https://feed.example/cal.ics');
    vi.mocked(fetchIcsFeed).mockResolvedValue({
      raw: 'BEGIN:VCALENDAR',
      feedName: 'Work Calendar',
    });
    vi.mocked(parseIcsBusy).mockReturnValue([
      { start: '2026-05-28T09:00:00.000Z', end: '2026-05-28T10:00:00.000Z', title: 'Outlook mtg' },
    ]);

    const res = await req(busy, BUSY_URL);
    expect(res.status).toBe(200);
    const body = await busyBody(res);
    expect(body.busy).toEqual([
      {
        start: '2026-05-28T09:00:00.000Z',
        end: '2026-05-28T10:00:00.000Z',
        title: 'Outlook mtg',
        source: 'outlook',
      },
    ]);
    expect(body.sources.icloud).toEqual({ configured: false, ok: false });
    expect(body.sources.outlook).toMatchObject({
      configured: true,
      status: 'ok',
      feedName: 'Work Calendar',
    });
    expect(getBusy).not.toHaveBeenCalled();
    // Successful fetch refreshes the cache.
    expect(updateSettings).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        outlook_status: 'ok',
        outlook_cached_busy: [
          {
            start: '2026-05-28T09:00:00.000Z',
            end: '2026-05-28T10:00:00.000Z',
            title: 'Outlook mtg',
          },
        ],
      }),
    );
  });

  it('merges both sources sorted by start with correct tags', async () => {
    vi.mocked(getSettings).mockResolvedValue(SETTINGS_BOTH);
    vi.mocked(decrypt)
      .mockResolvedValueOnce('app-pw') // iCloud password (decrypted first)
      .mockResolvedValueOnce('https://feed.example/cal.ics');
    vi.mocked(getBusy).mockResolvedValue([
      { start: '2026-05-28T14:00:00.000Z', end: '2026-05-28T15:00:00.000Z', title: 'Apple' },
    ]);
    vi.mocked(fetchIcsFeed).mockResolvedValue({
      raw: 'BEGIN:VCALENDAR',
      feedName: 'Work Calendar',
    });
    vi.mocked(parseIcsBusy).mockReturnValue([
      { start: '2026-05-28T09:00:00.000Z', end: '2026-05-28T10:00:00.000Z', title: 'Outlook' },
    ]);

    const res = await req(busy, BUSY_URL);
    const body = await busyBody(res);
    expect(body.busy).toEqual([
      {
        start: '2026-05-28T09:00:00.000Z',
        end: '2026-05-28T10:00:00.000Z',
        title: 'Outlook',
        source: 'outlook',
      },
      {
        start: '2026-05-28T14:00:00.000Z',
        end: '2026-05-28T15:00:00.000Z',
        title: 'Apple',
        source: 'icloud',
      },
    ]);
    expect(body.sources).toMatchObject({
      icloud: { configured: true, ok: true },
      outlook: { configured: true, status: 'ok' },
    });
  });

  it('serves the cached parse with status stale when the feed is unreachable', async () => {
    vi.mocked(getSettings).mockResolvedValue(SETTINGS_BOTH);
    vi.mocked(decrypt)
      .mockResolvedValueOnce('app-pw')
      .mockResolvedValueOnce('https://feed.example/cal.ics');
    vi.mocked(getBusy).mockResolvedValue([]);
    vi.mocked(fetchIcsFeed).mockRejectedValue(new IcsError('unreachable', 'HTTP 503'));

    const res = await req(busy, BUSY_URL);
    expect(res.status).toBe(200);
    const body = await busyBody(res);
    // Cache filtered to the window: the 06-20 interval is dropped.
    expect(body.busy).toEqual([
      {
        start: '2026-05-28T09:00:00.000Z',
        end: '2026-05-28T10:00:00.000Z',
        title: 'Cached',
        source: 'outlook',
      },
    ]);
    expect(body.sources.outlook).toEqual({
      configured: true,
      status: 'stale',
      fetchedAt: '2026-05-27T08:00:00.000Z',
      feedName: 'Work Calendar',
    });
    expect(updateSettings).toHaveBeenCalledWith('user-1', { outlook_status: 'unreachable' });
  });

  it('serves empty outlook intervals but still stale when unreachable with no cache', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      ...SETTINGS_OUTLOOK_ONLY,
      outlook_cached_busy: null,
    });
    vi.mocked(decrypt).mockResolvedValue('https://feed.example/cal.ics');
    vi.mocked(fetchIcsFeed).mockRejectedValue(new IcsError('unreachable', 'timeout'));

    const res = await req(busy, BUSY_URL);
    expect(res.status).toBe(200);
    const body = await busyBody(res);
    expect(body.busy).toEqual([]);
    expect(body.sources.outlook.status).toBe('stale');
  });

  it('iCloud auth failure with Outlook configured: 200, outlook intervals, side effect fires', async () => {
    vi.mocked(getSettings).mockResolvedValue(SETTINGS_BOTH);
    vi.mocked(decrypt)
      .mockResolvedValueOnce('app-pw')
      .mockResolvedValueOnce('https://feed.example/cal.ics');
    vi.mocked(getBusy).mockRejectedValue(new CalDavError('auth', '401 Unauthorized'));
    vi.mocked(fetchIcsFeed).mockResolvedValue({
      raw: 'BEGIN:VCALENDAR',
      feedName: 'Work Calendar',
    });
    vi.mocked(parseIcsBusy).mockReturnValue([
      { start: '2026-05-28T09:00:00.000Z', end: '2026-05-28T10:00:00.000Z', title: 'Outlook' },
    ]);

    const res = await req(busy, BUSY_URL);
    expect(res.status).toBe(200);
    const body = await busyBody(res);
    expect(body.busy).toEqual([
      {
        start: '2026-05-28T09:00:00.000Z',
        end: '2026-05-28T10:00:00.000Z',
        title: 'Outlook',
        source: 'outlook',
      },
    ]);
    expect(body.sources.icloud).toEqual({ configured: true, ok: false });
    // The auth side effect still fires even though the response is 200.
    expect(updateSettings).toHaveBeenCalledWith('user-1', { caldav_status: 'auth_failed' });
  });

  it('flips caldav_status to auth_failed and returns 401 on an iCloud auth failure (iCloud only)', async () => {
    vi.mocked(getSettings).mockResolvedValue(SETTINGS);
    vi.mocked(decrypt).mockResolvedValue('app-pw');
    vi.mocked(getBusy).mockRejectedValue(new CalDavError('auth', '401 Unauthorized'));

    const res = await req(busy, BUSY_URL);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'auth_failed' });
    expect(updateSettings).toHaveBeenCalledWith('user-1', { caldav_status: 'auth_failed' });
  });

  it('returns 400 when required query params are missing', async () => {
    vi.mocked(getSettings).mockResolvedValue(SETTINGS);
    const res = await req(busy, 'https://proxy/api/calendar/busy?from=2026-05-28T00:00:00Z');
    expect(res.status).toBe(400);
  });
});

describe('outlook', () => {
  const URL_ = 'https://proxy/api/calendar/outlook';
  const ICS_URL = 'https://outlook.office365.com/owa/calendar/abc/calendar.ics';

  it('verifies the feed, encrypts the URL, and persists config + cache', async () => {
    vi.mocked(fetchIcsFeed).mockResolvedValue({
      raw: 'BEGIN:VCALENDAR',
      feedName: 'Work Calendar',
    });
    vi.mocked(parseIcsBusy).mockReturnValue([
      { start: '2026-07-30T09:00:00.000Z', end: '2026-07-30T10:00:00.000Z', title: 'Mtg' },
    ]);
    vi.mocked(encrypt).mockResolvedValue(Buffer.from([0x0a, 0x0b]));

    const res = await post(outlook, URL_, { icsUrl: ICS_URL });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, feedName: 'Work Calendar', eventCount: 1 });
    expect(fetchIcsFeed).toHaveBeenCalledWith(ICS_URL);
    expect(encrypt).toHaveBeenCalledWith(ICS_URL);
    expect(updateSettings).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        outlook_ics_url_encrypted: '\\x0a0b',
        outlook_feed_name: 'Work Calendar',
        outlook_status: 'ok',
        outlook_cached_busy: [
          { start: '2026-07-30T09:00:00.000Z', end: '2026-07-30T10:00:00.000Z', title: 'Mtg' },
        ],
      }),
    );
  });

  it.each(['invalid_url', 'unreachable', 'invalid_feed'] as const)(
    'returns 422 %s and persists nothing on a failed verify',
    async (kind) => {
      vi.mocked(fetchIcsFeed).mockRejectedValue(new IcsError(kind, kind));
      const res = await post(outlook, URL_, { icsUrl: ICS_URL });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ ok: false, error: kind });
      expect(updateSettings).not.toHaveBeenCalled();
    },
  );

  it('clears all outlook columns on icsUrl: null', async () => {
    const res = await post(outlook, URL_, { icsUrl: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cleared: true });
    expect(updateSettings).toHaveBeenCalledWith('user-1', {
      outlook_ics_url_encrypted: null,
      outlook_feed_name: null,
      outlook_status: 'unconfigured',
      outlook_cached_busy: null,
      outlook_fetched_at: null,
    });
    expect(fetchIcsFeed).not.toHaveBeenCalled();
  });

  it('returns 400 on an invalid body', async () => {
    const res = await post(outlook, URL_, { icsUrl: 42 });
    expect(res.status).toBe(400);
    expect(updateSettings).not.toHaveBeenCalled();
  });
});

describe('events', () => {
  it('creates an event and returns its uid', async () => {
    vi.mocked(getSettings).mockResolvedValue(SETTINGS);
    vi.mocked(decrypt).mockResolvedValue('app-pw');
    vi.mocked(createEvent).mockResolvedValue(undefined);

    const res = await post(events, 'https://proxy/api/calendar/events', {
      title: 'Focus block',
      start: '2026-05-28T14:00:00Z',
      end: '2026-05-28T15:00:00Z',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; uid: string };
    expect(body.ok).toBe(true);
    expect(typeof body.uid).toBe('string');
    expect(body.uid.length).toBeGreaterThan(0);

    // createEvent is called with the same uid we return to the client.
    const callArgs = vi.mocked(createEvent).mock.calls[0];
    expect(callArgs?.[3]).toMatchObject({
      title: 'Focus block',
      uid: body.uid,
    });
  });

  it('flips caldav_status to auth_failed and returns 401 on an iCloud auth failure', async () => {
    vi.mocked(getSettings).mockResolvedValue(SETTINGS);
    vi.mocked(decrypt).mockResolvedValue('app-pw');
    vi.mocked(createEvent).mockRejectedValue(new CalDavError('auth', '401 Unauthorized'));

    const res = await post(events, 'https://proxy/api/calendar/events', {
      title: 'x',
      start: '2026-05-28T14:00:00Z',
      end: '2026-05-28T15:00:00Z',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'auth_failed' });
    expect(updateSettings).toHaveBeenCalledWith('user-1', { caldav_status: 'auth_failed' });
  });

  it('returns 412 when no credentials are stored', async () => {
    vi.mocked(getSettings).mockResolvedValue(null);
    const res = await post(events, 'https://proxy/api/calendar/events', {
      title: 'x',
      start: '2026-05-28T14:00:00Z',
      end: '2026-05-28T15:00:00Z',
    });
    expect(res.status).toBe(412);
    expect(createEvent).not.toHaveBeenCalled();
  });
});

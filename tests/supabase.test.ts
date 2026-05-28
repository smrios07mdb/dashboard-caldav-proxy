import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createClientMock } = vi.hoisted(() => ({ createClientMock: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: createClientMock }));

// A chainable query-builder stub. Every chain method returns the builder; the
// builder is itself awaitable (resolves to `result`) so both the read path
// (`.maybeSingle()`) and the write path (`await ...eq()`) work.
let result: { data?: unknown; error?: unknown };
let qb: Record<string, ReturnType<typeof vi.fn> | unknown>;
let fromMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  process.env.SUPABASE_URL = 'https://proj.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

  result = { data: null, error: null };
  qb = {};
  for (const m of ['select', 'update', 'insert', 'eq']) qb[m] = vi.fn(() => qb);
  qb.maybeSingle = vi.fn(() => Promise.resolve(result));
  qb.single = vi.fn(() => Promise.resolve(result));
  (qb as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve(result);

  fromMock = vi.fn(() => qb);
  createClientMock.mockReturnValue({ from: fromMock });
});

describe('getSettings', () => {
  it('scopes the read to the user_id and returns the row', async () => {
    result = {
      data: { caldav_status: 'ok', caldav_apple_id: 'me@icloud.com' },
      error: null,
    };
    const { getSettings } = await import('../api/_lib/supabase');

    const settings = await getSettings('user-A');

    expect(fromMock).toHaveBeenCalledWith('settings');
    expect(qb.eq).toHaveBeenCalledWith('user_id', 'user-A');
    expect(settings?.caldav_status).toBe('ok');
  });

  it('returns null when the user has no settings row', async () => {
    result = { data: null, error: null };
    const { getSettings } = await import('../api/_lib/supabase');
    expect(await getSettings('user-A')).toBeNull();
  });

  it('throws when supabase returns an error', async () => {
    result = { data: null, error: { message: 'db down' } };
    const { getSettings } = await import('../api/_lib/supabase');
    await expect(getSettings('user-A')).rejects.toThrow();
  });
});

describe('updateSettings', () => {
  it('scopes the write to the user_id', async () => {
    const { updateSettings } = await import('../api/_lib/supabase');
    await updateSettings('user-A', { caldav_status: 'ok' });

    expect(fromMock).toHaveBeenCalledWith('settings');
    expect(qb.update).toHaveBeenCalledWith({ caldav_status: 'ok' });
    expect(qb.eq).toHaveBeenCalledWith('user_id', 'user-A');
  });

  it('never lets a caller-supplied user_id leak into the write (resolution #6)', async () => {
    const { updateSettings } = await import('../api/_lib/supabase');
    await updateSettings('user-A', { user_id: 'attacker', caldav_status: 'ok' });

    expect(qb.update).toHaveBeenCalledWith({ caldav_status: 'ok' });
    expect(qb.eq).toHaveBeenCalledWith('user_id', 'user-A');
  });

  it('throws when supabase returns an error', async () => {
    result = { data: null, error: { message: 'write failed' } };
    const { updateSettings } = await import('../api/_lib/supabase');
    await expect(updateSettings('user-A', { caldav_status: 'ok' })).rejects.toThrow();
  });
});

describe('bytea transport helpers', () => {
  it('round-trips raw bytes through the Postgres bytea hex format', async () => {
    const { bufferToBytea, byteaToBuffer } = await import('../api/_lib/supabase');
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x10, 'I'.charCodeAt(0)]);

    const wire = bufferToBytea(bytes);
    expect(wire.startsWith('\\x')).toBe(true);
    expect(byteaToBuffer(wire).equals(bytes)).toBe(true);
  });
});

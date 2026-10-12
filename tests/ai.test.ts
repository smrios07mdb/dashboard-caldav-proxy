import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Same shape as endpoints.test.ts: mock the lib layer, keep the pure helpers.
vi.mock('../api/_lib/auth', async (io) => ({
  ...(await io<typeof import('../api/_lib/auth')>()),
  requireUser: vi.fn(),
}));
vi.mock('../api/_lib/supabase', async (io) => ({
  ...(await io<typeof import('../api/_lib/supabase')>()),
  getClient: vi.fn(),
  updateSettings: vi.fn(),
}));
vi.mock('../api/_lib/crypto', () => ({ encrypt: vi.fn(), decrypt: vi.fn() }));

import { requireUser, UnauthorizedError } from '../api/_lib/auth';
import { getClient, updateSettings } from '../api/_lib/supabase';
import { decrypt, encrypt } from '../api/_lib/crypto';
import {
  clearModelCache,
  HAIKU_FLOOR,
  MAX_TOKENS,
  resolveHaikuModel,
  SYSTEM_PROMPT,
} from '../api/_lib/ai';

import key from '../api/ai/key';
import triage from '../api/ai/triage';

const ORIGIN = 'https://user.github.io';
const KEY_URL = 'https://proxy/api/ai/key';
const TRIAGE_URL = 'https://proxy/api/ai/triage';

const TASK = {
  task_id: 't1',
  title: 'Write report',
  subcategory_name: 'Q3',
  category_name: 'Work',
  estimate_minutes: 30,
  due_at: '2026-10-13T17:00:00.000Z',
  priority: 1,
};
const TRIAGE_BODY = { tasks: [TASK], available_minutes: 60, timezone: 'America/New_York' };
const ANTHROPIC_JSON = {
  id: 'msg_1',
  type: 'message',
  content: [{ type: 'text', text: '{"recommendations":[]}' }],
};

const fetchMock = vi.fn();
// Column → value for the settings row; every select is recorded so the tests
// can assert which columns were read.
let row: Record<string, unknown> | null;
let selects: string[];

function anthropic(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status });
}

// Chunk 57: triage makes two kinds of Anthropic call. Route the stub by URL;
// each list is consumed in order and its last entry repeats.
type Reply = () => Response | Promise<Response>;
function routeFetch(models: Reply[], messages: Reply[]): void {
  let m = 0;
  let g = 0;
  fetchMock.mockImplementation(async (url: string) =>
    url.includes('/models')
      ? models[Math.min(m++, models.length - 1)]!()
      : messages[Math.min(g++, messages.length - 1)]!(),
  );
}
const model = (id: string, created_at: string, extra: Record<string, unknown> = {}) => ({
  type: 'model',
  id,
  line: 'haiku',
  lifecycle: 'active',
  created_at,
  ...extra,
});
const page =
  (data: Array<{ id: string }>, hasMore = false): Reply =>
  () =>
    anthropic(200, { data, has_more: hasMore, last_id: data.at(-1)?.id ?? null });
const reply =
  (status: number, body: unknown = {}): Reply =>
  () =>
    anthropic(status, body);
const ok = reply(200, ANTHROPIC_JSON);
const NOT_FOUND = reply(404, {
  type: 'error',
  error: { type: 'not_found_error', message: 'model: m-old' },
});
const callsTo = (part: string) => fetchMock.mock.calls.filter(([url]) => url.includes(part));
const sentModels = () => callsTo('/messages').map(([, init]) => JSON.parse(init.body).model);

const CONSOLE = ['log', 'info', 'warn', 'error', 'debug'] as const;
let logged: string[];

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ALLOWED_ORIGINS = `${ORIGIN},http://localhost:5173`;
  vi.mocked(requireUser).mockResolvedValue({ userId: 'user-1' });
  vi.mocked(encrypt).mockResolvedValue(Buffer.from([0x0a, 0x0b]));
  vi.mocked(decrypt).mockResolvedValue('sk-ant-stored');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  clearModelCache();
  logged = [];
  for (const method of CONSOLE) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  }
  row = { ai_api_key_encrypted: null };
  selects = [];
  vi.mocked(getClient).mockReturnValue({
    from: (table: string) => ({
      select: (column: string) => {
        selects.push(`${table}.${column}`);
        return {
          eq: (_col: string, _userId: string) => ({
            maybeSingle: async () => ({
              data: row === null ? null : { [column]: row[column] },
              error: null,
            }),
          }),
        };
      },
    }),
  } as unknown as ReturnType<typeof getClient>);
});

afterEach(() => {
  // Chunk 57 test 8: no log line, in any case in this file, carries a key.
  expect(logged.join('\n')).not.toMatch(/sk-ant/);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function send(
  endpoint: { fetch: (r: Request) => Promise<Response> | Response },
  url: string,
  method: string,
  body?: unknown,
): Promise<Response> | Response {
  return endpoint.fetch(
    new Request(url, {
      method,
      headers: { authorization: 'Bearer x', 'content-type': 'application/json', origin: ORIGIN },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

describe('POST /api/ai/key', () => {
  it('validates with Anthropic, then stores the encrypted key', async () => {
    fetchMock.mockResolvedValue(anthropic(200, { data: [] }));
    const res = await send(key, KEY_URL, 'POST', { api_key: '  sk-ant-new  ' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/models?limit=1');
    expect(init.method).toBeUndefined();
    expect(init.headers).toEqual({ 'x-api-key': 'sk-ant-new', 'anthropic-version': '2023-06-01' });

    expect(encrypt).toHaveBeenCalledWith('sk-ant-new');
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith('user-1', {
      ai_api_key_encrypted: '\\x0a0b',
      ai_status: 'ok',
    });
  });

  it.each([401, 403])('Anthropic %i → 422 bad_key, nothing stored', async (status) => {
    fetchMock.mockResolvedValue(anthropic(status));
    const res = await send(key, KEY_URL, 'POST', { api_key: 'sk-ant-bad' });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: 'bad_key' });
    expect(encrypt).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it.each([500, 529, 429])('Anthropic %i → 502 upstream, nothing stored', async (status) => {
    fetchMock.mockResolvedValue(anthropic(status));
    const res = await send(key, KEY_URL, 'POST', { api_key: 'sk-ant-x' });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'upstream' });
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('network failure → 502 upstream, nothing stored', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const res = await send(key, KEY_URL, 'POST', { api_key: 'sk-ant-x' });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'upstream' });
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', {}],
    ['empty', { api_key: '' }],
    ['whitespace only', { api_key: '   ' }],
    ['too long', { api_key: 'k'.repeat(513) }],
    ['non-string', { api_key: 42 }],
  ])('rejects a %s api_key with 400 before calling Anthropic', async (_name, body) => {
    const res = await send(key, KEY_URL, 'POST', body);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('never echoes the key in a response body', async () => {
    fetchMock.mockResolvedValue(anthropic(401));
    const res = await send(key, KEY_URL, 'POST', { api_key: 'sk-ant-secret' });
    expect(await res.text()).not.toContain('sk-ant-secret');
  });

  it('401 without a valid JWT; Anthropic is never called', async () => {
    vi.mocked(requireUser).mockRejectedValue(new UnauthorizedError());
    const res = await send(key, KEY_URL, 'POST', { api_key: 'sk-ant-x' });
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('405 on other methods', async () => {
    const res = await send(key, KEY_URL, 'GET');
    expect(res.status).toBe(405);
  });
});

describe('DELETE /api/ai/key', () => {
  it('clears the key column and resets the status', async () => {
    const res = await send(key, KEY_URL, 'DELETE');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(updateSettings).toHaveBeenCalledWith('user-1', {
      ai_api_key_encrypted: null,
      ai_status: 'unconfigured',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/ai/triage', () => {
  it('decrypts the stored key and returns Anthropic’s JSON unmodified', async () => {
    row = { ai_api_key_encrypted: '\\x6162' };
    routeFetch([page([model(HAIKU_FLOOR, '2026-09-01T00:00:00Z')])], [ok]);
    const res = await send(triage, TRIAGE_URL, 'POST', TRIAGE_BODY);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: ANTHROPIC_JSON });
    expect(decrypt).toHaveBeenCalledWith(Buffer.from('ab'));

    const [url, init] = callsTo('/messages')[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'x-api-key': 'sk-ant-stored',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    });
    expect(JSON.parse(init.body)).toEqual({
      model: HAIKU_FLOOR,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(TRIAGE_BODY) }],
    });
    expect(HAIKU_FLOOR).toBe('claude-haiku-5-5');
    expect(MAX_TOKENS).toBe(800);

    expect(selects).toEqual(['settings.ai_api_key_encrypted']);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('no stored key → 412 missing_key, Anthropic not called', async () => {
    const res = await send(triage, TRIAGE_URL, 'POST', TRIAGE_BODY);
    expect(res.status).toBe(412);
    expect(await res.json()).toMatchObject({ error: 'missing_key' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('no settings row → 412 missing_key', async () => {
    row = null;
    const res = await send(triage, TRIAGE_URL, 'POST', TRIAGE_BODY);
    expect(res.status).toBe(412);
  });

  it.each([401, 403])('Anthropic %i → ai_status auth_failed + 422 bad_key', async (status) => {
    row = { ai_api_key_encrypted: '\\x6162' };
    fetchMock.mockResolvedValue(anthropic(status));
    const res = await send(triage, TRIAGE_URL, 'POST', TRIAGE_BODY);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'bad_key' });
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith('user-1', { ai_status: 'auth_failed' });
  });

  it.each([400, 429, 500, 529])('Anthropic %i → 502 upstream, status untouched', async (status) => {
    row = { ai_api_key_encrypted: '\\x6162' };
    fetchMock.mockResolvedValue(anthropic(status));
    const res = await send(triage, TRIAGE_URL, 'POST', TRIAGE_BODY);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'upstream' });
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('network failure → 502 upstream', async () => {
    row = { ai_api_key_encrypted: '\\x6162' };
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const res = await send(triage, TRIAGE_URL, 'POST', TRIAGE_BODY);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'upstream' });
  });

  it('a non-JSON 2xx from Anthropic → 502 upstream', async () => {
    row = { ai_api_key_encrypted: '\\x6162' };
    fetchMock.mockResolvedValue(new Response('<html>', { status: 200 }));
    const res = await send(triage, TRIAGE_URL, 'POST', TRIAGE_BODY);
    expect(res.status).toBe(502);
  });

  it.each([
    ['no body', null],
    ['tasks not an array', { ...TRIAGE_BODY, tasks: 'x' }],
    ['301 tasks', { ...TRIAGE_BODY, tasks: Array.from({ length: 301 }, () => TASK) }],
    ['task missing a field', { ...TRIAGE_BODY, tasks: [{ ...TASK, title: undefined }] }],
    ['task with an extra field', { ...TRIAGE_BODY, tasks: [{ ...TASK, notes: 'x' }] }],
    ['camelCase task', { ...TRIAGE_BODY, tasks: [{ taskId: 't1' }] }],
    ['available_minutes 0', { ...TRIAGE_BODY, available_minutes: 0 }],
    ['available_minutes 1441', { ...TRIAGE_BODY, available_minutes: 1441 }],
    ['fractional available_minutes', { ...TRIAGE_BODY, available_minutes: 30.5 }],
    ['timezone over 64 chars', { ...TRIAGE_BODY, timezone: 'z'.repeat(65) }],
  ])('400 on %s, before any key read', async (_name, body) => {
    const res = await send(triage, TRIAGE_URL, 'POST', body);
    expect(res.status).toBe(400);
    expect(selects).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts 300 tasks and null due_at / priority', async () => {
    row = { ai_api_key_encrypted: '\\x6162' };
    routeFetch([page([])], [ok]);
    const tasks = Array.from({ length: 300 }, () => ({ ...TASK, due_at: null, priority: null }));
    const res = await send(triage, TRIAGE_URL, 'POST', { ...TRIAGE_BODY, tasks });
    expect(res.status).toBe(200);
  });

  it('never returns the key, on success or failure', async () => {
    row = { ai_api_key_encrypted: '\\x6162' };
    fetchMock.mockResolvedValue(anthropic(401));
    const res = await send(triage, TRIAGE_URL, 'POST', TRIAGE_BODY);
    expect(await res.text()).not.toContain('sk-ant-stored');
  });

  it('a decrypt failure is a 500 without internals', async () => {
    row = { ai_api_key_encrypted: '\\x6162' };
    vi.mocked(decrypt).mockRejectedValue(new Error('Unsupported state or unable to authenticate'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await send(triage, TRIAGE_URL, 'POST', TRIAGE_BODY);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'internal' });
    expect(fetchMock).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('401 without a valid JWT; 405 on GET', async () => {
    expect((await send(triage, TRIAGE_URL, 'GET')).status).toBe(405);
    vi.mocked(requireUser).mockRejectedValue(new UnauthorizedError());
    const res = await send(triage, TRIAGE_URL, 'POST', TRIAGE_BODY);
    expect(res.status).toBe(401);
    expect(selects).toEqual([]);
  });
});

describe('latest Haiku resolution (chunk 57)', () => {
  const MODELS_URL = 'https://api.anthropic.com/v1/models?limit=100';
  const run = () => send(triage, TRIAGE_URL, 'POST', TRIAGE_BODY);

  beforeEach(() => {
    row = { ai_api_key_encrypted: '\\x6162' };
  });

  it('picks the newest Haiku by created_at, not by response order', async () => {
    routeFetch(
      [page([model('m-old', '2025-10-01T00:00:00Z'), model('m-new', '2026-09-01T00:00:00Z')])],
      [ok],
    );
    expect((await run()).status).toBe(200);
    // Test 7: the id in the Messages body is the resolved one.
    expect(sentModels()).toEqual(['m-new']);
    const [url, init] = callsTo('/models')[0]!;
    expect(url).toBe(MODELS_URL);
    expect(init.headers).toEqual({
      'x-api-key': 'sk-ant-stored',
      'anthropic-version': '2023-06-01',
    });
    expect(logged).toEqual(['triage model=m-new source=resolved']);
  });

  it('ignores other lines, non-active Haikus and id text', async () => {
    routeFetch(
      [
        page([
          model('claude-haiku-9', '2027-03-01T00:00:00Z', { line: 'sonnet' }),
          model('claude-haiku-8', '2027-02-01T00:00:00Z', { line: null }),
          model('m-deprecated', '2027-01-01T00:00:00Z', { lifecycle: 'deprecated' }),
          model('m-retired', '2026-12-01T00:00:00Z', { lifecycle: 'retired' }),
          model('m-active', '2026-01-01T00:00:00Z'),
        ]),
      ],
      [ok],
    );
    await run();
    expect(sentModels()).toEqual(['m-active']);
  });

  it('follows pagination to a Haiku on page 2', async () => {
    routeFetch(
      [
        page([model('s-1', '2026-09-01T00:00:00Z', { line: 'sonnet' })], true),
        page([model('m-page2', '2026-01-01T00:00:00Z')]),
      ],
      [ok],
    );
    await run();
    expect(sentModels()).toEqual(['m-page2']);
    expect(callsTo('/models').map(([url]) => url)).toEqual([
      MODELS_URL,
      `${MODELS_URL}&after_id=s-1`,
    ]);
  });

  it('reads at most 3 pages', async () => {
    routeFetch([page([model('s-1', '2026-09-01T00:00:00Z', { line: 'opus' })], true)], [ok]);
    await run();
    expect(callsTo('/models')).toHaveLength(3);
    expect(sentModels()).toEqual([HAIKU_FLOOR]);
  });

  it.each<[string, Reply, string]>([
    ['Models 500', reply(500), 'models_500'],
    [
      'Models 529',
      reply(529, { error: { type: 'overloaded_error' } }),
      'models_529:overloaded_error',
    ],
    [
      'Models 400',
      reply(400, { error: { type: 'invalid_request_error', message: 'sk-ant-echo' } }),
      'models_400:invalid_request_error',
    ],
    ['Models 400 with an odd type', reply(400, { error: { type: 'x sk-ant-echo' } }), 'models_400'],
    ['a network reject', () => Promise.reject(new TypeError('fetch failed')), 'network'],
    ['a timeout', () => Promise.reject(new DOMException('timed out', 'TimeoutError')), 'timeout'],
    [
      'zero Haiku',
      page([model('s-1', '2026-09-01T00:00:00Z', { line: 'sonnet' })]),
      'no_haiku:seen=1,haiku=0',
    ],
    ['an empty list', page([]), 'no_haiku:seen=0,haiku=0'],
    [
      'only a deprecated Haiku',
      page([model('m-dep', '2026-09-01T00:00:00Z', { lifecycle: 'deprecated' })]),
      'no_haiku:seen=1,haiku=1',
    ],
    ['a malformed page', reply(200, { nope: true }), 'malformed'],
    ['a non-JSON page', () => new Response('<html>', { status: 200 }), 'malformed'],
  ])('falls back to the floor on %s', async (_name, models, reason) => {
    routeFetch([models], [ok]);
    expect((await run()).status).toBe(200);
    expect(sentModels()).toEqual([HAIKU_FLOOR]);
    expect(logged).toEqual([`triage model=${HAIKU_FLOOR} source=floor reason=${reason}`]);
  });

  it('caches the floor for 5 minutes, then asks again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    routeFetch([reply(500), page([model('m-new', '2026-09-01T00:00:00Z')])], [ok]);

    await run();
    vi.advanceTimersByTime(5 * 60_000 - 1);
    await run();
    expect(callsTo('/models')).toHaveLength(1);
    expect(sentModels()).toEqual([HAIKU_FLOOR, HAIKU_FLOOR]);

    vi.advanceTimersByTime(1);
    await run();
    expect(callsTo('/models')).toHaveLength(2);
    expect(sentModels()[2]).toBe('m-new');
    expect(logged).toEqual([
      `triage model=${HAIKU_FLOOR} source=floor reason=models_500`,
      `triage model=${HAIKU_FLOOR} source=cache`,
      'triage model=m-new source=resolved',
    ]);
  });

  it('caches a resolved model for 24 hours', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    routeFetch(
      [
        page([model('m-a', '2026-09-01T00:00:00Z')]),
        page([model('m-b', '2026-10-01T00:00:00Z'), model('m-a', '2026-09-01T00:00:00Z')]),
      ],
      [ok],
    );

    await run();
    vi.advanceTimersByTime(24 * 3_600_000 - 1);
    await run();
    expect(callsTo('/models')).toHaveLength(1);
    expect(sentModels()).toEqual(['m-a', 'm-a']);

    vi.advanceTimersByTime(1);
    await run();
    expect(callsTo('/models')).toHaveLength(2);
    expect(sentModels()[2]).toBe('m-b');
  });

  it('does not share a cache entry between keys', async () => {
    routeFetch(
      [page([model('m-a', '2026-09-01T00:00:00Z')]), page([model('m-b', '2026-10-01T00:00:00Z')])],
      [ok],
    );
    await run();
    vi.mocked(decrypt).mockResolvedValue('sk-ant-other');
    await run();
    expect(callsTo('/models').map(([, init]) => init.headers['x-api-key'])).toEqual([
      'sk-ant-stored',
      'sk-ant-other',
    ]);
    expect(sentModels()).toEqual(['m-a', 'm-b']);
    // Each key still has its own entry.
    expect(await resolveHaikuModel('sk-ant-stored')).toEqual({ model: 'm-a', source: 'cache' });
    expect(await resolveHaikuModel('sk-ant-other')).toEqual({ model: 'm-b', source: 'cache' });
  });

  it('a not_found_error 404 re-resolves and retries exactly once', async () => {
    routeFetch(
      [
        page([model('m-old', '2026-01-01T00:00:00Z')]),
        page([model('m-new', '2026-09-01T00:00:00Z')]),
      ],
      [ok, NOT_FOUND, ok],
    );
    await run(); // warms the cache with m-old
    const res = await run();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: ANTHROPIC_JSON });
    expect(callsTo('/models')).toHaveLength(2);
    expect(sentModels()).toEqual(['m-old', 'm-old', 'm-new']);
    expect(updateSettings).not.toHaveBeenCalled();
    expect(logged).toEqual([
      'triage model=m-old source=resolved',
      'triage model=m-new source=resolved',
    ]);
  });

  it('a second 404 is a 502, with no third attempt', async () => {
    routeFetch([page([model('m-old', '2026-01-01T00:00:00Z')])], [NOT_FOUND]);
    const res = await run();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'upstream' });
    expect(callsTo('/messages')).toHaveLength(2);
    expect(callsTo('/models')).toHaveLength(2);
  });

  it.each<[string, Reply]>([
    ['500', reply(500)],
    ['400', reply(400, { type: 'error', error: { type: 'invalid_request_error' } })],
    ['429', reply(429)],
    ['a 404 of another type', reply(404, { type: 'error', error: { type: 'other_error' } })],
    ['a 404 without a JSON body', () => new Response('<html>', { status: 404 })],
    ['401', reply(401)],
  ])('%s never retries or re-resolves', async (_name, messages) => {
    routeFetch([page([model('m-a', '2026-09-01T00:00:00Z')])], [messages]);
    const res = await run();
    expect(res.status).not.toBe(200);
    expect(callsTo('/messages')).toHaveLength(1);
    expect(callsTo('/models')).toHaveLength(1);
  });

  it('key validation still uses limit=1 and caches no model', async () => {
    routeFetch([page([model('m-a', '2026-09-01T00:00:00Z')])], [ok]);
    await send(key, KEY_URL, 'POST', { api_key: 'sk-ant-stored' });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.anthropic.com/v1/models?limit=1',
    ]);
    await run();
    expect(callsTo('limit=100')).toHaveLength(1);
  });
});

describe('dropped legacy key column (chunk 56)', () => {
  // Assembled so this file does not itself name the column.
  const LEGACY = ['ai', 'api', 'key'].join('_');
  const names = (value: string) => new RegExp(`${LEGACY}(?!_encrypted)`).test(value);

  it('no select or update on any /api/ai/* path names it', async () => {
    row = { ai_api_key_encrypted: '\\x6162' };
    fetchMock.mockImplementation(async () => anthropic(200, ANTHROPIC_JSON));
    await send(key, KEY_URL, 'POST', { api_key: 'sk-ant-new' });
    await send(triage, TRIAGE_URL, 'POST', TRIAGE_BODY);
    fetchMock.mockImplementation(async () => anthropic(401));
    await send(triage, TRIAGE_URL, 'POST', TRIAGE_BODY);
    await send(key, KEY_URL, 'DELETE');

    expect(selects).toEqual(['settings.ai_api_key_encrypted', 'settings.ai_api_key_encrypted']);
    const updated = vi.mocked(updateSettings).mock.calls.flatMap(([, patch]) => Object.keys(patch));
    expect(updated).toEqual([
      'ai_api_key_encrypted',
      'ai_status',
      'ai_status',
      'ai_api_key_encrypted',
      'ai_status',
    ]);
    expect([...selects, ...updated].filter(names)).toEqual([]);
  });

  it('no /api/ai/* source file names it', () => {
    const dir = join(process.cwd(), 'api');
    const files = [
      join(dir, '_lib', 'ai.ts'),
      ...readdirSync(join(dir, 'ai')).map((f) => join(dir, 'ai', f)),
    ];
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(files.filter((f) => names(readFileSync(f, 'utf8')))).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Chunk 90: `POST /api/ai/sort` — General sorting on demand through the saved
// Anthropic key. Same mock shape as ai.test.ts plus the router's data layer.
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
vi.mock('../api/_lib/router', async (io) => ({
  ...(await io<typeof import('../api/_lib/router')>()),
  loadSnapshot: vi.fn(),
  insertProposals: vi.fn(),
}));

import { requireUser, UnauthorizedError } from '../api/_lib/auth';
import { getClient, updateSettings } from '../api/_lib/supabase';
import { decrypt } from '../api/_lib/crypto';
import { clearModelCache, HAIKU_FLOOR } from '../api/_lib/ai';
import { insertProposals, loadSnapshot, type Snapshot } from '../api/_lib/router';
import {
  SORT_MAX_TOKENS,
  SORT_SYSTEM_PROMPT,
  SORT_TOOL,
  SORT_TOOL_NAME,
} from '../api/_lib/sortPrompt';
import sort from '../api/ai/sort';

const JWT_USER = '7d1f4a9e-1c2b-4d3e-8f00-aaaaaaaaaaaa';
const ROUTER_USER = '9b5ce57c-8b69-42b5-ba0c-d3e21b269f85';
const ORIGIN = 'https://user.github.io';
const URL_SORT = 'https://proxy/api/ai/sort';
const NOW = new Date('2026-10-21T12:00:00.000Z');
const OLD = '2026-10-21T11:00:00.000Z';
const FRESH = '2026-10-21T11:59:00.000Z'; // 1 min old: router path would skip it

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const WORK = id(1);
const PERSONAL = id(2);
const WORK_GENERAL = id(10);
const TAXES = id(12);
const TRIPS = id(13);

function task(n: number, created_at = OLD) {
  return {
    id: id(100 + n),
    title: `task ${n}`,
    subcategory_id: WORK_GENERAL,
    estimate_minutes: 15,
    due_at: null,
    priority: null,
    created_at,
  };
}

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    categories: [
      { id: WORK, name: 'Work' },
      { id: PERSONAL, name: 'Personal' },
    ],
    subcategories: [
      { id: WORK_GENERAL, name: 'General', category_id: WORK, sort_order: 0, archived_at: null },
      { id: TAXES, name: 'Taxes', category_id: WORK, sort_order: 1, archived_at: null },
      { id: TRIPS, name: 'Trips', category_id: PERSONAL, sort_order: 1, archived_at: null },
    ],
    generalTasks: [task(1), task(2), task(3), task(4)],
    decidedTaskIds: new Set(),
    recentTasks: [{ title: 'File 1099s', subcategory_id: TAXES }],
    ...over,
  };
}

const fetchMock = vi.fn();
let keyRow: Record<string, unknown> | null;
let logged: string[];

type Reply = () => Response;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
function routeFetch(models: Reply, messages: Reply[]): void {
  let g = 0;
  fetchMock.mockImplementation(async (url: string) =>
    url.includes('/models') ? models() : messages[Math.min(g++, messages.length - 1)]!(),
  );
}
const modelsPage =
  (...ids: string[]): Reply =>
  () =>
    json(200, {
      data: ids.map((mid, i) => ({
        id: mid,
        line: 'haiku',
        lifecycle: 'active',
        created_at: `2026-0${9 - i}-01T00:00:00Z`,
      })),
      has_more: false,
      last_id: null,
    });
const USAGE = { input_tokens: 1234, output_tokens: 321 };
const toolReply =
  (proposals: unknown, extra: Record<string, unknown> = {}): Reply =>
  () =>
    json(200, {
      id: 'msg_1',
      type: 'message',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu_1', name: SORT_TOOL_NAME, input: { proposals } }],
      usage: USAGE,
      ...extra,
    });
const keep = (n: number) => ({
  task_id: id(100 + n),
  subcategory_id: null,
  new_list: null,
  reason: 'r',
});
const to = (n: number, sub: string) => ({
  task_id: id(100 + n),
  subcategory_id: sub,
  new_list: null,
  reason: 'r',
});
const newList = (n: number, name: string, category = 'Work') => ({
  task_id: id(100 + n),
  subcategory_id: null,
  new_list: { name, category },
  reason: 'r',
});

const messagesCalls = () => fetchMock.mock.calls.filter(([url]) => url.includes('/messages'));
const sentBody = () => JSON.parse(messagesCalls()[0]![1].body);
const sentUser = () => JSON.parse(sentBody().messages[0].content);
const inserted = () => vi.mocked(insertProposals).mock.calls[0]?.[0] ?? [];

function send(method = 'POST', withAuth = true): Promise<Response> {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (withAuth) headers.authorization = 'Bearer jwt';
  return sort.fetch(new Request(URL_SORT, { method, headers }));
}

type SortJson = {
  ok: boolean;
  error?: string;
  run_id: string | null;
  proposed: number;
  kept: number;
  skipped: number;
  remaining: number;
  usage: { input_tokens: number; output_tokens: number } | null;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  process.env.ALLOWED_ORIGINS = ORIGIN;
  process.env.ROUTER_USER_ID = ROUTER_USER;
  vi.mocked(requireUser).mockResolvedValue({ userId: JWT_USER });
  vi.mocked(decrypt).mockResolvedValue('sk-ant-stored');
  vi.mocked(loadSnapshot).mockResolvedValue(snapshot());
  vi.mocked(insertProposals).mockResolvedValue();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  clearModelCache();
  keyRow = { ai_api_key_encrypted: '\\x6162' };
  logged = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  }
  vi.mocked(getClient).mockReturnValue({
    from: () => ({
      select: (column: string) => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: keyRow === null ? null : { [column]: keyRow[column] },
            error: null,
          }),
        }),
      }),
    }),
  } as unknown as ReturnType<typeof getClient>);
});

afterEach(() => {
  // No key material and no task content in any log line.
  expect(logged.join('\n')).not.toMatch(/sk-ant|task \d/);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('POST /api/ai/sort — auth and key (D1, D5)', () => {
  it('401 without a JWT; nothing is read or called', async () => {
    vi.mocked(requireUser).mockRejectedValue(new UnauthorizedError());
    const res = await send('POST', false);
    expect(res.status).toBe(401);
    expect(loadSnapshot).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('412 missing_key with no stored key; Anthropic not called', async () => {
    keyRow = { ai_api_key_encrypted: null };
    const res = await send();
    expect(res.status).toBe(412);
    expect(((await res.json()) as SortJson).error).toBe('missing_key');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Anthropic 401 → 422 bad_key and ai_status auth_failed; nothing inserted', async () => {
    routeFetch(() => json(401, {}), [() => json(401, {})]);
    const res = await send();
    expect(res.status).toBe(422);
    expect(((await res.json()) as SortJson).error).toBe('bad_key');
    expect(updateSettings).toHaveBeenCalledWith(JWT_USER, { ai_status: 'auth_failed' });
    expect(insertProposals).not.toHaveBeenCalled();
  });

  it('Anthropic 5xx → 502 upstream', async () => {
    routeFetch(modelsPage('m-new'), [() => json(529, {})]);
    const res = await send();
    expect(res.status).toBe(502);
    expect(((await res.json()) as SortJson).error).toBe('upstream');
  });

  it('an upstream failure logs the Anthropic status and error type, never the body', async () => {
    routeFetch(modelsPage('m-new'), [
      () =>
        json(400, {
          type: 'error',
          error: { type: 'invalid_request_error', message: 'secret task title here' },
        }),
    ]);
    const res = await send();
    expect(res.status).toBe(502);
    expect(logged).toContain('sort upstream status=400:invalid_request_error');
    expect(logged.join('\n')).not.toContain('secret task title');
  });

  it('a thrown Messages call (timeout) logs its error name', async () => {
    routeFetch(modelsPage('m-new'), [
      () => {
        throw new DOMException('timed out', 'TimeoutError');
      },
    ]);
    const res = await send();
    expect(res.status).toBe(502);
    expect(logged).toContain('sort upstream thrown=TimeoutError');
  });

  it('stop_reason max_tokens → 502 truncated (not malformed); logs no body', async () => {
    routeFetch(modelsPage('m-new'), [
      toolReply([{ ...keep(1), reason: 'secret task title here' }], { stop_reason: 'max_tokens' }),
    ]);
    const res = await send();
    expect(res.status).toBe(502);
    expect(((await res.json()) as SortJson).error).toBe('truncated');
    expect(insertProposals).not.toHaveBeenCalled();
    expect(logged).toContain('sort truncated status=200 stop_reason=max_tokens');
    expect(logged.join('\n')).not.toContain('secret task title');
  });

  it('acts on the JWT user, not ROUTER_USER_ID', async () => {
    routeFetch(modelsPage('m-new'), [toolReply([keep(1)])]);
    await send();
    expect(vi.mocked(loadSnapshot).mock.calls[0]?.[0]).toBe(JWT_USER);
    expect(inserted().every((r) => r.user_id === JWT_USER)).toBe(true);
  });

  it('405 on GET', async () => {
    expect((await send('GET')).status).toBe(405);
  });
});

describe('POST /api/ai/sort — candidates (D2, D4)', () => {
  it('no candidates → 200 proposed 0, no Anthropic call', async () => {
    vi.mocked(loadSnapshot).mockResolvedValue(snapshot({ generalTasks: [] }));
    const res = await send();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      proposed: 0,
      kept: 0,
      skipped: 0,
      remaining: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(insertProposals).not.toHaveBeenCalled();
  });

  it('the age filter is off on this path: a 1-minute-old task is sent and proposed', async () => {
    vi.mocked(loadSnapshot).mockResolvedValue(snapshot({ generalTasks: [task(1, FRESH)] }));
    routeFetch(modelsPage('m-new'), [toolReply([to(1, TAXES)])]);
    const res = await send();
    const body = (await res.json()) as SortJson;
    expect(sentUser().tasks.map((t: { task_id: string }) => t.task_id)).toEqual([id(101)]);
    expect(body.proposed).toBe(1);
    expect(inserted()[0]).toMatchObject({ task_id: id(101), to_subcategory_id: TAXES });
  });

  it('remaining is correct at 101 candidates: 100 oldest sent, 1 left', async () => {
    const many = Array.from({ length: 101 }, (_, i) =>
      task(i, new Date(Date.parse(OLD) - i * 1000).toISOString()),
    );
    vi.mocked(loadSnapshot).mockResolvedValue(snapshot({ generalTasks: many }));
    // The model keeps every task it was given.
    const sent = () => Array.from({ length: 100 }, (_, i) => keep(100 - i));
    routeFetch(modelsPage('m-new'), [toolReply(sent())]);
    const res = await send();
    const body = (await res.json()) as SortJson;
    const sentIds = sentUser().tasks.map((t: { task_id: string }) => t.task_id);
    expect(sentIds).toHaveLength(100);
    expect(sentIds[0]).toBe(id(200)); // oldest first
    expect(sentIds).not.toContain(id(100)); // the newest is left for the next press
    expect(body).toMatchObject({ proposed: 0, kept: 100, skipped: 0, remaining: 1 });
  });

  it('targets carry up to 8 example titles', async () => {
    const recent = Array.from({ length: 12 }, (_, i) => ({
      title: `ex ${i}`,
      subcategory_id: TAXES,
    }));
    vi.mocked(loadSnapshot).mockResolvedValue(snapshot({ recentTasks: recent }));
    routeFetch(modelsPage('m-new'), [toolReply([keep(1)])]);
    await send();
    const lists = sentUser().lists as { subcategory_id: string; examples: string[] }[];
    expect(lists.find((l) => l.subcategory_id === TAXES)?.examples).toHaveLength(8);
    expect(lists.map((l) => l.subcategory_id)).not.toContain(WORK_GENERAL);
  });
});

describe('POST /api/ai/sort — model call (D3)', () => {
  it('the model id comes from the resolver; one forced tool call, no sampling params (Haiku 5.5 400s on them)', async () => {
    routeFetch(modelsPage('m-newest', 'm-older'), [toolReply([keep(1)])]);
    const res = await send();
    expect(res.status).toBe(200);
    expect(messagesCalls()).toHaveLength(1);
    const b = sentBody();
    expect(b.model).toBe('m-newest');
    // Claude Haiku 5.5 rejects any non-default temperature/top_p/top_k with a 400.
    expect(b).not.toHaveProperty('temperature');
    expect(b).not.toHaveProperty('top_p');
    expect(b).not.toHaveProperty('top_k');
    // Chunk 90a: Haiku 5.5 thinks by default; off, as for triage (934dcbc).
    expect(b.thinking).toEqual({ type: 'disabled' });
    // ~77 output tokens per task × 100 candidates ≈ 7,700; 12,000 leaves headroom.
    expect(b.max_tokens).toBe(12000);
    expect(SORT_MAX_TOKENS).toBe(12000);
    expect(b.system).toBe(SORT_SYSTEM_PROMPT);
    expect(b.tools).toEqual([SORT_TOOL]);
    expect(b.tool_choice).toEqual({ type: 'tool', name: 'propose_sorting' });
    expect(messagesCalls()[0]![1].headers['x-api-key']).toBe('sk-ant-stored');
    expect(logged).toContain('sort model=m-newest source=resolved');
  });

  it('falls back to the Haiku floor when the resolver cannot list models', async () => {
    routeFetch(() => json(500, {}), [toolReply([keep(1)])]);
    await send();
    expect(sentBody().model).toBe(HAIKU_FLOOR);
  });

  it('the system prompt carries the chunk-90a rules', () => {
    for (const rule of [
      /empty the General lists/i,
      /Work or Personal/,
      /ignoring which General list/i,
      /MDB Capital/,
      /at least 2 tasks/i,
      /3 words/i,
      /Title Case/,
      /same exact spelling/i,
      /120/,
      /never invent/i,
    ]) {
      expect(SORT_SYSTEM_PROMPT).toMatch(rule);
    }
    // Superseded: chunk 90 D3's keep-when-unsure rule and chunk 89 D3's cap of 3.
    expect(SORT_SYSTEM_PROMPT).not.toMatch(/unsure[^.]*keep/i);
    expect(SORT_SYSTEM_PROMPT).not.toMatch(/at most 3 new lists/i);
    expect(SORT_SYSTEM_PROMPT).not.toMatch(/sparingly/i);
  });

  it('Work/Personal is step 1, before choosing a list', () => {
    const p = SORT_SYSTEM_PROMPT;
    expect(p.indexOf('Step 1')).toBeGreaterThan(-1);
    expect(p.indexOf('Step 1')).toBeLessThan(p.indexOf('Step 2'));
    expect(p.slice(p.indexOf('Step 1'), p.indexOf('Step 2'))).toMatch(/Work or Personal/);
  });
});

describe('POST /api/ai/sort — validating model output (D3, D5)', () => {
  it('hallucinated or unsent ids are dropped as not_candidate / bad_target', async () => {
    routeFetch(modelsPage('m-new'), [
      toolReply([
        to(1, TAXES),
        { ...keep(9), task_id: id(999) }, // unknown task
        { ...keep(9), task_id: 'task-2' }, // not even a uuid
        to(3, id(777)), // unknown list
        to(4, WORK_GENERAL), // General is never a target
      ]),
    ]);
    const res = await send();
    const body = (await res.json()) as SortJson;
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ proposed: 1, kept: 0, skipped: 4 });
    expect(inserted().map((r) => r.task_id)).toEqual([id(101)]);
  });

  it('a duplicate task id or a malformed entry is skipped, the rest apply', async () => {
    routeFetch(modelsPage('m-new'), [
      toolReply([to(1, TAXES), to(1, TRIPS), { task_id: id(102) }, keep(3)]),
    ]);
    const body = (await (await send()).json()) as SortJson;
    expect(body).toMatchObject({ proposed: 1, kept: 1, skipped: 2 });
    expect(inserted().find((r) => r.task_id === id(101))?.to_subcategory_id).toBe(TAXES);
  });

  it('a new list needs 2 tasks; at most 8 new lists (chunk 90a); overflow is kept', async () => {
    const tasks = Array.from({ length: 19 }, (_, i) => task(i + 1));
    vi.mocked(loadSnapshot).mockResolvedValue(snapshot({ generalTasks: tasks }));
    const groups = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
    routeFetch(modelsPage('m-new'), [
      toolReply([
        newList(1, 'Solo'),
        ...groups.flatMap((g, i) => [newList(2 * i + 2, g), newList(2 * i + 3, g)]),
      ]),
    ]);
    const body = (await (await send()).json()) as SortJson;
    const names = new Set(
      inserted()
        .filter((r) => r.new_list_name)
        .map((r) => r.new_list_name),
    );
    expect(names).toEqual(new Set(groups.slice(0, 8)));
    // Solo (min 2) and the 9th group (cap) fall back to keep.
    expect(body).toMatchObject({ proposed: 16, kept: 3, skipped: 0 });
  });

  it('a new-list name matching an existing list becomes that list', async () => {
    routeFetch(modelsPage('m-new'), [toolReply([newList(1, 'taxes'), newList(2, 'TAXES')])]);
    await send();
    expect(inserted().map((r) => r.to_subcategory_id)).toEqual([TAXES, TAXES]);
  });

  it('one run id and pending status on every row, returned with usage', async () => {
    routeFetch(modelsPage('m-new'), [
      toolReply([to(1, TAXES), newList(2, 'Hiring'), newList(3, 'hiring'), keep(4)]),
    ]);
    const body = (await (await send()).json()) as SortJson;
    const rows = inserted();
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.run_id))).toEqual(new Set([body.run_id]));
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
    expect(body).toMatchObject({
      ok: true,
      proposed: 3,
      kept: 1,
      skipped: 0,
      remaining: 0,
      usage: USAGE,
    });
  });

  it('a tasks the model left out stays a candidate and counts as remaining', async () => {
    routeFetch(modelsPage('m-new'), [toolReply([keep(1), keep(2)])]);
    const body = (await (await send()).json()) as SortJson;
    expect(body.remaining).toBe(2);
  });

  it.each([
    ['no tool call (text only)', { content: [{ type: 'text', text: '{}' }], usage: USAGE }],
    [
      'a different tool',
      { content: [{ type: 'tool_use', id: 't', name: 'other', input: { proposals: [] } }] },
    ],
    [
      'proposals is not an array',
      { content: [{ type: 'tool_use', id: 't', name: SORT_TOOL_NAME, input: { proposals: 'x' } }] },
    ],
    ['no content', {}],
  ])('%s → 502 malformed, nothing inserted', async (_label, reply) => {
    routeFetch(modelsPage('m-new'), [() => json(200, reply)]);
    const res = await send();
    expect(res.status).toBe(502);
    expect(((await res.json()) as SortJson).error).toBe('malformed');
    expect(insertProposals).not.toHaveBeenCalled();
  });
});

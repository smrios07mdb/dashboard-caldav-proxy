import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/_lib/router', async (io) => ({
  ...(await io<typeof import('../api/_lib/router')>()),
  loadSnapshot: vi.fn(),
  insertProposals: vi.fn(),
}));

import {
  buildInbox,
  insertProposals,
  loadSnapshot,
  planProposals,
  ProposeBody,
  type Snapshot,
} from '../api/_lib/router';
import inbox from '../api/route/inbox';
import propose from '../api/route/propose';

const USER = '9b5ce57c-8b69-42b5-ba0c-d3e21b269f85';
const TOKEN = 'test-router-token-0123456789';
const NOW = new Date('2026-10-21T12:00:00.000Z');
const OLD = '2026-10-21T11:00:00.000Z'; // 1 h before NOW
const FRESH = '2026-10-21T11:55:00.000Z'; // 5 min before NOW
// Chunk 90: the router path keeps the 10-minute age filter.
const SCOPE = { userId: USER, minAgeMinutes: 10 };

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const WORK = id(1);
const PERSONAL = id(2);
const WORK_GENERAL = id(10);
const PERSONAL_GENERAL = id(11);
const TAXES = id(12); // Work
const TRIPS = id(13); // Personal
const ARCHIVED = id(14); // Work, archived

function task(n: number, sub = WORK_GENERAL, created_at = OLD) {
  return {
    id: id(100 + n),
    title: `task ${n}`,
    subcategory_id: sub,
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
      {
        id: PERSONAL_GENERAL,
        name: ' general ',
        category_id: PERSONAL,
        sort_order: 0,
        archived_at: null,
      },
      { id: TAXES, name: 'Taxes', category_id: WORK, sort_order: 1, archived_at: null },
      { id: TRIPS, name: 'Trips', category_id: PERSONAL, sort_order: 1, archived_at: null },
      {
        id: ARCHIVED,
        name: 'Old',
        category_id: WORK,
        sort_order: 2,
        archived_at: '2026-01-01T00:00:00Z',
      },
    ],
    generalTasks: [task(1), task(2), task(3), task(4), task(5, PERSONAL_GENERAL)],
    decidedTaskIds: new Set(),
    recentTasks: [
      ...Array.from({ length: 10 }, (_, i) => ({ title: `tax ${i}`, subcategory_id: TAXES })),
      { title: 'Lisbon', subcategory_id: TRIPS },
    ],
    ...over,
  };
}

const body = (proposals: unknown[]) => ProposeBody.parse({ proposals });
const keep = (n: number) => ({
  task_id: id(100 + n),
  subcategory_id: null,
  new_list: null,
  reason: 'r',
});
const to = (n: number, sub: string) => ({ task_id: id(100 + n), subcategory_id: sub, reason: 'r' });
const newList = (n: number, name: string, category: 'Work' | 'Personal' = 'Work') => ({
  task_id: id(100 + n),
  new_list: { name, category },
  reason: 'r',
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  process.env.ROUTER_TOKEN = TOKEN;
  process.env.ROUTER_USER_ID = USER;
  vi.mocked(loadSnapshot).mockResolvedValue(snapshot());
  vi.mocked(insertProposals).mockResolvedValue();
});
afterEach(() => {
  vi.useRealTimers();
});

function req(method: string, path: string, opts: { token?: string | null; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = opts.token === undefined ? TOKEN : opts.token;
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return new Request(`https://proxy.test${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

describe('router auth (D9)', () => {
  it('401 without a token, and with a wrong one', async () => {
    expect((await inbox.fetch(req('GET', '/api/route/inbox', { token: null }))).status).toBe(401);
    expect((await inbox.fetch(req('GET', '/api/route/inbox', { token: 'nope' }))).status).toBe(401);
    const res = await propose.fetch(
      req('POST', '/api/route/propose', { token: 'nope', body: { proposals: [keep(1)] } }),
    );
    expect(res.status).toBe(401);
    expect(loadSnapshot).not.toHaveBeenCalled();
  });

  it('503 when the env is unset', async () => {
    delete process.env.ROUTER_TOKEN;
    expect((await inbox.fetch(req('GET', '/api/route/inbox'))).status).toBe(503);
    process.env.ROUTER_TOKEN = TOKEN;
    delete process.env.ROUTER_USER_ID;
    expect((await inbox.fetch(req('GET', '/api/route/inbox'))).status).toBe(503);
  });

  it('acts only on ROUTER_USER_ID', async () => {
    const res = await inbox.fetch(req('GET', '/api/route/inbox'));
    expect(res.status).toBe(200);
    expect(vi.mocked(loadSnapshot).mock.calls[0]?.[0]).toBe(USER);
  });
});

describe('inbox (D1, D2)', () => {
  it('lists only candidates ≥10 min old with no pending/approved/kept proposal', () => {
    const snap = snapshot({
      generalTasks: [task(1), task(2), task(3), task(4, WORK_GENERAL, FRESH), task(6)],
      decidedTaskIds: new Set([id(102), id(103)]), // e.g. one pending, one approved
    });
    const out = buildInbox(snap, NOW, SCOPE);
    expect(out.tasks.map((t) => t.task_id)).toEqual([id(101), id(106)]);
  });

  it('a task whose only proposal went stale is listed again', () => {
    // Stale rows are not loaded into decidedTaskIds (status filter).
    const out = buildInbox(snapshot({ decidedTaskIds: new Set() }), NOW, SCOPE);
    expect(out.tasks.map((t) => t.task_id)).toContain(id(101));
  });

  it('lists tasks from both categories, oldest first, capped at 100', () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      task(
        i,
        i % 2 ? PERSONAL_GENERAL : WORK_GENERAL,
        new Date(Date.parse(OLD) - i * 1000).toISOString(),
      ),
    );
    const out = buildInbox(snapshot({ generalTasks: many }), NOW, SCOPE);
    expect(out.tasks).toHaveLength(100);
    expect(out.tasks[0]?.task_id).toBe(id(219));
    expect(new Set(out.tasks.map((t) => t.category_name))).toEqual(new Set(['Work', 'Personal']));
  });

  it('targets are live non-General lists of either category, with ≤8 examples', () => {
    const out = buildInbox(snapshot(), NOW, SCOPE);
    expect(out.targets.map((t) => t.subcategory_id)).toEqual([TRIPS, TAXES]);
    expect(out.targets.find((t) => t.subcategory_id === TAXES)?.examples).toHaveLength(8);
    expect(out.targets.find((t) => t.subcategory_id === TRIPS)?.category_name).toBe('Personal');
    expect(out.categories).toHaveLength(2);
  });

  it('endpoint returns 200 with the inbox', async () => {
    const res = await inbox.fetch(req('GET', '/api/route/inbox'));
    const json = (await res.json()) as { ok: boolean; tasks: unknown[] };
    expect(json.ok).toBe(true);
    expect(json.tasks).toHaveLength(5);
  });
});

describe('propose (D3, D4, D5)', () => {
  it('a Work task may go to a Personal list (cross-category)', () => {
    const { rows, results } = planProposals(snapshot(), body([to(1, TRIPS)]), SCOPE, NOW, 'run');
    expect(results).toEqual([{ task_id: id(101), status: 'proposed' }]);
    expect(rows[0]).toMatchObject({
      task_id: id(101),
      from_subcategory_id: WORK_GENERAL,
      to_subcategory_id: TRIPS,
      status: 'pending',
      run_id: 'run',
      user_id: USER,
    });
  });

  it('a General or archived target is rejected', () => {
    const { rows, results } = planProposals(
      snapshot(),
      body([to(1, PERSONAL_GENERAL), to(2, ARCHIVED), to(3, id(999))]),
      SCOPE,
      NOW,
    );
    expect(results.map((r) => r.detail)).toEqual(['bad_target', 'bad_target', 'bad_target']);
    expect(rows).toHaveLength(0);
  });

  it('non-candidates are skipped (too new, decided, unknown)', () => {
    const snap = snapshot({
      generalTasks: [task(1, WORK_GENERAL, FRESH), task(2)],
      decidedTaskIds: new Set([id(102)]),
    });
    const { rows, results } = planProposals(snap, body([keep(1), keep(2), keep(7)]), SCOPE, NOW);
    expect(results.every((r) => r.status === 'skipped' && r.detail === 'not_candidate')).toBe(true);
    expect(rows).toHaveLength(0);
  });

  it('keep writes both destinations null', () => {
    const { rows } = planProposals(snapshot(), body([keep(1)]), SCOPE, NOW);
    expect(rows[0]).toMatchObject({
      to_subcategory_id: null,
      new_list_name: null,
      new_list_category_id: null,
    });
  });

  it('a new list backed by one task falls back to keep', () => {
    const { rows, results } = planProposals(snapshot(), body([newList(1, 'Solo')]), SCOPE, NOW);
    expect(results[0]).toEqual({
      task_id: id(101),
      status: 'kept_fallback',
      detail: 'new_list_min',
    });
    expect(rows[0]).toMatchObject({ to_subcategory_id: null, new_list_name: null });
  });

  it('names merge trimmed and case-insensitively; first spelling wins', () => {
    const { rows, results } = planProposals(
      snapshot(),
      body([newList(1, '  Hiring '), newList(2, 'hiring')]),
      SCOPE,
      NOW,
      'run',
    );
    expect(results.map((r) => r.status)).toEqual(['proposed', 'proposed']);
    expect(rows.map((r) => [r.new_list_name, r.new_list_category_id])).toEqual([
      ['Hiring', WORK],
      ['Hiring', WORK],
    ]);
  });

  it('the same name in two categories is two lists', () => {
    const { results } = planProposals(
      snapshot(),
      body([newList(1, 'Admin'), newList(2, 'Admin', 'Personal')]),
      SCOPE,
      NOW,
    );
    expect(results.map((r) => r.detail)).toEqual(['new_list_min', 'new_list_min']);
  });

  it('a name matching an existing list in that category becomes that list', () => {
    const { rows, results } = planProposals(snapshot(), body([newList(1, 'taxes')]), SCOPE, NOW);
    expect(results[0]).toEqual({ task_id: id(101), status: 'proposed', detail: 'existing_list' });
    expect(rows[0]).toMatchObject({ to_subcategory_id: TAXES, new_list_name: null });
  });

  it('a new list named General falls back to keep', () => {
    const { results } = planProposals(
      snapshot(),
      body([newList(1, 'General'), newList(2, 'general')]),
      SCOPE,
      NOW,
    );
    expect(results.map((r) => r.status)).toEqual(['kept_fallback', 'kept_fallback']);
  });

  it('at most 3 new lists per run: the largest win, ties by first appearance', () => {
    const tasks = Array.from({ length: 10 }, (_, i) => task(i + 1));
    const snap = snapshot({ generalTasks: tasks });
    const { rows, results } = planProposals(
      snap,
      body([
        newList(1, 'A'),
        newList(2, 'A'),
        newList(3, 'B'),
        newList(4, 'B'),
        newList(5, 'C'),
        newList(6, 'C'),
        newList(7, 'D'),
        newList(8, 'D'),
        newList(9, 'D'),
      ]),
      SCOPE,
      NOW,
    );
    expect(new Set(rows.filter((r) => r.new_list_name).map((r) => r.new_list_name))).toEqual(
      new Set(['D', 'A', 'B']),
    );
    expect(results.slice(4, 6).map((r) => r.detail)).toEqual(['new_list_max', 'new_list_max']);
    expect(rows).toHaveLength(9);
  });

  it('one run id and pending status on every row; endpoint inserts them', async () => {
    const res = await propose.fetch(
      req('POST', '/api/route/propose', {
        body: { proposals: [to(1, TAXES), newList(2, 'New'), newList(3, 'new'), keep(4)] },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { run_id: string; results: { status: string }[] };
    const rows = vi.mocked(insertProposals).mock.calls[0]?.[0] ?? [];
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.run_id))).toEqual(new Set([json.run_id]));
    expect(rows.every((r) => r.status === 'pending' && r.user_id === USER)).toBe(true);
    expect(json.results.map((r) => r.status)).toEqual([
      'proposed',
      'proposed',
      'proposed',
      'proposed',
    ]);
  });

  it('400 on a bad body: duplicate task, both destinations, unknown keys, >100', async () => {
    const bad = [
      { proposals: [keep(1), keep(1)] },
      { proposals: [{ ...to(1, TAXES), new_list: { name: 'X', category: 'Work' } }] },
      { proposals: [{ ...keep(1), extra: 1 }] },
      { proposals: [] },
      { proposals: Array.from({ length: 101 }, (_, i) => keep(i)) },
      { proposals: [{ ...keep(1), reason: 'x'.repeat(281) }] },
      { proposals: [newList(1, 'x'.repeat(41))] },
    ];
    for (const b of bad) {
      const res = await propose.fetch(req('POST', '/api/route/propose', { body: b }));
      expect(res.status).toBe(400);
    }
    expect(insertProposals).not.toHaveBeenCalled();
  });
});

describe('age filter by path (chunk 90 D2)', () => {
  it('on (10 min) on the router path, off at minAgeMinutes 0', async () => {
    const snap = snapshot({ generalTasks: [task(1), task(2, WORK_GENERAL, FRESH)] });
    vi.mocked(loadSnapshot).mockResolvedValue(snap);
    const res = await inbox.fetch(req('GET', '/api/route/inbox'));
    const json = (await res.json()) as { tasks: { task_id: string }[] };
    expect(json.tasks.map((t) => t.task_id)).toEqual([id(101)]);
    const open = buildInbox(snap, NOW, { userId: USER, minAgeMinutes: 0 });
    expect(open.tasks.map((t) => t.task_id)).toEqual([id(101), id(102)]);
    const { results } = planProposals(
      snap,
      body([keep(2)]),
      { userId: USER, minAgeMinutes: 0 },
      NOW,
    );
    expect(results[0]?.status).toBe('proposed');
  });
});

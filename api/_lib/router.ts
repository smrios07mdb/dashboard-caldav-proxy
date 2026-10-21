import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { jsonResponse } from './http.js';
import { getClient } from './supabase.js';

/*
 * General sorting (chunk 89, dashboard ARCHITECTURE.md §10).
 *
 * A Claude scheduled task reads open tasks sitting in a General list
 * (`GET /api/route/inbox`) and writes proposals (`POST /api/route/propose`).
 * The proxy never moves a task or creates a list: it only inserts
 * `routing_proposals` rows with status `pending`. The user approves in the app.
 *
 * Auth is a static bearer token (`ROUTER_TOKEN`) bound to one user
 * (`ROUTER_USER_ID`) — the scheduled task has no Supabase session. Every
 * query below is scoped to that user id (service-role client bypasses RLS).
 *
 * Chunk 90: the same core serves `POST /api/ai/sort` (the app's Sort General
 * button, Supabase-JWT auth). Callers pass a `RouterScope` — whose rows, and
 * how old a General task must be to count — so nothing here reads env.
 */

/** The router path's age filter (D1); the on-demand sort path passes 0. */
export const ROUTER_MIN_AGE_MINUTES = 10;
export const INBOX_LIMIT = 100;
export const EXAMPLES_PER_TARGET = 8;
export const EXAMPLE_WINDOW_DAYS = 90;
export const NEW_LIST_MIN_TASKS = 2;
// Chunk 90a: 3 → 8, so a press can empty General into new lists.
export const NEW_LISTS_PER_RUN = 8;

// ── auth ──────────────────────────────────────────────────────────────────

function digest(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

export type RouterAuth = { ok: true; userId: string } | { ok: false; status: 401 | 503 };

/** Bearer check, constant-time over SHA-256 digests (so lengths never leak). */
export function checkRouterAuth(req: Request): RouterAuth {
  const token = process.env.ROUTER_TOKEN;
  const userId = process.env.ROUTER_USER_ID;
  if (!token || !userId) return { ok: false, status: 503 };
  const header = req.headers.get('authorization') ?? '';
  const given = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  if (!given || !timingSafeEqual(digest(given), digest(token))) {
    return { ok: false, status: 401 };
  }
  return { ok: true, userId };
}

/** Whose rows, and the minimum task age (minutes) for a candidate. */
export interface RouterScope {
  userId: string;
  minAgeMinutes: number;
}

type RouterHandler = (req: Request, scope: RouterScope) => Promise<Response>;

export function routerRoute(handler: RouterHandler): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const auth = checkRouterAuth(req);
    if (!auth.ok) {
      return jsonResponse(req, auth.status, {
        ok: false,
        error: auth.status === 401 ? 'unauthorized' : 'not_configured',
      });
    }
    try {
      return await handler(req, { userId: auth.userId, minAgeMinutes: ROUTER_MIN_AGE_MINUTES });
    } catch (err) {
      console.error('route error:', err);
      return jsonResponse(req, 500, { ok: false, error: 'internal' });
    }
  };
}

// ── data ──────────────────────────────────────────────────────────────────

export interface CategoryRow {
  id: string;
  name: string;
}
export interface SubcategoryRow {
  id: string;
  name: string;
  category_id: string;
  sort_order: number;
  archived_at: string | null;
}
export interface GeneralTaskRow {
  id: string;
  title: string;
  subcategory_id: string;
  estimate_minutes: number;
  due_at: string | null;
  priority: number | null;
  created_at: string;
}
export interface Snapshot {
  categories: CategoryRow[];
  subcategories: SubcategoryRow[];
  /** Open tasks in live General lists, any age, oldest first. */
  generalTasks: GeneralTaskRow[];
  /** Task ids holding a pending, approved or kept proposal (D1, D8). */
  decidedTaskIds: Set<string>;
  /** Open or recently completed tasks, newest first (D2 examples). */
  recentTasks: { title: string; subcategory_id: string }[];
}

export function isGeneralName(name: string): boolean {
  return name.trim().toLowerCase() === 'general';
}

function fail(what: string, error: { message?: string } | null): never {
  throw new Error(`router: failed to load ${what}: ${error?.message ?? 'unknown'}`);
}

/** Read everything the inbox and propose endpoints need, for one user. */
export async function loadSnapshot(userId: string, now: Date): Promise<Snapshot> {
  const db = getClient();
  const [cats, subs] = await Promise.all([
    db.from('categories').select('id, name').eq('user_id', userId),
    db
      .from('subcategories')
      .select('id, name, category_id, sort_order, archived_at')
      .eq('user_id', userId),
  ]);
  if (cats.error) fail('categories', cats.error);
  if (subs.error) fail('subcategories', subs.error);
  const categories = (cats.data ?? []) as CategoryRow[];
  const subcategories = (subs.data ?? []) as SubcategoryRow[];

  const generalIds = subcategories
    .filter((s) => s.archived_at === null && isGeneralName(s.name))
    .map((s) => s.id);

  let generalTasks: GeneralTaskRow[] = [];
  if (generalIds.length > 0) {
    const res = await db
      .from('tasks')
      .select('id, title, subcategory_id, estimate_minutes, due_at, priority, created_at')
      .eq('user_id', userId)
      .is('completed_at', null)
      .in('subcategory_id', generalIds)
      .order('created_at', { ascending: true })
      .limit(1000);
    if (res.error) fail('tasks', res.error);
    generalTasks = (res.data ?? []) as GeneralTaskRow[];
  }

  const decidedTaskIds = new Set<string>();
  const ids = generalTasks.map((t) => t.id);
  for (let i = 0; i < ids.length; i += 100) {
    const res = await db
      .from('routing_proposals')
      .select('task_id')
      .eq('user_id', userId)
      .in('status', ['pending', 'approved', 'kept'])
      .in('task_id', ids.slice(i, i + 100));
    if (res.error) fail('proposals', res.error);
    for (const r of (res.data ?? []) as { task_id: string }[]) decidedTaskIds.add(r.task_id);
  }

  const since = new Date(now.getTime() - EXAMPLE_WINDOW_DAYS * 86_400_000).toISOString();
  const recent = await db
    .from('tasks')
    .select('title, subcategory_id')
    .eq('user_id', userId)
    .or(`completed_at.is.null,completed_at.gte.${since}`)
    .order('created_at', { ascending: false })
    .limit(1000);
  if (recent.error) fail('recent tasks', recent.error);

  return {
    categories,
    subcategories,
    generalTasks,
    decidedTaskIds,
    recentTasks: (recent.data ?? []) as { title: string; subcategory_id: string }[],
  };
}

export interface ProposalRow {
  user_id: string;
  run_id: string;
  task_id: string;
  from_subcategory_id: string;
  to_subcategory_id: string | null;
  new_list_name: string | null;
  new_list_category_id: string | null;
  reason: string;
  status: 'pending';
}

export async function insertProposals(rows: ProposalRow[]): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await getClient().from('routing_proposals').insert(rows);
  if (error) throw new Error(`router: failed to insert proposals: ${error.message}`);
}

// ── pure core ─────────────────────────────────────────────────────────────

/** D1: open General tasks, old enough, not already decided. Oldest first. */
export function candidates(snap: Snapshot, now: Date, minAgeMinutes: number): GeneralTaskRow[] {
  const cutoff = now.getTime() - minAgeMinutes * 60_000;
  return snap.generalTasks
    .filter((t) => Date.parse(t.created_at) <= cutoff && !snap.decidedTaskIds.has(t.id))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

/** D2: every live, non-General list of the user, in either category. */
export function liveTargets(snap: Snapshot): SubcategoryRow[] {
  const catOrder = new Map(snap.categories.map((c) => [c.id, c.name]));
  return snap.subcategories
    .filter((s) => s.archived_at === null && !isGeneralName(s.name))
    .sort(
      (a, b) =>
        (catOrder.get(a.category_id) ?? '').localeCompare(catOrder.get(b.category_id) ?? '') ||
        a.sort_order - b.sort_order,
    );
}

export function buildInbox(snap: Snapshot, now: Date, scope: RouterScope) {
  const catName = new Map(snap.categories.map((c) => [c.id, c.name]));
  const subCat = new Map(snap.subcategories.map((s) => [s.id, s.category_id]));
  const examples = new Map<string, string[]>();
  for (const t of snap.recentTasks) {
    const list = examples.get(t.subcategory_id) ?? [];
    if (list.length < EXAMPLES_PER_TARGET) list.push(t.title);
    examples.set(t.subcategory_id, list);
  }
  return {
    tasks: candidates(snap, now, scope.minAgeMinutes)
      .slice(0, INBOX_LIMIT)
      .map((t) => ({
        task_id: t.id,
        title: t.title,
        category_name: catName.get(subCat.get(t.subcategory_id) ?? '') ?? null,
        from_subcategory_id: t.subcategory_id,
        estimate_minutes: t.estimate_minutes,
        due_at: t.due_at,
        priority: t.priority,
        created_at: t.created_at,
      })),
    targets: liveTargets(snap).map((s) => ({
      subcategory_id: s.id,
      name: s.name,
      category_name: catName.get(s.category_id) ?? null,
      examples: examples.get(s.id) ?? [],
    })),
    categories: snap.categories.map((c) => ({ id: c.id, name: c.name })),
  };
}

const Proposal = z
  .object({
    task_id: z.guid(),
    subcategory_id: z.guid().nullish(),
    new_list: z
      .object({
        name: z.string().trim().min(1).max(40),
        category: z.enum(['Work', 'Personal']),
      })
      .strict()
      .nullish(),
    reason: z.string().trim().min(1).max(280),
  })
  .strict()
  .refine((p) => !(p.subcategory_id && p.new_list), {
    message: 'subcategory_id and new_list are exclusive',
  });

export const ProposeBody = z
  .object({ proposals: z.array(Proposal).min(1).max(100) })
  .strict()
  .refine((b) => new Set(b.proposals.map((p) => p.task_id)).size === b.proposals.length, {
    message: 'duplicate task_id',
  });
export type ProposeBody = z.infer<typeof ProposeBody>;

export type ProposeResult = {
  task_id: string;
  status: 'proposed' | 'kept_fallback' | 'skipped';
  detail?: string;
};

/**
 * Turn the model's proposals into rows (D1–D4). Results come back in input
 * order; every row shares `runId` and status `pending`.
 */
export function planProposals(
  snap: Snapshot,
  body: ProposeBody,
  scope: RouterScope,
  now: Date,
  runId: string = randomUUID(),
): { runId: string; rows: ProposalRow[]; results: ProposeResult[] } {
  const userId = scope.userId;
  const cand = new Map(candidates(snap, now, scope.minAgeMinutes).map((t) => [t.id, t]));
  const targets = new Map(liveTargets(snap).map((s) => [s.id, s]));
  const catByName = new Map(snap.categories.map((c) => [c.name, c]));

  const results = new Map<string, ProposeResult>();
  const rows: ProposalRow[] = [];
  const row = (
    t: GeneralTaskRow,
    reason: string,
    to: string | null,
    newList: { name: string; categoryId: string } | null,
  ): ProposalRow => ({
    user_id: userId,
    run_id: runId,
    task_id: t.id,
    from_subcategory_id: t.subcategory_id,
    to_subcategory_id: to,
    new_list_name: newList?.name ?? null,
    new_list_category_id: newList?.categoryId ?? null,
    reason,
    status: 'pending',
  });

  // New-list groups, keyed by category + case-folded name; first spelling wins.
  type Group = {
    name: string;
    categoryId: string;
    first: number;
    items: { t: GeneralTaskRow; reason: string }[];
  };
  const groups = new Map<string, Group>();

  body.proposals.forEach((p, index) => {
    const t = cand.get(p.task_id);
    if (!t) {
      results.set(p.task_id, { task_id: p.task_id, status: 'skipped', detail: 'not_candidate' });
      return;
    }
    if (p.subcategory_id) {
      if (!targets.has(p.subcategory_id)) {
        results.set(p.task_id, { task_id: p.task_id, status: 'skipped', detail: 'bad_target' });
        return;
      }
      rows.push(row(t, p.reason, p.subcategory_id, null));
      results.set(p.task_id, { task_id: p.task_id, status: 'proposed' });
      return;
    }
    if (p.new_list) {
      const name = p.new_list.name.trim();
      const cat = catByName.get(p.new_list.category);
      if (!cat || isGeneralName(name)) {
        rows.push(row(t, p.reason, null, null));
        results.set(p.task_id, {
          task_id: p.task_id,
          status: 'kept_fallback',
          detail: cat ? 'general_name' : 'unknown_category',
        });
        return;
      }
      const existing = [...targets.values()].find(
        (s) => s.category_id === cat.id && s.name.trim().toLowerCase() === name.toLowerCase(),
      );
      if (existing) {
        rows.push(row(t, p.reason, existing.id, null));
        results.set(p.task_id, {
          task_id: p.task_id,
          status: 'proposed',
          detail: 'existing_list',
        });
        return;
      }
      const key = `${cat.id}:${name.toLowerCase()}`;
      const g = groups.get(key) ?? { name, categoryId: cat.id, first: index, items: [] };
      g.items.push({ t, reason: p.reason });
      groups.set(key, g);
      return;
    }
    rows.push(row(t, p.reason, null, null));
    results.set(p.task_id, { task_id: p.task_id, status: 'proposed' });
  });

  // D3: a new list needs ≥2 tasks; at most NEW_LISTS_PER_RUN new lists (largest first).
  const fallback = (g: Group, detail: string) => {
    for (const { t, reason } of g.items) {
      rows.push(row(t, reason, null, null));
      results.set(t.id, { task_id: t.id, status: 'kept_fallback', detail });
    }
  };
  const viable: Group[] = [];
  for (const g of groups.values()) {
    if (g.items.length < NEW_LIST_MIN_TASKS) fallback(g, 'new_list_min');
    else viable.push(g);
  }
  viable.sort((a, b) => b.items.length - a.items.length || a.first - b.first);
  viable.forEach((g, i) => {
    if (i >= NEW_LISTS_PER_RUN) {
      fallback(g, 'new_list_max');
      return;
    }
    for (const { t, reason } of g.items) {
      rows.push(row(t, reason, null, { name: g.name, categoryId: g.categoryId }));
      results.set(t.id, { task_id: t.id, status: 'proposed' });
    }
  });

  return {
    runId,
    rows,
    results: body.proposals.map((p) => results.get(p.task_id)!),
  };
}

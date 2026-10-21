import { createHash } from 'node:crypto';
import { z } from 'zod';
import { decrypt } from './crypto.js';
import { SORT_MAX_TOKENS, SORT_SYSTEM_PROMPT, SORT_TOOL, SORT_TOOL_NAME } from './sortPrompt.js';
import { byteaToBuffer, getClient } from './supabase.js';

// AI triage (ARCHITECTURE.md §10, chunk 55). The proxy owns the model, the
// token cap and the system prompt; the browser sends only the task payload and
// never sees the Anthropic key again.
//
// Chunk 57: the model is always the newest active Haiku, resolved at runtime
// from `GET /v1/models` (Anthropic has no `-latest` alias). The floor is what
// triage uses when that cannot be resolved — still a Haiku, never another line.
export const HAIKU_FLOOR = 'claude-haiku-5-5';
export const MAX_TOKENS = 800;

export const SYSTEM_PROMPT =
  'You are a triage assistant for a personal productivity dashboard. ' +
  "Given a list of the user's incomplete tasks and their available time, " +
  'recommend 1–3 tasks to do next. Consider deadlines, time fit, priority, ' +
  'and category balance. Respond with valid JSON only: ' +
  '{ "recommendations": [{ "task_id": "...", "reason": "<one sentence>" }], ' +
  '"note": "<optional brief note>" }. Do not include any text outside the JSON.';

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
// Functions are capped at 15s (vercel.json); fail as `upstream` before that.
const TIMEOUT_MS = 12_000;
// Chunk 90: a sort press can write up to 4000 tokens, so `api/ai/sort.ts` runs
// with a 60 s cap (vercel.json) and answers `upstream` itself at 50 s.
export const SORT_TIMEOUT_MS = 50_000;

const MODELS_PAGE_LIMIT = 100;
const MODELS_MAX_PAGES = 3;
const RESOLVED_TTL_MS = 24 * 60 * 60 * 1000;
// Short, so an outage doesn't hammer `/v1/models` but recovery is picked up.
const FLOOR_TTL_MS = 5 * 60 * 1000;

/** The per-task shape the model receives (snake_case, §10 `TriageTask`). */
export const TriageTask = z.strictObject({
  task_id: z.string(),
  title: z.string(),
  subcategory_name: z.string(),
  category_name: z.string(),
  estimate_minutes: z.number(),
  due_at: z.string().nullable(),
  priority: z.number().nullable(),
});

export const TriageBody = z.object({
  tasks: z.array(TriageTask).max(300),
  available_minutes: z.number().int().min(1).max(1440),
  timezone: z.string().max(64),
});

export type TriageBody = z.infer<typeof TriageBody>;

export type AnthropicOutcome<T = undefined> =
  | { kind: 'ok'; data: T }
  | { kind: 'bad_key' }
  | { kind: 'upstream' };

function anthropicHeaders(apiKey: string): Record<string, string> {
  return { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION };
}

function classify(status: number): 'ok' | 'bad_key' | 'upstream' {
  if (status === 401 || status === 403) return 'bad_key';
  return status >= 200 && status < 300 ? 'ok' : 'upstream';
}

/** Cheapest authenticated call Anthropic offers — proves the key is live. */
export async function validateKey(apiKey: string): Promise<AnthropicOutcome> {
  let res: Response;
  try {
    res = await fetch(`${ANTHROPIC_BASE}/models?limit=1`, {
      headers: anthropicHeaders(apiKey),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { kind: 'upstream' };
  }
  const kind = classify(res.status);
  return kind === 'ok' ? { kind, data: undefined } : { kind };
}

const ModelsPage = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      line: z.string().nullish(),
      lifecycle: z.string().nullish(),
      created_at: z.string().nullish(),
    }),
  ),
  has_more: z.boolean().nullish(),
  last_id: z.string().nullish(),
});

export type ModelSource = 'resolved' | 'floor' | 'cache';
// `reason` is set only on a fresh floor: why the newest Haiku was not resolved.
export type ResolvedModel = { model: string; source: ModelSource; reason?: string };

/** A resolution failure whose message is safe to log (no key, no body text). */
class ResolveError extends Error {}

// Per warm instance, keyed by SHA-256 of the API key — the raw key is never a
// map key and never logged. Nothing is persisted (Supabase is unaware of the
// model).
const modelCache = new Map<string, { model: string; expiresAt: number }>();

function cacheKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

/** Test seam: forget every cached model. */
export function clearModelCache(): void {
  modelCache.clear();
}

/** Newest active Haiku across at most three pages; throws if there is none. */
async function fetchNewestHaiku(apiKey: string, signal: AbortSignal): Promise<string> {
  let best: { id: string; createdAt: number } | null = null;
  let seen = 0;
  let haikus = 0;
  let afterId: string | null = null;
  for (let page = 0; page < MODELS_MAX_PAGES; page++) {
    const cursor: string = afterId ? `&after_id=${encodeURIComponent(afterId)}` : '';
    // No `lifecycle` query filter: Anthropic answered `lifecycle=active` with
    // 400 invalid_request_error (prod, 2026-10-12). The default list is active
    // + deprecated, and the per-entry check below keeps only active.
    const res = await fetch(`${ANTHROPIC_BASE}/models?limit=${MODELS_PAGE_LIMIT}${cursor}`, {
      headers: anthropicHeaders(apiKey),
      signal,
    });
    if (!res.ok) throw new ResolveError(`models_${res.status}${await errorType(res)}`);
    const pageResult = ModelsPage.safeParse(await res.json().catch(() => null));
    if (!pageResult.success) throw new ResolveError('malformed');
    const parsed = pageResult.data;
    for (const m of parsed.data) {
      // `line` and `lifecycle` are the API's own fields; the id text is never
      // matched.
      seen++;
      if (m.line !== 'haiku') continue;
      haikus++;
      if (m.lifecycle !== 'active') continue;
      const parsedAt = Date.parse(m.created_at ?? '');
      const createdAt = Number.isNaN(parsedAt) ? -Infinity : parsedAt;
      // Strict `>`: on a tie the earlier entry wins (the API lists newest first).
      if (!best || createdAt > best.createdAt) best = { id: m.id, createdAt };
    }
    if (!parsed.has_more || !parsed.last_id) break;
    afterId = parsed.last_id;
  }
  // The counts say whether the list was empty, had no Haiku, or had only
  // non-active ones.
  if (!best) throw new ResolveError(`no_haiku:seen=${seen},haiku=${haikus}`);
  return best.id;
}

/**
 * The model triage must use for this key: the newest active Haiku, cached for
 * 24 h. Any failure — non-2xx, network, timeout, malformed page, no active
 * Haiku — yields `HAIKU_FLOOR`, cached for 5 min.
 */
export async function resolveHaikuModel(
  apiKey: string,
  signal: AbortSignal = AbortSignal.timeout(TIMEOUT_MS),
): Promise<ResolvedModel> {
  const key = cacheKey(apiKey);
  const hit = modelCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return { model: hit.model, source: 'cache' };

  let found: string | null;
  let reason = '';
  try {
    found = await fetchNewestHaiku(apiKey, signal);
  } catch (err) {
    found = null;
    reason =
      err instanceof ResolveError
        ? err.message
        : err instanceof Error && err.name === 'TimeoutError'
          ? 'timeout'
          : 'network';
  }
  const model = found ?? HAIKU_FLOOR;
  modelCache.set(key, {
    model,
    expiresAt: Date.now() + (found ? RESOLVED_TTL_MS : FLOOR_TTL_MS),
  });
  return found ? { model, source: 'resolved' } : { model, source: 'floor', reason };
}

/** `:<error.type>` from an Anthropic error body, if it is a plain token. */
async function errorType(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { type?: unknown } } | null;
    const type = body?.error?.type;
    return typeof type === 'string' && /^[a-z_]{1,40}$/.test(type) ? `:${type}` : '';
  } catch {
    return '';
  }
}

/** A 404 whose body says the *model* is gone (retired), not the route. */
async function isModelNotFound(res: Response): Promise<boolean> {
  if (res.status !== 404) return false;
  try {
    const body = (await res.json()) as { error?: { type?: unknown } } | null;
    return body?.error?.type === 'not_found_error';
  } catch {
    return false;
  }
}

/**
 * One Messages call with the resolved model. Resolution and the call share
 * one budget, so the function answers `upstream` itself instead of being
 * killed at the platform cap. A retired model (404 `not_found_error`) drops
 * the cache entry, re-resolves and retries once (chunk 57 D4). `label` names
 * the one log line per call; it never carries key material or task content.
 */
async function callLatestHaiku(
  apiKey: string,
  label: string,
  timeoutMs: number,
  build: (model: string) => Record<string, unknown>,
): Promise<AnthropicOutcome<unknown>> {
  const signal = AbortSignal.timeout(timeoutMs);
  let resolved = await resolveHaikuModel(apiKey, signal);
  let res: Response;
  try {
    res = await postMessages(apiKey, build(resolved.model), signal);
    if (await isModelNotFound(res)) {
      modelCache.delete(cacheKey(apiKey));
      resolved = await resolveHaikuModel(apiKey, signal);
      res = await postMessages(apiKey, build(resolved.model), signal);
    }
  } catch (err) {
    console.log(`${label} upstream thrown=${err instanceof Error ? err.name : 'unknown'}`);
    return { kind: 'upstream' };
  } finally {
    const why = resolved.reason ? ` reason=${resolved.reason}` : '';
    console.log(`${label} model=${resolved.model} source=${resolved.source}${why}`);
  }
  const kind = classify(res.status);
  if (kind === 'upstream') {
    // Status and Anthropic's error type only: the message can echo task content.
    console.log(`${label} upstream status=${res.status}${await errorType(res)}`);
  }
  if (kind !== 'ok') return { kind };
  try {
    return { kind, data: await res.json() };
  } catch {
    return { kind: 'upstream' };
  }
}

/** The §10 triage call. `data` is Anthropic's JSON, unmodified. */
export function requestTriage(
  apiKey: string,
  body: TriageBody,
): Promise<AnthropicOutcome<unknown>> {
  return callLatestHaiku(apiKey, 'triage', TIMEOUT_MS, (model) => ({
    model,
    max_tokens: MAX_TOKENS,
    // Claude Haiku 5.5 thinks by default, and thinking can spend the whole
    // 800-token cap before the JSON is written. Accepted at the default effort.
    thinking: { type: 'disabled' },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: JSON.stringify({
          tasks: body.tasks,
          available_minutes: body.available_minutes,
          timezone: body.timezone,
        }),
      },
    ],
  }));
}

/**
 * The chunk-90 sort call: one request, output forced through the
 * `propose_sorting` tool. `payload` is the user message (tasks + lists). No
 * `temperature`: Claude Haiku 5.5 answers 400 to any non-default sampling
 * parameter.
 */
export function requestSort(apiKey: string, payload: unknown): Promise<AnthropicOutcome<unknown>> {
  return callLatestHaiku(apiKey, 'sort', SORT_TIMEOUT_MS, (model) => ({
    model,
    max_tokens: SORT_MAX_TOKENS,
    system: SORT_SYSTEM_PROMPT,
    tools: [SORT_TOOL],
    tool_choice: { type: 'tool', name: SORT_TOOL_NAME },
    messages: [{ role: 'user', content: JSON.stringify(payload) }],
  }));
}

function postMessages(
  apiKey: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(`${ANTHROPIC_BASE}/messages`, {
    method: 'POST',
    headers: { ...anthropicHeaders(apiKey), 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

async function selectColumn(userId: string, column: string): Promise<string | null> {
  const { data, error } = await getClient()
    .from('settings')
    .select(column)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    throw new Error(`failed to load settings: ${error.message ?? String(error)}`);
  }
  const value = (data as Record<string, unknown> | null)?.[column];
  return typeof value === 'string' ? value : null;
}

/** The stored key ciphertext (`bytea`, `\x`-hex transport), or null. */
export function getEncryptedAiKey(userId: string): Promise<string | null> {
  return selectColumn(userId, 'ai_api_key_encrypted');
}

/** The caller's Anthropic key: the decrypted stored key, or null. */
export async function loadAiKey(userId: string): Promise<string | null> {
  const stored = await getEncryptedAiKey(userId);
  return stored ? decrypt(byteaToBuffer(stored)) : null;
}

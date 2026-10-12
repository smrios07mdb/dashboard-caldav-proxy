import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getClient } from './supabase.js';

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

/** Newest active Haiku across at most three pages, or null if there is none. */
async function fetchNewestHaiku(apiKey: string, signal: AbortSignal): Promise<string | null> {
  let best: { id: string; createdAt: number } | null = null;
  let afterId: string | null = null;
  for (let page = 0; page < MODELS_MAX_PAGES; page++) {
    const cursor: string = afterId ? `&after_id=${encodeURIComponent(afterId)}` : '';
    const res = await fetch(
      `${ANTHROPIC_BASE}/models?limit=${MODELS_PAGE_LIMIT}&lifecycle=active${cursor}`,
      { headers: anthropicHeaders(apiKey), signal },
    );
    if (!res.ok) throw new ResolveError(`models_${res.status}${await errorType(res)}`);
    const pageResult = ModelsPage.safeParse(await res.json().catch(() => null));
    if (!pageResult.success) throw new ResolveError('malformed');
    const parsed = pageResult.data;
    for (const m of parsed.data) {
      // `line` and `lifecycle` are the API's own fields; the id text is never
      // matched. The lifecycle check repeats the query filter on purpose.
      if (m.line !== 'haiku' || m.lifecycle !== 'active') continue;
      const parsedAt = Date.parse(m.created_at ?? '');
      const createdAt = Number.isNaN(parsedAt) ? -Infinity : parsedAt;
      // Strict `>`: on a tie the earlier entry wins (the API lists newest first).
      if (!best || createdAt > best.createdAt) best = { id: m.id, createdAt };
    }
    if (!parsed.has_more || !parsed.last_id) break;
    afterId = parsed.last_id;
  }
  return best?.id ?? null;
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
  let reason = 'no_haiku';
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
 * The §10 Messages call. `data` is Anthropic's JSON, unmodified. Resolution
 * and the Messages call share one 12 s budget, so the function answers
 * `upstream` itself instead of being killed at the 15 s platform cap.
 */
export async function requestTriage(
  apiKey: string,
  body: TriageBody,
): Promise<AnthropicOutcome<unknown>> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let resolved = await resolveHaikuModel(apiKey, signal);
  let res: Response;
  try {
    res = await postMessages(apiKey, resolved.model, body, signal);
    if (await isModelNotFound(res)) {
      // The cached/resolved model was retired under us: re-resolve, retry once.
      modelCache.delete(cacheKey(apiKey));
      resolved = await resolveHaikuModel(apiKey, signal);
      res = await postMessages(apiKey, resolved.model, body, signal);
    }
  } catch {
    return { kind: 'upstream' };
  } finally {
    // One line per triage; no key material.
    const why = resolved.reason ? ` reason=${resolved.reason}` : '';
    console.log(`triage model=${resolved.model} source=${resolved.source}${why}`);
  }
  const kind = classify(res.status);
  if (kind !== 'ok') return { kind };
  try {
    return { kind, data: await res.json() };
  } catch {
    return { kind: 'upstream' };
  }
}

function postMessages(
  apiKey: string,
  model: string,
  body: TriageBody,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(`${ANTHROPIC_BASE}/messages`, {
    method: 'POST',
    headers: { ...anthropicHeaders(apiKey), 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
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
    }),
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

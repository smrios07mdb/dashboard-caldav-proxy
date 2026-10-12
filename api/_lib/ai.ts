import { z } from 'zod';
import { getClient } from './supabase.js';

// AI triage (ARCHITECTURE.md §10, chunk 55). The proxy owns the model, the
// token cap and the system prompt; the browser sends only the task payload and
// never sees the Anthropic key again.
export const MODEL = 'claude-haiku-5-5';
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

/** The §10 Messages call. `data` is Anthropic's JSON, unmodified. */
export async function requestTriage(
  apiKey: string,
  body: TriageBody,
): Promise<AnthropicOutcome<unknown>> {
  let res: Response;
  try {
    res = await fetch(`${ANTHROPIC_BASE}/messages`, {
      method: 'POST',
      headers: { ...anthropicHeaders(apiKey), 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
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
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { kind: 'upstream' };
  }
  const kind = classify(res.status);
  if (kind !== 'ok') return { kind };
  try {
    return { kind, data: await res.json() };
  } catch {
    return { kind: 'upstream' };
  }
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

/**
 * Legacy plaintext key, read ONLY for the one-time lazy migration in
 * /api/ai/triage (chunk 55 D5). Deliberately its own select — never add this
 * column to CALDAV_COLUMNS; it is dropped in the next chunk.
 */
export async function getLegacyAiKey(userId: string): Promise<string | null> {
  const value = (await selectColumn(userId, 'ai_api_key'))?.trim();
  return value ? value : null;
}

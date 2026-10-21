import { z } from 'zod';
import type { ProposeBody } from './router.js';

/*
 * General sorting on demand (chunk 90, dashboard ARCHITECTURE.md §10).
 * `POST /api/ai/sort` asks the newest Haiku for the same proposals the
 * scheduled task writes through `/api/route/propose`, forced through one tool
 * whose input is that endpoint's body. The proposals then go through the
 * router's own validation (`planProposals`).
 */

export const SORT_TOOL_NAME = 'propose_sorting';
// ~77 output tokens per task × SORT_BATCH ≈ 7,700; 12,000 leaves headroom.
export const SORT_MAX_TOKENS = 12_000;
/** Candidates sent per press (D4); the response reports the rest as `remaining`. */
export const SORT_BATCH = 100;

export const SORT_SYSTEM_PROMPT = [
  "You sort tasks out of a personal to-do app's General lists into better lists.",
  'You get `tasks` (each with a task_id, title and the category of the General list it sits in now) and `lists` (each with a subcategory_id, name, category and example task titles).',
  'Goal: empty the General lists. Keeping a task in General is the exception, only for a task that truly fits no list and shares no theme with any other task.',
  'Call propose_sorting once, with one entry per task. For every task:',
  '- Step 1: decide Work or Personal from what the task is about, ignoring which General list it is in now. Work = MDB Capital, deals, clients, investors, compliance, colleagues, work tools. Personal = home, family, health, money, errands, personal projects and apps.',
  '- Step 2: put it in the existing list in that category that fits (subcategory_id), judging by the list names and their example titles.',
  "- Step 3: if none fits, put it in a new list in that category (new_list with that category). Prefer broad, durable names (Home, Finances, Health, Family, Errands, Deals, Compliance) so tasks group. At most 3 words, Title Case. Use the same exact spelling for every task going to the same new list. A new list needs at least 2 tasks; if a task's theme is truly alone, put it in the closest existing or new list in its category instead of keeping it.",
  '- To keep a task in General: subcategory_id null and new_list null.',
  '- Give a one-line reason for each task, at most 120 characters.',
  '- Never invent ids: use only the task_id and subcategory_id values given.',
].join('\n');

/** The chunk-89 `propose` body, as a JSON schema for the forced tool call. */
export const SORT_TOOL = {
  name: SORT_TOOL_NAME,
  description: 'Propose a destination for every General task.',
  input_schema: {
    type: 'object',
    properties: {
      proposals: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'A task_id from tasks.' },
            subcategory_id: {
              type: ['string', 'null'],
              description: 'A subcategory_id from lists, or null.',
            },
            new_list: {
              anyOf: [
                {
                  type: 'object',
                  properties: {
                    name: { type: 'string', maxLength: 40 },
                    category: { type: 'string', enum: ['Work', 'Personal'] },
                  },
                  required: ['name', 'category'],
                },
                { type: 'null' },
              ],
            },
            reason: { type: 'string', maxLength: 120 },
          },
          required: ['task_id', 'subcategory_id', 'new_list', 'reason'],
        },
      },
    },
    required: ['proposals'],
  },
} as const;

// The tool call as a whole must have this shape, or the press is `malformed`.
const ToolInput = z.object({ proposals: z.array(z.unknown()) });

// One entry. A bad entry is skipped on its own (`invalid`); it does not sink
// the rest of the press.
const Entry = z.object({
  task_id: z.string().min(1),
  subcategory_id: z.string().nullish(),
  new_list: z.object({ name: z.string(), category: z.enum(['Work', 'Personal']) }).nullish(),
  reason: z.string(),
});

const ToolUse = z.object({
  type: z.literal('tool_use'),
  name: z.literal(SORT_TOOL_NAME),
  input: z.unknown(),
});

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

/**
 * The `propose_sorting` input from Anthropic's Messages JSON, or null when
 * there is no such tool call or it fails the schema (→ 502 `malformed`).
 */
export function readToolCall(data: unknown): { entries: unknown[]; usage: Usage | null } | null {
  const content = (data as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    const use = ToolUse.safeParse(block);
    if (!use.success) continue;
    const input = ToolInput.safeParse(use.data.input);
    if (!input.success) return null;
    const u = (data as { usage?: { input_tokens?: unknown; output_tokens?: unknown } }).usage;
    const usage =
      typeof u?.input_tokens === 'number' && typeof u?.output_tokens === 'number'
        ? { input_tokens: u.input_tokens, output_tokens: u.output_tokens }
        : null;
    return { entries: input.data.proposals, usage };
  }
  return null;
}

/**
 * Model entries → a `propose` body for `planProposals`. Entries for a task
 * that was not sent, repeated task ids and entries that fail `Entry` are
 * dropped and counted in `skipped`. Unknown or General targets are left for
 * `planProposals` to reject as `bad_target`.
 */
export function toProposeBody(
  entries: unknown[],
  sentIds: Set<string>,
): { body: ProposeBody; skipped: number } {
  const seen = new Set<string>();
  const proposals: ProposeBody['proposals'] = [];
  let skipped = 0;
  for (const raw of entries) {
    const e = Entry.safeParse(raw);
    if (!e.success || !sentIds.has(e.data.task_id) || seen.has(e.data.task_id)) {
      skipped++;
      continue;
    }
    seen.add(e.data.task_id);
    const sub = e.data.subcategory_id || null;
    const name = e.data.new_list?.name.trim().slice(0, 40) ?? '';
    proposals.push({
      task_id: e.data.task_id,
      subcategory_id: sub,
      new_list:
        !sub && e.data.new_list && name ? { name, category: e.data.new_list.category } : null,
      reason: e.data.reason.trim().slice(0, 280) || 'No reason given',
    });
  }
  return { body: { proposals }, skipped };
}

import { loadAiKey, requestSort } from '../_lib/ai.js';
import { calendarRoute, jsonResponse } from '../_lib/http.js';
import {
  buildInbox,
  candidates,
  insertProposals,
  loadSnapshot,
  planProposals,
  type RouterScope,
} from '../_lib/router.js';
import { readToolCall, SORT_BATCH, toProposeBody } from '../_lib/sortPrompt.js';
import { updateSettings } from '../_lib/supabase.js';

/**
 * Chunk 90: the app's Sort General button. Same candidates, targets and
 * proposal rules as `/api/route/*` (chunk 89), with the age filter off — the
 * press is an explicit request — and the model called here, with the user's
 * saved Anthropic key. Acts on the JWT's user. Never moves a task.
 */
export default {
  fetch: calendarRoute(async (req, userId) => {
    if (req.method !== 'POST') {
      return jsonResponse(req, 405, { ok: false, error: 'method_not_allowed' });
    }
    const apiKey = await loadAiKey(userId);
    if (!apiKey) return jsonResponse(req, 412, { ok: false, error: 'missing_key' });

    const scope: RouterScope = { userId, minAgeMinutes: 0 };
    const now = new Date();
    const snap = await loadSnapshot(userId, now);
    const total = candidates(snap, now, scope.minAgeMinutes).length;
    const inbox = buildInbox(snap, now, scope);
    const batch = inbox.tasks.slice(0, SORT_BATCH);
    if (batch.length === 0) {
      return jsonResponse(req, 200, {
        ok: true,
        run_id: null,
        proposed: 0,
        kept: 0,
        skipped: 0,
        remaining: 0,
        usage: null,
      });
    }

    const outcome = await requestSort(apiKey, {
      tasks: batch.map((t) => ({
        task_id: t.task_id,
        title: t.title,
        category_name: t.category_name,
      })),
      lists: inbox.targets,
    });
    if (outcome.kind === 'bad_key') {
      await updateSettings(userId, { ai_status: 'auth_failed' });
      return jsonResponse(req, 422, { ok: false, error: 'bad_key' });
    }
    if (outcome.kind === 'upstream') {
      return jsonResponse(req, 502, { ok: false, error: 'upstream' });
    }
    // A cut-off tool call can still parse; never write a partial batch.
    const stop = (outcome.data as { stop_reason?: unknown } | null)?.stop_reason;
    if (stop === 'max_tokens') {
      console.log('sort truncated status=200 stop_reason=max_tokens');
      return jsonResponse(req, 502, { ok: false, error: 'truncated' });
    }
    const call = readToolCall(outcome.data);
    if (!call) return jsonResponse(req, 502, { ok: false, error: 'malformed' });

    const sent = new Set(batch.map((t) => t.task_id));
    const { body, skipped: invalid } = toProposeBody(call.entries, sent);
    const { runId, rows, results } =
      body.proposals.length > 0
        ? planProposals(snap, body, scope, now)
        : { runId: null, rows: [], results: [] };
    await insertProposals(rows);

    const proposed = rows.filter((r) => r.to_subcategory_id || r.new_list_name).length;
    return jsonResponse(req, 200, {
      ok: true,
      run_id: runId,
      proposed,
      kept: rows.length - proposed,
      skipped: invalid + results.filter((r) => r.status === 'skipped').length,
      // Candidates still without a proposal: beyond the batch, or left out by the model.
      remaining: total - rows.length,
      usage: call.usage,
    });
  }),
};

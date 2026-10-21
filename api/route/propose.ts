import { jsonResponse } from '../_lib/http.js';
import {
  insertProposals,
  loadSnapshot,
  planProposals,
  ProposeBody,
  routerRoute,
} from '../_lib/router.js';

/** Chunk 89: write pending routing proposals. Never moves a task or creates a list. */
export default {
  fetch: routerRoute(async (req, scope) => {
    if (req.method !== 'POST') {
      return jsonResponse(req, 405, { ok: false, error: 'method_not_allowed' });
    }
    const parsed = ProposeBody.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return jsonResponse(req, 400, { ok: false, error: 'invalid_request' });
    }
    const now = new Date();
    const snap = await loadSnapshot(scope.userId, now);
    const { runId, rows, results } = planProposals(snap, parsed.data, scope, now);
    await insertProposals(rows);
    return jsonResponse(req, 200, { ok: true, run_id: runId, results });
  }),
};

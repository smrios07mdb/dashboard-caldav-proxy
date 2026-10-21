import { jsonResponse } from '../_lib/http.js';
import { buildInbox, loadSnapshot, routerRoute } from '../_lib/router.js';

/** Chunk 89: open General tasks to sort, the lists they could go to, and the categories. */
export default {
  fetch: routerRoute(async (req, userId) => {
    if (req.method !== 'GET') {
      return jsonResponse(req, 405, { ok: false, error: 'method_not_allowed' });
    }
    const now = new Date();
    const snap = await loadSnapshot(userId, now);
    return jsonResponse(req, 200, { ok: true, ...buildInbox(snap, now) });
  }),
};

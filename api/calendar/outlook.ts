import { z } from 'zod';
import { encrypt } from '../_lib/crypto.js';
import { calendarRoute, jsonResponse } from '../_lib/http.js';
import { fetchIcsFeed, IcsError, parseIcsBusy } from '../_lib/ics.js';
import { bufferToBytea, updateSettings } from '../_lib/supabase.js';

const Body = z.object({
  icsUrl: z.string().min(1).nullable(),
});

const SMOKE_WINDOW_DAYS = 7;

export default {
  fetch: calendarRoute(async (req, userId) => {
    if (req.method !== 'POST') {
      return jsonResponse(req, 405, { ok: false, error: 'method_not_allowed' });
    }
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return jsonResponse(req, 400, { ok: false, error: 'invalid_request' });
    }

    // Disconnect: reset all outlook columns to their defaults.
    if (parsed.data.icsUrl === null) {
      await updateSettings(userId, {
        outlook_ics_url_encrypted: null,
        outlook_feed_name: null,
        outlook_status: 'unconfigured',
        outlook_cached_busy: null,
        outlook_fetched_at: null,
      });
      return jsonResponse(req, 200, { ok: true, cleared: true });
    }

    // Verify before persisting: a failed fetch/parse never overwrites a
    // working config (mirrors test-credentials → save-credentials, in one step).
    const now = new Date();
    const to = new Date(now.getTime() + SMOKE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    let feedName: string | null;
    let busy: ReturnType<typeof parseIcsBusy>;
    try {
      const feed = await fetchIcsFeed(parsed.data.icsUrl);
      feedName = feed.feedName;
      busy = parseIcsBusy(feed.raw, now.toISOString(), to.toISOString());
    } catch (err) {
      if (err instanceof IcsError) {
        return jsonResponse(req, 422, { ok: false, error: err.kind });
      }
      throw err;
    }

    const encrypted = await encrypt(parsed.data.icsUrl);
    await updateSettings(userId, {
      outlook_ics_url_encrypted: bufferToBytea(encrypted),
      outlook_feed_name: feedName,
      outlook_status: 'ok',
      outlook_cached_busy: busy,
      outlook_fetched_at: now.toISOString(),
    });
    return jsonResponse(req, 200, { ok: true, feedName, eventCount: busy.length });
  }),
};

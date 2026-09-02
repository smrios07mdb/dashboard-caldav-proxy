import { discover } from '../_lib/caldav.js';
import { decrypt } from '../_lib/crypto.js';
import { caldavErrorResponse, calendarRoute, jsonResponse } from '../_lib/http.js';
import { byteaToBuffer, getSettings } from '../_lib/supabase.js';

/**
 * GET /api/calendar/calendars (chunk 51) — discovery with the STORED
 * credentials (no password in the request), so the Planner's calendar picker
 * can list the account's event calendars and the app can initialize /
 * refresh the read set. `writeTargetUrl` echoes `caldav_calendar_url` so the
 * picker can tag the write-target row.
 *
 * 412 no_credentials when iCloud isn't configured; an auth failure flips
 * `caldav_status` and answers 401 auth_failed (same contract as busy/events).
 */
export default {
  fetch: calendarRoute(async (req, userId) => {
    if (req.method !== 'GET') {
      return jsonResponse(req, 405, { ok: false, error: 'method_not_allowed' });
    }
    const settings = await getSettings(userId);
    if (!settings?.caldav_apple_id || !settings.caldav_app_password_encrypted) {
      return jsonResponse(req, 412, { ok: false, error: 'no_credentials' });
    }
    const password = await decrypt(byteaToBuffer(settings.caldav_app_password_encrypted));
    try {
      const { calendars } = await discover(settings.caldav_apple_id, password);
      return jsonResponse(req, 200, {
        ok: true,
        calendars,
        writeTargetUrl: settings.caldav_calendar_url ?? null,
      });
    } catch (err) {
      return caldavErrorResponse(req, userId, err);
    }
  }),
};

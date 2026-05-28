import { z } from 'zod';
import { getBusy } from '../_lib/caldav.js';
import { decrypt } from '../_lib/crypto.js';
import { caldavErrorResponse, calendarRoute, jsonResponse } from '../_lib/http.js';
import { byteaToBuffer, getSettings } from '../_lib/supabase.js';

const Query = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});

export default {
  fetch: calendarRoute(async (req, userId) => {
    if (req.method !== 'GET') {
      return jsonResponse(req, 405, { ok: false, error: 'method_not_allowed' });
    }
    const url = new URL(req.url);
    const query = Query.safeParse({
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
    });
    if (!query.success) {
      return jsonResponse(req, 400, { ok: false, error: 'invalid_request' });
    }

    const settings = await getSettings(userId);
    if (
      !settings?.caldav_apple_id ||
      !settings.caldav_app_password_encrypted ||
      !settings.caldav_calendar_url
    ) {
      return jsonResponse(req, 412, { ok: false, error: 'no_credentials' });
    }

    const password = await decrypt(byteaToBuffer(settings.caldav_app_password_encrypted));
    try {
      const busy = await getBusy(
        settings.caldav_calendar_url,
        settings.caldav_apple_id,
        password,
        query.data.from,
        query.data.to,
      );
      return jsonResponse(req, 200, { ok: true, busy });
    } catch (err) {
      return caldavErrorResponse(req, userId, err);
    }
  }),
};

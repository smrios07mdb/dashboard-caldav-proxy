import { z } from 'zod';
import { CalDavError, discover } from '../_lib/caldav.js';
import { calendarRoute, jsonResponse } from '../_lib/http.js';

const Body = z.object({
  apple_id: z.string().min(1),
  app_password: z.string().min(1),
});

export default {
  fetch: calendarRoute(async (req) => {
    if (req.method !== 'POST') {
      return jsonResponse(req, 405, { ok: false, error: 'method_not_allowed' });
    }
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return jsonResponse(req, 400, { ok: false, error: 'invalid_request' });
    }

    try {
      const { calendars } = await discover(parsed.data.apple_id, parsed.data.app_password);
      return jsonResponse(req, 200, { ok: true, calendars });
    } catch (err) {
      if (err instanceof CalDavError) {
        // Pre-save check: report the failure but never persist anything here.
        return jsonResponse(req, err.kind === 'auth' ? 401 : 502, { ok: false, error: err.kind });
      }
      throw err;
    }
  }),
};

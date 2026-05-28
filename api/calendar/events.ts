import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createEvent } from '../_lib/caldav.js';
import { decrypt } from '../_lib/crypto.js';
import { caldavErrorResponse, calendarRoute, jsonResponse } from '../_lib/http.js';
import { byteaToBuffer, getSettings } from '../_lib/supabase.js';

const Body = z.object({
  title: z.string().min(1),
  start: z.string().min(1),
  end: z.string().min(1),
  description: z.string().optional(),
});

export default {
  fetch: calendarRoute(async (req, userId) => {
    if (req.method !== 'POST') {
      return jsonResponse(req, 405, { ok: false, error: 'method_not_allowed' });
    }
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
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
    const uid = randomUUID();
    try {
      await createEvent(settings.caldav_calendar_url, settings.caldav_apple_id, password, {
        title: parsed.data.title,
        start: parsed.data.start,
        end: parsed.data.end,
        description: parsed.data.description,
        uid,
      });
      return jsonResponse(req, 200, { ok: true, uid });
    } catch (err) {
      return caldavErrorResponse(req, userId, err);
    }
  }),
};

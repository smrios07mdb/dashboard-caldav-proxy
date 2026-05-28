import { z } from 'zod';
import { encrypt } from '../_lib/crypto.js';
import { calendarRoute, jsonResponse } from '../_lib/http.js';
import { bufferToBytea, updateSettings } from '../_lib/supabase.js';

const Body = z.object({
  apple_id: z.string().min(1),
  app_password: z.string().min(1),
  calendar_url: z.string().min(1),
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

    const encrypted = await encrypt(parsed.data.app_password);
    await updateSettings(userId, {
      caldav_apple_id: parsed.data.apple_id,
      caldav_app_password_encrypted: bufferToBytea(encrypted),
      caldav_calendar_url: parsed.data.calendar_url,
      caldav_status: 'ok',
    });
    return jsonResponse(req, 200, { ok: true });
  }),
};

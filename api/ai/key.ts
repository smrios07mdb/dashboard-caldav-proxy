import { z } from 'zod';
import { validateKey } from '../_lib/ai.js';
import { encrypt } from '../_lib/crypto.js';
import { calendarRoute, jsonResponse } from '../_lib/http.js';
import { bufferToBytea, updateSettings } from '../_lib/supabase.js';

const Body = z.object({
  api_key: z.string().trim().min(1).max(512),
});

export default {
  fetch: calendarRoute(async (req, userId) => {
    if (req.method === 'DELETE') {
      await updateSettings(userId, {
        ai_api_key_encrypted: null,
        ai_api_key: null,
        ai_status: 'unconfigured',
      });
      return jsonResponse(req, 200, { ok: true });
    }
    if (req.method !== 'POST') {
      return jsonResponse(req, 405, { ok: false, error: 'method_not_allowed' });
    }
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return jsonResponse(req, 400, { ok: false, error: 'invalid_request' });
    }

    // Verify before persisting: a rejected or unverifiable key never
    // overwrites a working one.
    const outcome = await validateKey(parsed.data.api_key);
    if (outcome.kind === 'bad_key') {
      return jsonResponse(req, 422, { ok: false, error: 'bad_key' });
    }
    if (outcome.kind === 'upstream') {
      return jsonResponse(req, 502, { ok: false, error: 'upstream' });
    }

    const encrypted = await encrypt(parsed.data.api_key);
    await updateSettings(userId, {
      ai_api_key_encrypted: bufferToBytea(encrypted),
      ai_status: 'ok',
      ai_api_key: null, // retire any legacy plaintext copy
    });
    return jsonResponse(req, 200, { ok: true });
  }),
};

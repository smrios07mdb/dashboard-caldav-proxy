import { getEncryptedAiKey, requestTriage, TriageBody } from '../_lib/ai.js';
import { decrypt } from '../_lib/crypto.js';
import { calendarRoute, jsonResponse } from '../_lib/http.js';
import { byteaToBuffer, updateSettings } from '../_lib/supabase.js';

/** Resolve the caller's Anthropic key: the decrypted stored key, or null. */
async function resolveKey(userId: string): Promise<string | null> {
  const stored = await getEncryptedAiKey(userId);
  return stored ? decrypt(byteaToBuffer(stored)) : null;
}

export default {
  fetch: calendarRoute(async (req, userId) => {
    if (req.method !== 'POST') {
      return jsonResponse(req, 405, { ok: false, error: 'method_not_allowed' });
    }
    const parsed = TriageBody.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return jsonResponse(req, 400, { ok: false, error: 'invalid_request' });
    }

    const apiKey = await resolveKey(userId);
    if (!apiKey) {
      return jsonResponse(req, 412, { ok: false, error: 'missing_key' });
    }

    const outcome = await requestTriage(apiKey, parsed.data);
    if (outcome.kind === 'bad_key') {
      await updateSettings(userId, { ai_status: 'auth_failed' });
      return jsonResponse(req, 422, { ok: false, error: 'bad_key' });
    }
    if (outcome.kind === 'upstream') {
      return jsonResponse(req, 502, { ok: false, error: 'upstream' });
    }
    return jsonResponse(req, 200, { ok: true, data: outcome.data });
  }),
};

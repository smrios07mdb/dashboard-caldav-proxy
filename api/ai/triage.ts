import { getEncryptedAiKey, getLegacyAiKey, requestTriage, TriageBody } from '../_lib/ai.js';
import { decrypt, encrypt } from '../_lib/crypto.js';
import { calendarRoute, jsonResponse } from '../_lib/http.js';
import { bufferToBytea, byteaToBuffer, updateSettings } from '../_lib/supabase.js';

/**
 * Resolve the caller's Anthropic key. Prefers the encrypted column; if it is
 * empty and a legacy plaintext `ai_api_key` exists, migrates it in place
 * (chunk 55 D5) so the operator never has to re-paste a key Anthropic's
 * console will not show again.
 */
async function resolveKey(userId: string): Promise<string | null> {
  const stored = await getEncryptedAiKey(userId);
  if (stored) return decrypt(byteaToBuffer(stored));

  const legacy = await getLegacyAiKey(userId);
  if (!legacy) return null;
  await updateSettings(userId, {
    ai_api_key_encrypted: bufferToBytea(await encrypt(legacy)),
    ai_status: 'ok',
    ai_api_key: null,
  });
  return legacy;
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

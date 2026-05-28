import { requireUser, UnauthorizedError } from './auth';
import { CalDavError } from './caldav';
import { updateSettings } from './supabase';

// Scheme+host origins only (no path). Browsers send the bare origin in `Origin`,
// so exact matching against this allowlist is correct. Never reflect `*`.
const FALLBACK_ORIGINS = ['http://localhost:5173'];

function allowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw) return FALLBACK_ORIGINS;
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin');
  const headers: Record<string, string> = { Vary: 'Origin' };
  if (origin && allowedOrigins().includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
    headers['Access-Control-Max-Age'] = '86400';
  }
  return headers;
}

export function jsonResponse(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(req) },
  });
}

type CalendarHandler = (req: Request, userId: string) => Promise<Response>;

/**
 * Wrap a /api/calendar/* handler with CORS preflight, JWT auth (401 on failure),
 * and a top-level catch that returns 500 without leaking internals. Endpoint
 * outcomes (CalDavError, 412, validation) are handled inside the handler.
 */
export function calendarRoute(handler: CalendarHandler): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }
    try {
      const { userId } = await requireUser(req);
      return await handler(req, userId);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        return jsonResponse(req, 401, { ok: false, error: 'unauthorized' });
      }
      console.error('calendar route error:', err);
      return jsonResponse(req, 500, { ok: false, error: 'internal' });
    }
  };
}

/**
 * Shared mapping for CalDAV failures on endpoints that operate on *stored*
 * credentials (busy, events): an auth failure flips caldav_status so the
 * dashboard shows the reconnect banner (ARCH §7). Non-CalDavErrors are rethrown
 * for the route wrapper to turn into a 500.
 */
export async function caldavErrorResponse(
  req: Request,
  userId: string,
  err: unknown,
): Promise<Response> {
  if (err instanceof CalDavError) {
    if (err.kind === 'auth') {
      await updateSettings(userId, { caldav_status: 'auth_failed' });
      return jsonResponse(req, 401, { ok: false, error: 'auth_failed' });
    }
    return jsonResponse(req, 502, { ok: false, error: err.kind });
  }
  throw err;
}

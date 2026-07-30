import { z } from 'zod';
import { CalDavError, getBusy } from '../_lib/caldav.js';
import { decrypt } from '../_lib/crypto.js';
import { caldavErrorResponse, calendarRoute, jsonResponse } from '../_lib/http.js';
import { fetchIcsFeed, IcsError, parseIcsBusy, type OutlookBusyInterval } from '../_lib/ics.js';
import { byteaToBuffer, getSettings, updateSettings } from '../_lib/supabase.js';

const Query = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});

interface TaggedInterval {
  start: string;
  end: string;
  source: 'icloud' | 'outlook';
  title?: string;
}

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
    const { from, to } = query.data;

    const settings = await getSettings(userId);
    const icloudCreds =
      settings?.caldav_apple_id &&
      settings.caldav_app_password_encrypted &&
      settings.caldav_calendar_url
        ? {
            appleId: settings.caldav_apple_id,
            passwordEncrypted: settings.caldav_app_password_encrypted,
            calendarUrl: settings.caldav_calendar_url,
          }
        : null;
    const outlookUrlEncrypted = settings?.outlook_ics_url_encrypted ?? null;

    // One configured source is enough to serve busy (412 only when neither is).
    if (!icloudCreds && !outlookUrlEncrypted) {
      return jsonResponse(req, 412, { ok: false, error: 'no_credentials' });
    }

    const merged: TaggedInterval[] = [];

    // ── iCloud ───────────────────────────────────────────────────────────────
    let icloudOk = Boolean(icloudCreds);
    if (icloudCreds) {
      const password = await decrypt(byteaToBuffer(icloudCreds.passwordEncrypted));
      try {
        const intervals = await getBusy(
          icloudCreds.calendarUrl,
          icloudCreds.appleId,
          password,
          from,
          to,
        );
        merged.push(...intervals.map((i) => ({ ...i, source: 'icloud' as const })));
      } catch (err) {
        // iCloud-only: keep the legacy contract (401 auth_failed / 502) that
        // existing clients key off. With Outlook configured, one dead source
        // must not fail the merged response — but an auth failure still flips
        // caldav_status so the dashboard's reconnect banner appears.
        if (!outlookUrlEncrypted) return caldavErrorResponse(req, userId, err);
        if (!(err instanceof CalDavError)) throw err;
        icloudOk = false;
        if (err.kind === 'auth') {
          await updateSettings(userId, { caldav_status: 'auth_failed' });
        }
      }
    }

    // ── Outlook ──────────────────────────────────────────────────────────────
    let outlookStatus: 'ok' | 'stale' | 'unconfigured' = 'unconfigured';
    let outlookFetchedAt: string | null = null;
    if (outlookUrlEncrypted) {
      const icsUrl = await decrypt(byteaToBuffer(outlookUrlEncrypted));
      try {
        const feed = await fetchIcsFeed(icsUrl);
        const intervals = parseIcsBusy(feed.raw, from, to);
        outlookFetchedAt = new Date().toISOString();
        outlookStatus = 'ok';
        await updateSettings(userId, {
          outlook_cached_busy: intervals,
          outlook_fetched_at: outlookFetchedAt,
          outlook_status: 'ok',
        });
        merged.push(...intervals.map((i) => ({ ...i, source: 'outlook' as const })));
      } catch (err) {
        if (!(err instanceof IcsError)) throw err;
        // Stale fallback: any feed failure serves the last-good parse
        // (filtered to the window; absent cache → empty but still 'stale').
        outlookStatus = 'stale';
        outlookFetchedAt = settings?.outlook_fetched_at ?? null;
        await updateSettings(userId, { outlook_status: 'unreachable' });
        const cached = filterCachedBusy(settings?.outlook_cached_busy, from, to);
        merged.push(...cached.map((i) => ({ ...i, source: 'outlook' as const })));
      }
    }

    // Sorted by start; overlaps across sources stay distinct (client renders
    // them per-source — never coalesce here).
    merged.sort((a, b) => a.start.localeCompare(b.start));
    return jsonResponse(req, 200, {
      ok: true,
      busy: merged,
      sources: {
        icloud: { configured: Boolean(icloudCreds), ok: icloudOk },
        outlook: {
          configured: Boolean(outlookUrlEncrypted),
          status: outlookStatus,
          fetchedAt: outlookFetchedAt,
          feedName: outlookUrlEncrypted ? (settings?.outlook_feed_name ?? null) : null,
        },
      },
    });
  }),
};

/** Validate the cached jsonb parse and keep intervals overlapping [from, to). */
function filterCachedBusy(cached: unknown, from: string, to: string): OutlookBusyInterval[] {
  if (!Array.isArray(cached)) return [];
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const out: OutlookBusyInterval[] = [];
  for (const item of cached) {
    if (typeof item !== 'object' || item === null) continue;
    const { start, end, title } = item as Record<string, unknown>;
    if (typeof start !== 'string' || typeof end !== 'string') continue;
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    if (!(startMs < toMs && endMs > fromMs)) continue;
    out.push({ start, end, ...(typeof title === 'string' ? { title } : {}) });
  }
  return out;
}

// Outlook published-calendar ICS: fetch + parse + recurrence expansion.
// Read-only counterpart to _lib/caldav.ts — same normalized-error philosophy
// (tight buckets; a false-positive hard failure is worse than a false-negative).
import ical, { type CalendarResponse, type VEvent } from 'node-ical';

const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
// Per-event ceiling on expanded recurrence instances (defense against
// pathological RRULEs like FREQ=SECONDLY over a wide window).
const INSTANCE_CAP = 1000;

export type IcsErrorKind = 'invalid_url' | 'unreachable' | 'invalid_feed';

/**
 * Normalized error. `kind` drives endpoint behavior: 'unreachable' (and any
 * other busy-time failure) triggers the stale-cache fallback; on save/verify
 * the kind is surfaced verbatim in a 422.
 */
export class IcsError extends Error {
  readonly kind: IcsErrorKind;
  constructor(kind: IcsErrorKind, message: string) {
    super(message);
    this.name = 'IcsError';
    this.kind = kind;
  }
}

export interface OutlookBusyInterval {
  start: string; // ISO UTC
  end: string; // ISO UTC
  title?: string; // SUMMARY, if present
}

/**
 * The ICS URL is user-supplied and fetched server-side, so it is an SSRF
 * surface. String-level checks only (no DNS pre-resolution, per spec):
 * https-only, and no literal-IP / localhost / .local hosts. Rejecting every
 * hostname without a letter also kills decimal/octal/hex IP encodings
 * (e.g. `2130706433`, `0x7f000001`) that would dodge a dotted-quad regex.
 */
function assertSafeIcsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new IcsError('invalid_url', 'not a valid URL');
  }
  if (url.protocol !== 'https:') {
    throw new IcsError('invalid_url', 'ICS feed URL must be https');
  }
  const host = url.hostname.toLowerCase();
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.startsWith('[') || // IPv6 literal
    host.includes(':') || // IPv6 literal (unbracketed form)
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || // IPv4 literal (covers RFC-1918, loopback, link-local)
    !/[a-z]/.test(host) // numeric-only host: alternate IP encodings
  ) {
    throw new IcsError('invalid_url', 'ICS feed host is not allowed');
  }
  return url;
}

/**
 * Fetch an ICS feed with a 10s deadline, a 2 MB size cap, and manual redirect
 * handling so every hop passes the same SSRF checks (no redirect to non-https
 * or to an internal host). `feedName` comes from X-WR-CALNAME when present.
 */
export async function fetchIcsFeed(url: string): Promise<{ raw: string; feedName: string | null }> {
  let target = assertSafeIcsUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    for (let hop = 0; ; hop++) {
      let res: Response;
      try {
        res = await fetch(target, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { accept: 'text/calendar, */*' },
        });
      } catch (err) {
        throw new IcsError('unreachable', err instanceof Error ? err.message : String(err));
      }

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location || hop >= MAX_REDIRECTS) {
          throw new IcsError('unreachable', 'too many redirects');
        }
        let next: URL;
        try {
          next = new URL(location, target);
        } catch {
          throw new IcsError('unreachable', 'invalid redirect target');
        }
        try {
          target = assertSafeIcsUrl(next.toString());
        } catch {
          // Redirect landed somewhere we refuse to fetch (http://, internal
          // host). The user's URL itself was fine → this is a feed problem.
          throw new IcsError('unreachable', 'redirect to a disallowed target');
        }
        continue;
      }

      if (!res.ok) {
        throw new IcsError('unreachable', `HTTP ${res.status}`);
      }

      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
        throw new IcsError('invalid_feed', 'response exceeds 2 MB cap');
      }
      const raw = await readBodyCapped(res, controller);
      if (!raw.includes('BEGIN:VCALENDAR')) {
        throw new IcsError('invalid_feed', 'response is not an iCalendar feed');
      }
      return { raw, feedName: extractFeedName(raw) };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Stream the body counting bytes; bail with 'invalid_feed' past the 2 MB cap. */
async function readBodyCapped(res: Response, controller: AbortController): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        controller.abort();
        throw new IcsError('invalid_feed', 'response exceeds 2 MB cap');
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch (err) {
    if (err instanceof IcsError) throw err;
    // Aborted mid-body (deadline) or transport reset.
    throw new IcsError('unreachable', err instanceof Error ? err.message : String(err));
  }
  return text + decoder.decode();
}

function extractFeedName(raw: string): string | null {
  // Unfold RFC 5545 continuation lines, then take X-WR-CALNAME's value.
  const unfolded = raw.replace(/\r?\n[ \t]/g, '');
  const match = /^X-WR-CALNAME[^:\r\n]*:(.*)$/im.exec(unfolded);
  if (!match?.[1]) return null;
  const name = match[1]
    .trim()
    .replace(/\\n/gi, ' ')
    .replace(/\\([\\;,])/g, '$1');
  return name || null;
}

/**
 * Expand an ICS payload into busy intervals overlapping `[from, to)`.
 *
 * node-ical's `expandRecurringEvent` does the genuinely hard parts —
 * VTIMEZONE/TZID → UTC conversion, RRULE expansion, EXDATE exclusion, and
 * RECURRENCE-ID overrides replacing their base instance — and handles
 * non-recurring events as single instances, so every VEVENT goes through the
 * same path. `expandOngoing: true` gives overlap (not starts-within) semantics.
 */
export function parseIcsBusy(raw: string, from: string, to: string): OutlookBusyInterval[] {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return [];

  let parsed: CalendarResponse;
  try {
    parsed = ical.sync.parseICS(raw);
  } catch (err) {
    throw new IcsError('invalid_feed', err instanceof Error ? err.message : String(err));
  }

  const out: OutlookBusyInterval[] = [];
  for (const component of Object.values(parsed)) {
    if (!isVEvent(component)) continue;
    const event = component;

    let instances: ReturnType<typeof ical.expandRecurringEvent>;
    try {
      instances = ical.expandRecurringEvent(event, {
        from: new Date(fromMs),
        to: new Date(toMs),
        expandOngoing: true,
      });
    } catch {
      // rrule-temporal throws past 10k iterations instead of truncating; a
      // rule that pathological contributes nothing rather than failing the
      // whole feed (silent truncation, per spec).
      continue;
    }
    if (instances.length > INSTANCE_CAP) instances = instances.slice(0, INSTANCE_CAP);

    for (const instance of instances) {
      // `instance.event` is the base VEVENT or the RECURRENCE-ID override —
      // checking it (not the parent) also drops cancelled single instances.
      if (instance.event.status === 'CANCELLED') continue;
      if (instance.event.transparency === 'TRANSPARENT') continue;

      let startMs = instance.start.getTime();
      let endMs = (instance.end ?? instance.start).getTime();
      if (instance.isFullDay) {
        // node-ical materializes DATE values at server-local midnight;
        // normalize to UTC midnight (same convention as caldav.ts icalToIso).
        startMs = localDateToUtcMidnight(instance.start);
        endMs = localDateToUtcMidnight(instance.end ?? instance.start);
      }
      if (!(startMs < toMs && endMs > fromMs)) continue;

      const title = summaryText(instance.summary ?? instance.event.summary);
      out.push({
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
        ...(title !== undefined ? { title } : {}),
      });
    }
  }

  out.sort((a, b) => a.start.localeCompare(b.start));
  return out;
}

function isVEvent(component: unknown): component is VEvent {
  return (
    typeof component === 'object' &&
    component !== null &&
    'type' in component &&
    (component as { type: unknown }).type === 'VEVENT'
  );
}

function localDateToUtcMidnight(d: Date): number {
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

/** SUMMARY is a node-ical ParameterValue: a string, or `{ params, val }`. */
function summaryText(summary: unknown): string | undefined {
  const value =
    typeof summary === 'object' && summary !== null && 'val' in summary
      ? (summary as { val: unknown }).val
      : summary;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

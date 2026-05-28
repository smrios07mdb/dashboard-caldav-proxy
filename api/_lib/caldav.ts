// tsdav loaded via the local _lib/tsdav.ts wrapper (createRequire — see
// that file for why). Importing from the wrapper rather than 'tsdav' directly
// also makes vitest's vi.mock hook in normally.
import {
  createCalendarObject,
  createDAVClient,
  fetchCalendarObjects,
  getBasicAuthHeaders,
  type DAVCalendar,
} from './tsdav.js';

const ICLOUD_CALDAV_URL = 'https://caldav.icloud.com/';

export type CalDavErrorKind = 'auth' | 'network' | 'other';

/** Normalized error. `kind` drives endpoint behavior (auth → caldav_status='auth_failed'). */
export class CalDavError extends Error {
  readonly kind: CalDavErrorKind;
  constructor(kind: CalDavErrorKind, message: string) {
    super(message);
    this.name = 'CalDavError';
    this.kind = kind;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTRIBUTION POINT — implement this.
//
// Map a raw thrown value into a CalDavError with the right `kind`. This is the
// one piece of genuine policy in this module: `kind: 'auth'` is what flips
// `caldav_status = 'auth_failed'` and surfaces the dashboard's "Reconnect Apple
// Calendar" banner, so the auth/network/other boundary is a real product call.
//
// What the inputs actually look like (verified against tsdav 2.2.2 source):
//   • Bad iCloud credentials → Error whose .message contains "401" / "Unauthorized"
//     (e.g. "Invalid credentials: PROPFIND ... returned 401 Unauthorized",
//      "Collection query failed: 401 Unauthorized").
//   • createEvent on a non-2xx → we synthesize new Error(`CalDAV request failed: <status>`).
//   • Transport failure → TypeError("fetch failed"), or an Error whose .code is one of
//     ECONNREFUSED / ENOTFOUND / ETIMEDOUT / EAI_AGAIN.
//   • Everything else (e.g. "Collection query failed: 500 ...") → 'other'.
//
// Contract: a false-positive 'auth' is worse than a false-negative. Wrongly
// tagging a transient failure as 'auth' nags the user to re-enter a password
// that already works (it flips caldav_status='auth_failed' + shows the reconnect
// banner, ARCH §7). So the 'auth' bucket stays tight — an explicit 401 only;
// 403/429/5xx and anything unrecognized fall through to 'other'. (If production
// data later shows iCloud 403s correlate with bad app-specific passwords, widen
// 'auth' in a follow-up — don't pre-optimize for it here.)
// ─────────────────────────────────────────────────────────────────────────────
export function classifyError(err: unknown): CalDavError {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code: unknown }).code)
      : '';

  // Only an explicit 401 / Unauthorized is treated as an auth failure.
  if (/\b401\b/.test(message) || /unauthorized/i.test(message)) {
    return new CalDavError('auth', message);
  }

  // Transport-level failures only — never an HTTP status code.
  const NETWORK_CODES = ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN'];
  if (
    (err instanceof TypeError && /fetch failed/i.test(message)) ||
    NETWORK_CODES.some((c) => code === c || message.includes(c))
  ) {
    return new CalDavError('network', message);
  }

  return new CalDavError('other', message);
}

export interface DiscoveredCalendar {
  url: string;
  name: string;
}

export async function discover(
  appleId: string,
  password: string,
): Promise<{ calendars: DiscoveredCalendar[] }> {
  try {
    const client = await createDAVClient({
      serverUrl: ICLOUD_CALDAV_URL,
      credentials: { username: appleId, password },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
    });
    const calendars = await client.fetchCalendars();
    return {
      calendars: calendars
        .filter((c) => !c.components || c.components.includes('VEVENT'))
        .map((c) => ({ url: c.url, name: calendarName(c) })),
    };
  } catch (err) {
    throw classifyError(err);
  }
}

export interface BusyInterval {
  start: string;
  end: string;
}

export async function getBusy(
  calendarUrl: string,
  appleId: string,
  password: string,
  from: string,
  to: string,
): Promise<BusyInterval[]> {
  try {
    const headers = getBasicAuthHeaders({ username: appleId, password });
    const objects = await fetchCalendarObjects({
      calendar: { url: calendarUrl },
      timeRange: { start: from, end: to },
      expand: true,
      headers,
    });
    return objects.flatMap((o) => parseEventIntervals(typeof o.data === 'string' ? o.data : ''));
  } catch (err) {
    throw classifyError(err);
  }
}

export interface NewEvent {
  title: string;
  start: string;
  end: string;
  description?: string;
  uid: string;
}

export async function createEvent(
  calendarUrl: string,
  appleId: string,
  password: string,
  event: NewEvent,
): Promise<void> {
  const headers = getBasicAuthHeaders({ username: appleId, password });

  let res: Response;
  try {
    res = await createCalendarObject({
      calendar: { url: calendarUrl },
      iCalString: buildVEvent(event),
      filename: `${event.uid}.ics`,
      headers,
    });
  } catch (err) {
    throw classifyError(err);
  }

  if (!res.ok) {
    throw classifyError(new Error(`CalDAV request failed: ${res.status}`));
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function calendarName(c: DAVCalendar): string {
  const dn = c.displayName;
  return typeof dn === 'string' && dn.trim() ? dn : c.url;
}

/** Pull busy {start,end} intervals out of an iCalendar payload (VEVENT blocks). */
function parseEventIntervals(ical: string): BusyInterval[] {
  if (!ical) return [];
  const intervals: BusyInterval[] = [];
  let inEvent = false;
  let start: string | null = null;
  let end: string | null = null;

  for (const line of ical.split(/\r?\n/)) {
    if (line.startsWith('BEGIN:VEVENT')) {
      inEvent = true;
      start = null;
      end = null;
    } else if (line.startsWith('END:VEVENT')) {
      if (start && end) intervals.push({ start, end });
      inEvent = false;
    } else if (inEvent && line.startsWith('DTSTART')) {
      start = icalToIso(valueOf(line));
    } else if (inEvent && line.startsWith('DTEND')) {
      end = icalToIso(valueOf(line));
    }
  }
  return intervals;
}

function valueOf(line: string): string {
  const idx = line.indexOf(':');
  return idx === -1 ? '' : line.slice(idx + 1).trim();
}

/**
 * Convert an iCal date/date-time to an ISO string. With `expand: true` iCloud
 * returns UTC instances, so Z/non-Z date-times are read as UTC; bare DATE values
 * (all-day) become UTC midnight. TZID-qualified floating times are approximated
 * as UTC — acceptable for an at-a-glance busy strip.
 */
function icalToIso(raw: string): string | null {
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))).toISOString();
  }
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(raw);
  if (dt) {
    const [, y, mo, d, h, mi, s] = dt;
    return new Date(
      Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)),
    ).toISOString();
  }
  return null;
}

function buildVEvent(e: NewEvent): string {
  const toICalUtc = (iso: string): string =>
    new Date(iso)
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}Z$/, 'Z');
  const esc = (s: string): string =>
    s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//dashboard-caldav-proxy//EN',
    'BEGIN:VEVENT',
    `UID:${e.uid}`,
    `DTSTAMP:${toICalUtc(new Date().toISOString())}`,
    `DTSTART:${toICalUtc(e.start)}`,
    `DTEND:${toICalUtc(e.end)}`,
    `SUMMARY:${esc(e.title)}`,
  ];
  if (e.description) lines.push(`DESCRIPTION:${esc(e.description)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}

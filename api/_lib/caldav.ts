// tsdav loaded via the local _lib/tsdav.ts wrapper (createRequire — see
// that file for why). Importing from the wrapper rather than 'tsdav' directly
// also makes vitest's vi.mock hook in normally.
import {
  createCalendarObject,
  createDAVClient,
  deleteCalendarObject,
  fetchCalendarObjects,
  getBasicAuthHeaders,
  updateCalendarObject,
  type DAVCalendar,
} from './tsdav.js';
import { expandCalendarBusy } from './busyExpand.js';

const ICLOUD_CALDAV_URL = 'https://caldav.icloud.com/';

/**
 * UID prefix that tags a VEVENT as a Week Planner block mirror (chunk 39).
 * Objects carrying it are excluded from busy intervals and reported via
 * `plannerEvents` instead, so the planner never counts a block twice (once
 * as scheduled, once as busy). The chunk-13 Block Time sheet keeps plain
 * UUIDs and stays busy.
 */
export const PLANNER_UID_PREFIX = 'hupo-block-';

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
  title?: string;
}

/** A planner-block mirror found on the calendar (first expanded instance). */
export interface PlannerEvent {
  uid: string;
  start: string;
  end: string;
}

export interface BusyResult {
  intervals: BusyInterval[];
  plannerEvents: PlannerEvent[];
}

const PLANNER_UID_RE = /^UID:(hupo-block-[A-Za-z0-9-]+)\s*$/m;

export async function getBusy(
  calendarUrl: string,
  appleId: string,
  password: string,
  from: string,
  to: string,
): Promise<BusyResult> {
  let objects;
  try {
    const headers = getBasicAuthHeaders({ username: appleId, password });
    // No `expand: true`: tsdav re-fetches object data via calendar-multiget,
    // which returns the raw unexpanded master VEVENT (DTSTART;TZID + RRULE
    // intact) regardless of the expand flag. Expansion happens locally in
    // expandCalendarBusy — one deterministic path shared with the ICS source.
    objects = await fetchCalendarObjects({
      calendar: { url: calendarUrl },
      timeRange: { start: from, end: to },
      headers,
    });
  } catch (err) {
    throw classifyError(err);
  }

  const intervals: BusyInterval[] = [];
  const plannerEvents: PlannerEvent[] = [];
  for (const o of objects) {
    if (typeof o.data !== 'string' || !o.data) continue;
    try {
      const expanded = expandCalendarBusy(o.data, from, to);
      const planner = PLANNER_UID_RE.exec(o.data);
      if (planner) {
        // A planner mirror: not busy (the client already counts the block as
        // scheduled); reported on the side so the app can reconcile orphans
        // and time drift. Non-recurring by construction — first instance.
        const first = expanded[0];
        const uid = planner[1];
        if (first && uid) plannerEvents.push({ uid, start: first.start, end: first.end });
        continue;
      }
      intervals.push(...expanded);
    } catch {
      // One unparseable object contributes nothing rather than failing the
      // whole busy response (mirrors the ICS path's pathological-RRULE stance).
      continue;
    }
  }
  intervals.sort((a, b) => a.start.localeCompare(b.start));
  plannerEvents.sort((a, b) => a.start.localeCompare(b.start));
  return { intervals, plannerEvents };
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

/**
 * Overwrite the VEVENT at `<calendarUrl><uid>.ics` (chunk 39). The whole
 * object is rebuilt from `event` — the old one is never read — and the PUT
 * is unconditional (no etag / If-Match): `scheduled_blocks` is the source of
 * truth and the calendar copy is a mirror, so last-writer-wins is the point.
 */
export async function updateEvent(
  calendarUrl: string,
  appleId: string,
  password: string,
  event: NewEvent,
): Promise<void> {
  const headers = getBasicAuthHeaders({ username: appleId, password });

  let res: Response;
  try {
    // objectUrl is inside the try: a malformed stored calendar_url classifies
    // as 'other' (502) rather than escaping as a raw TypeError (500).
    res = await updateCalendarObject({
      calendarObject: { url: objectUrl(calendarUrl, event.uid), data: buildVEvent(event) },
      headers,
    });
  } catch (err) {
    throw classifyError(err);
  }

  if (!res.ok) {
    throw classifyError(new Error(`CalDAV request failed: ${res.status}`));
  }
}

/**
 * Delete the VEVENT at `<calendarUrl><uid>.ics` (chunk 39). Idempotent: an
 * upstream 404 resolves `{ missing: true }` rather than throwing, so a retry
 * (or a reconcile racing a user delete) is a no-op instead of an error.
 */
export async function deleteEvent(
  calendarUrl: string,
  appleId: string,
  password: string,
  uid: string,
): Promise<{ missing: boolean }> {
  const headers = getBasicAuthHeaders({ username: appleId, password });

  let res: Response;
  try {
    res = await deleteCalendarObject({
      calendarObject: { url: objectUrl(calendarUrl, uid) },
      headers,
    });
  } catch (err) {
    throw classifyError(err);
  }

  if (res.status === 404) return { missing: true };
  if (!res.ok) {
    throw classifyError(new Error(`CalDAV request failed: ${res.status}`));
  }
  return { missing: false };
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * The object URL for a uid, built exactly the way tsdav's
 * `createCalendarObject` resolves `filename` against `calendar.url`
 * (`new URL(filename, calendar.url)`), so update/delete address the same
 * resource create wrote — including the same trailing-slash behavior.
 */
function objectUrl(calendarUrl: string, uid: string): string {
  return new URL(`${uid}.ics`, calendarUrl).href;
}

function calendarName(c: DAVCalendar): string {
  const dn = c.displayName;
  return typeof dn === 'string' && dn.trim() ? dn : c.url;
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

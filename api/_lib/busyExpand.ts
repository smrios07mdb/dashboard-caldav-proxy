// Shared busy-interval expansion for both calendar sources (iCloud CalDAV
// objects and the Outlook published-ICS feed). One iCalendar payload in,
// UTC busy intervals overlapping the window out.
import ical, { type CalendarResponse, type VEvent } from 'node-ical';

// Per-event ceiling on expanded recurrence instances (defense against
// pathological RRULEs like FREQ=SECONDLY over a wide window).
const INSTANCE_CAP = 1000;

export interface ExpandedBusyInterval {
  start: string; // ISO UTC
  end: string; // ISO UTC
  title?: string; // SUMMARY, if present
}

/**
 * Expand one iCalendar payload (VCALENDAR) into busy intervals overlapping
 * `[from, to)`, sorted by start.
 *
 * node-ical's `expandRecurringEvent` does the genuinely hard parts —
 * VTIMEZONE/TZID → UTC conversion, RRULE expansion, EXDATE exclusion, and
 * RECURRENCE-ID overrides replacing their base instance — and handles
 * non-recurring events as single instances, so every VEVENT goes through the
 * same path. `expandOngoing: true` gives overlap (not starts-within) semantics.
 *
 * Floating date-times (no TZID, no Z) parse as UTC — node-ical's default;
 * rare in practice, and we deliberately don't infer a timezone for them.
 *
 * All-day events (DATE values) are excluded: a birthday or "Rent Due" doesn't
 * consume schedulable time, and including it would zero out a whole day's free
 * capacity in the planner.
 *
 * Parse failures propagate as raw errors — callers decide whether one bad
 * payload fails the response (ICS feed) or is skipped (per CalDAV object).
 */
export function expandCalendarBusy(
  raw: string,
  from: string,
  to: string,
): ExpandedBusyInterval[] {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return [];

  const parsed: CalendarResponse = ical.sync.parseICS(raw);

  const out: ExpandedBusyInterval[] = [];
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
      // whole payload (silent truncation, per spec).
      continue;
    }
    if (instances.length > INSTANCE_CAP) instances = instances.slice(0, INSTANCE_CAP);

    for (const instance of instances) {
      // `instance.event` is the base VEVENT or the RECURRENCE-ID override —
      // checking it (not the parent) also drops cancelled single instances.
      if (instance.event.status === 'CANCELLED') continue;
      if (instance.event.transparency === 'TRANSPARENT') continue;
      if (instance.isFullDay) continue;

      const startMs = instance.start.getTime();
      const endMs = (instance.end ?? instance.start).getTime();
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

/** SUMMARY is a node-ical ParameterValue: a string, or `{ params, val }`. */
function summaryText(summary: unknown): string | undefined {
  const value =
    typeof summary === 'object' && summary !== null && 'val' in summary
      ? (summary as { val: unknown }).val
      : summary;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

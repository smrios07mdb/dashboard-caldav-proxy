/**
 * The iCloud READ set (chunk 51, ARCHITECTURE.md §7): which of the account's
 * event calendars `/busy` reads. Stored in `settings.caldav_read_calendars`
 * (jsonb) as `[{ url, name, enabled }]`; `caldav_calendar_url` stays the
 * single WRITE target for planner mirrors and is unaffected by this set.
 *
 * `null` means "not initialized" — every pre-chunk-51 row, and any row after
 * a credential re-save — and the busy endpoint falls back to the legacy
 * single-calendar read (the write target only). The app initializes the set
 * to all-discovered / all-enabled on first Planner mount.
 */
export interface ReadCalendar {
  url: string;
  name: string;
  enabled: boolean;
}

/**
 * Validate the stored jsonb. Returns `null` for null / non-array / anything
 * that isn't a usable set; malformed entries are dropped and duplicate urls
 * collapse to the first occurrence. Never throws — a corrupt column must
 * degrade to legacy behaviour, not 500 the busy endpoint.
 */
export function parseReadCalendars(v: unknown): ReadCalendar[] | null {
  if (!Array.isArray(v)) return null;
  const out: ReadCalendar[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    if (typeof item !== 'object' || item === null) continue;
    const { url, name, enabled } = item as Record<string, unknown>;
    if (typeof url !== 'string' || !url) continue;
    if (typeof enabled !== 'boolean') continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, name: typeof name === 'string' ? name : '', enabled });
  }
  return out;
}

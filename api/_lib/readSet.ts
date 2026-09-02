/**
 * The iCloud READ set (chunk 51, ARCHITECTURE.md §7): which of the account's
 * event calendars `/busy` reads. Stored in `settings.caldav_read_calendars`
 * (jsonb) as `[{ url, name, enabled, color? }]`; `caldav_calendar_url` stays the
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
  /** `#rrggbb` from iCloud's `calendar-color` (chunk 51b), when it had one.
   *  Tagged onto every busy interval of this calendar so the app can tint
   *  per calendar. Absent → the app assigns a palette color. */
  color?: string;
}

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

/**
 * Normalize an iCloud `calendar-color` value to `#rrggbb`. iCloud answers
 * `#RRGGBBAA` (alpha suffix, always FF in practice); anything that isn't a
 * 6- or 8-digit hex string is dropped rather than passed through.
 */
export function normalizeColor(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  const m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(t);
  return m ? `#${m[1]!.toLowerCase()}` : undefined;
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
    const { url, name, enabled, color } = item as Record<string, unknown>;
    if (typeof url !== 'string' || !url) continue;
    if (typeof enabled !== 'boolean') continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const entry: ReadCalendar = { url, name: typeof name === 'string' ? name : '', enabled };
    if (typeof color === 'string' && HEX_COLOR_RE.test(color)) entry.color = color.toLowerCase();
    out.push(entry);
  }
  return out;
}

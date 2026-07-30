import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Service-role client: bypasses RLS, so EVERY query here must be scoped to the
// caller's verified user id (the JWT `sub`). Never trust a user id from a body.
let client: SupabaseClient | undefined;

export function getClient(): SupabaseClient {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
    }
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

export interface CalDavSettings {
  caldav_apple_id: string | null;
  // `bytea` column. PostgREST surfaces it as a `\x`-prefixed hex string.
  caldav_app_password_encrypted: string | null;
  caldav_calendar_url: string | null;
  caldav_status: string | null;
  // Outlook published-calendar ICS feed (read-only source).
  outlook_ics_url_encrypted: string | null; // bytea, same `\x`-hex transport
  outlook_feed_name: string | null;
  outlook_status: string | null; // 'unconfigured' | 'ok' | 'unreachable'
  outlook_cached_busy: unknown; // jsonb: last-good parse, OutlookBusyInterval[]
  outlook_fetched_at: string | null;
}

const CALDAV_COLUMNS =
  'caldav_apple_id, caldav_app_password_encrypted, caldav_calendar_url, caldav_status, ' +
  'outlook_ics_url_encrypted, outlook_feed_name, outlook_status, outlook_cached_busy, outlook_fetched_at';

export async function getSettings(userId: string): Promise<CalDavSettings | null> {
  const { data, error } = await getClient()
    .from('settings')
    .select(CALDAV_COLUMNS)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    throw new Error(`failed to load settings: ${error.message ?? String(error)}`);
  }
  return (data as CalDavSettings | null) ?? null;
}

export async function updateSettings(
  userId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  // Defense-in-depth: strip any caller-supplied identity column so a service-role
  // write can never be redirected to another user's row.
  const { user_id: _ignored, ...safePatch } = patch;
  const { error } = await getClient().from('settings').update(safePatch).eq('user_id', userId);
  if (error) {
    throw new Error(`failed to update settings: ${error.message ?? String(error)}`);
  }
}

/** Encode raw bytes for a Postgres `bytea` column over PostgREST (hex format). */
export function bufferToBytea(buf: Buffer): string {
  return `\\x${buf.toString('hex')}`;
}

/** Decode a PostgREST `bytea` value (`\x`-hex string) back to raw bytes. */
export function byteaToBuffer(value: string): Buffer {
  const hex = value.startsWith('\\x') ? value.slice(2) : value;
  return Buffer.from(hex, 'hex');
}

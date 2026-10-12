# dashboard-caldav-proxy

Vercel serverless functions that broker calendar access for the `dashboard`
app: Apple iCloud (CalDAV, read/write) and an Outlook published-calendar ICS
feed (read-only). iCloud requires Basic auth with an app-specific password,
which a browser can't do safely (CORS + credential handling). This proxy stores
secrets **encrypted**, verifies the caller's Supabase JWT, and brokers every
upstream call. See `ARCHITECTURE.md` §7 in the main `dashboard` repo for the
canonical design.

## How it works

- **Auth** — every `/api/calendar/*` and `/api/ai/*` request must send `Authorization: Bearer <supabase-jwt>`.
  The token is verified with `jose` against the project's JWKS (asymmetric **ES256**),
  and the `sub` claim is the only trusted user id. All Supabase reads/writes are
  scoped to that `sub` (the service-role key bypasses RLS, so this scoping is the
  security boundary).
- **Credential storage** — the iCloud app-specific password is wrapped with
  **AES-256-GCM** (Node `crypto`) using `CALDAV_ENCRYPTION_KEY`, then stored in
  `settings.caldav_app_password_encrypted` (a Postgres `bytea` column).
- **On an iCloud 401** — `caldav_status` is set to `auth_failed` and the endpoint
  returns a structured error; the dashboard then shows a "Reconnect Apple Calendar" banner.

## Endpoints

All `/api/calendar/*` routes require a valid Supabase JWT and honor CORS for the
origins in `ALLOWED_ORIGINS`.

| Method & path                         | Body / query                                              | Success                                                                                   | Notable failures                                                                               |
| ------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `GET /api/health`                     | —                                                         | `{ ok: true }`                                                                            | —                                                                                              |
| `POST /api/calendar/test-credentials` | `{ apple_id, app_password }`                              | `{ ok: true, calendars: [{ url, name }] }`                                                | `401 { error: "auth" }`, `400`                                                                 |
| `POST /api/calendar/save-credentials` | `{ apple_id, app_password, calendar_url }`                | `{ ok: true }`                                                                            | `400`                                                                                          |
| `GET /api/calendar/calendars`         | —                                                         | `{ ok: true, calendars: [{ url, name }], writeTargetUrl }` (stored creds)                 | `412 { error: "no_credentials" }`, `401 { error: "auth_failed" }`                              |
| `GET /api/calendar/busy`              | `?from=<ISO>&to=<ISO>`                                    | `{ ok: true, busy: [{ start, end, source, title?, calendar? }], plannerEvents, sources }` | `412 { error: "no_credentials" }`, `401 { error: "auth_failed" }`                              |
| `POST /api/calendar/events`           | `{ title, start, end, description?, source?: 'planner' }` | `{ ok: true, uid }`                                                                       | `412`, `401 { error: "auth_failed" }`                                                          |
| `PATCH /api/calendar/events`          | `{ uid, title, start, end, description? }`                | `{ ok: true }`                                                                            | `400`, `412`, `401 { error: "auth_failed" }`                                                   |
| `DELETE /api/calendar/events?uid=…`   | —                                                         | `{ ok: true }` / `{ ok: true, missing: true }` (already gone)                             | `400`, `412`, `401 { error: "auth_failed" }`                                                   |
| `POST /api/calendar/outlook`          | `{ icsUrl: string \| null }`                              | `{ ok: true, feedName, eventCount }` / `{ ok: true, cleared: true }`                      | `422 { error: "invalid_url" \| "unreachable" \| "invalid_feed" }`, `400`                       |
| `POST /api/ai/key`                    | `{ api_key }`                                             | `{ ok: true }` (validated with Anthropic, stored encrypted)                               | `422 { error: "bad_key" }`, `502 { error: "upstream" }`, `400`                                 |
| `DELETE /api/ai/key`                  | —                                                         | `{ ok: true }`                                                                            | —                                                                                              |
| `POST /api/ai/triage`                 | `{ tasks, available_minutes, timezone }`                  | `{ ok: true, data }` (`data` = Anthropic Messages JSON, unmodified)                       | `412 { error: "missing_key" }`, `422 { error: "bad_key" }`, `502 { error: "upstream" }`, `400` |

Missing/invalid JWT → `401 { ok: false, error: "unauthorized" }`. Upstream
iCloud network/other failures → `502 { ok: false, error: "network" | "other" }`.

`busy` returns `412 no_credentials` only when **neither** source is configured;
one configured source is enough. Its `sources` key reports per-source health:

```
sources: {
  icloud:  { configured, ok, calendars: [{ url, name, ok }] },
  outlook: { configured, status: 'ok' | 'stale' | 'unconfigured', fetchedAt, feedName }
}
```

`sources.icloud.ok` is true when at least one iCloud calendar answered;
`calendars` lists every calendar the request fetched with its own outcome.
iCloud `busy` entries carry `calendar: <display name>` (absent on the legacy
single-calendar path — see "Read set vs write target" below).

## Planner block mirror (chunk 39)

The dashboard's Week Planner can mirror its scheduled blocks to the selected
iCloud calendar (opt-in, `settings.planner_writeout`). The proxy's part:

- **UID convention.** `POST /api/calendar/events` with `source: 'planner'`
  generates `uid = 'hupo-block-' + randomUUID()` (`PLANNER_UID_PREFIX` in
  `api/_lib/caldav.ts`) and defaults `DESCRIPTION` to `Planned in Hupomnemata`.
  Without `source` the endpoint is unchanged (plain UUID, counts as busy).
- **Update.** `PATCH /api/calendar/events` rebuilds the whole VEVENT from the
  body and PUTs it to `<calendar_url><uid>.ics` unconditionally (no etag /
  `If-Match`) — the old object is never read. `title`, `start`, `end` are all
  required.
- **Delete.** `DELETE /api/calendar/events?uid=…` removes the object; an
  upstream 404 answers `200 { ok: true, missing: true }` so deletes are
  idempotent.
- **`uid` validation.** `^[A-Za-z0-9-]{1,80}$` — no path characters; anything
  else is `400 invalid_request`.
- **Busy exclusion.** In `busy`, an iCloud object whose data carries a
  `UID:hupo-block-…` line is **not** expanded into `busy`; its uid and first
  expanded `[start, end]` go to the top-level `plannerEvents` array instead
  (the app already counts the block as scheduled, and uses this list to
  reconcile orphans and time drift). Outlook output is untouched;
  `plannerEvents` is `[]` when iCloud isn't configured.

## Read set vs write target (chunk 51)

The proxy reads **all** of the account's event calendars but writes to one.

- **Write target** — `settings.caldav_calendar_url`, chosen in the app's
  Settings at connect time. Every planner mirror (`POST/PATCH/DELETE
/api/calendar/events`) goes here. Unchanged by chunk 51.
- **Read set** — `settings.caldav_read_calendars` (jsonb,
  `[{ url, name, enabled }]`, parsed by `api/_lib/readSet.ts`). `busy` fans
  out across the **enabled** calendars in parallel (`Promise.allSettled`, at
  most 6 in flight) and merges the intervals, each tagged `calendar: <name>`.
  One failing calendar never fails the response — it is reported
  `ok: false` in `sources.icloud.calendars`; the request throws only when
  every calendar failed (all-auth → `401 auth_failed` + `caldav_status`
  flip, exactly as before).
- **The write target is always fetched**, even when it is disabled or absent
  from the read set: planner mirrors live there and `plannerEvents` must
  keep reporting them. A disabled write target contributes `plannerEvents`
  but no busy intervals. The `hupo-block-` exclusion runs per calendar, so a
  mirror never becomes busy on any calendar.
- **`null` read set = legacy.** Every pre-chunk-51 row is `null`, and
  `save-credentials` resets the column to `null` on every save; the proxy
  then reads the write target alone (unnamed — no `calendar` field). The app
  initializes the set to all-discovered / all-enabled on its first Planner
  mount via `GET /api/calendar/calendars`, which runs discovery with the
  **stored** credentials (no password in the request).

**Busy expansion** — both sources expand through one shared path
(`api/_lib/busyExpand.ts`, built on `node-ical`): VTIMEZONE/TZID → UTC
conversion, RRULE recurrence expansion, EXDATE, RECURRENCE-ID overrides, and
exclusion of cancelled/transparent events. iCloud objects are fetched raw and
expanded locally (tsdav's `expand` flag is unreliable — its multiget re-fetch
returns unexpanded masters). **All-day events are excluded from busy** for both
sources: a birthday or "Rent Due" doesn't consume schedulable time, and
including it would zero out a whole day's free capacity in the planner.
Floating date-times (no TZID, no `Z`) parse as UTC.

## Outlook ICS

A read-only second calendar source: the user pastes an Outlook **published
calendar** ICS URL (Outlook → Settings → Calendar → Shared calendars → Publish).

- **Storage** — the URL is a capability (anyone holding it can read the
  calendar), so it is wrapped with the same AES-256-GCM path as the iCloud
  password and stored in `settings.outlook_ics_url_encrypted` (`bytea`). It is
  never logged or returned in any response.
- **Save/verify** — `POST /api/calendar/outlook` fetches and parses the feed
  over a 7-day smoke window before persisting anything; a failed verify returns
  `422` and never overwrites a working config. `{ icsUrl: null }` disconnects
  (all outlook columns reset).
- **Freshness / stale cache** — there is no background refresh: every `busy`
  call re-fetches the feed. On success the parse is cached in
  `settings.outlook_cached_busy` (jsonb). If the feed later fails, `busy` serves
  the cached intervals filtered to the requested window and reports
  `sources.outlook.status: 'stale'` with the old `fetchedAt`, and
  `outlook_status` flips to `'unreachable'` in the DB.
- **SSRF constraints** — the feed URL is user-supplied and fetched server-side,
  so `https:` only; literal-IP hosts (any encoding), `localhost`, and `.local`
  hosts are rejected at the string level; redirects are re-validated hop by hop
  (max 3) and may not leave https; 10s timeout; 2 MB response cap.
- **Parsing** — the shared busy-expansion path (`api/_lib/busyExpand.ts`, see
  above): RRULE, EXDATE, RECURRENCE-ID overrides (an override replaces its base
  instance), VTIMEZONE/TZID → UTC conversion. Cancelled (`STATUS:CANCELLED`),
  free (`TRANSP:TRANSPARENT`), and all-day events are excluded. Expansion is
  capped at 1000 instances per event as RRULE-bomb defense.

An iCloud auth failure with Outlook configured no longer fails the whole `busy`
response: the Outlook intervals are served with `sources.icloud.ok: false`, and
`caldav_status='auth_failed'` is still recorded (reconnect banner logic is
unchanged).

## AI triage (chunk 55)

The dashboard's "What's next?" triage calls Anthropic **through this proxy**
with the user's own key. The `/api/ai/*` routes use the same wrapper as the
calendar routes (Supabase JWT, CORS, 500 without internals).

- **Key storage.** `POST /api/ai/key` validates the key against Anthropic
  (`GET /v1/models?limit=1`), AES-GCM-encrypts it with `CALDAV_ENCRYPTION_KEY`
  and writes `settings.ai_api_key_encrypted` + `ai_status = 'ok'`. A rejected
  key (`422 bad_key`) or an unreachable Anthropic (`502 upstream`) stores
  nothing. `DELETE` clears it. No response ever contains the key.
- **Triage.** `POST /api/ai/triage` takes `{ tasks: TriageTask[] (≤300),
available_minutes: 1–1440, timezone (≤64) }` with snake_case tasks
  (`task_id, title, subcategory_name, category_name, estimate_minutes, due_at,
priority`). The proxy owns the model, `MAX_TOKENS` (800) and the system
  prompt (`api/_lib/ai.ts`). An Anthropic 401/403 sets
  `ai_status = 'auth_failed'` and answers `422 bad_key`.
- **Model (chunk 57).** Triage always and only uses the latest Claude Haiku.
  Anthropic has no `-latest` alias, so `resolveHaikuModel` reads
  `GET /v1/models?limit=100` (at most 3 pages) with the
  caller's key and picks the entry with `line === 'haiku'`,
  `lifecycle === 'active'` and the greatest `created_at` — never by `id` text.
  - **Floor.** `HAIKU_FLOOR` (`claude-haiku-5-5`) is used when that call fails,
    times out or lists no active Haiku. Never another model line.
  - **Cache.** In memory per warm instance, keyed by SHA-256 of the key: 24 h
    for a resolved model, 5 min for the floor. Nothing is persisted.
  - **Retired model.** A `404 not_found_error` from `/v1/messages` drops the
    cache entry, re-resolves and retries once; a second failure is
    `502 upstream`.
  - **Budget.** Resolution and the Messages call share one 12 s timeout.
  - **Log.** One line per triage: `triage model=<id> source=<resolved|floor|cache>`,
    plus `reason=<models_STATUS[:error_type]|timeout|network|malformed|no_haiku:…>`
    on a fresh floor (no key material).
  - Key validation (`GET /v1/models?limit=1`) does not resolve or cache a model.
- **History.** The pre-chunk-55 plaintext `settings.ai_api_key` column was
  lazily migrated by triage once, on 2026-10-12; chunk 56 removed every
  reference here and dropped the column.

## Environment variables

Set these in **Vercel → Project → Settings → Environment Variables** (never commit
real values; `.env.example` holds placeholders). For local dev, copy them into
`.env.local`.

| Var                         | Purpose                                                  |
| --------------------------- | -------------------------------------------------------- |
| `SUPABASE_URL`              | Supabase project URL                                     |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key — server-only, bypasses RLS             |
| `SUPABASE_JWKS_URL`         | `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`          |
| `CALDAV_ENCRYPTION_KEY`     | 32-byte base64 key for AES-256-GCM                       |
| `ALLOWED_ORIGINS`           | Comma-separated CORS origins (scheme+host only, no path) |

`ALLOWED_ORIGINS` example: `https://<your-gh-username>.github.io,http://localhost:5173`
(the dashboard's GitHub Pages origin **without** the `/dashboard/` subpath).

### Generate `CALDAV_ENCRYPTION_KEY`

```sh
openssl rand -base64 32
```

This must be the same value across all deployments — rotating it makes previously
stored passwords undecryptable (users would re-enter via Settings).

## Local development

```sh
npm install
cp .env.example .env.local   # fill in real values locally (gitignored)
npm run dev                  # vercel dev → http://localhost:3000
```

Other scripts: `npm test` (Vitest), `npm run typecheck` (tsc), `npm run lint`
(ESLint), `npm run format` (Prettier).

## Deploy to Vercel

1. Connect this repo to a new Vercel project.
2. Add the five environment variables above (Production + Preview).
3. Deploy. The function runtime is pinned to Node **24.x** via `package.json` `engines`.
4. Verify: `curl https://<your-vercel-url>/api/health` → `{"ok":true}`.

## After deploy: wire into the `dashboard` repo

Add the deployed base URL as `VITE_CALDAV_PROXY_URL` in **both** places:

- `dashboard/.env.local` (local builds), and
- the `dashboard` repo's **GitHub Actions secret** of the same name (CI/Pages build).

This is required before the dashboard's calendar chunk (chunk 13) can call the proxy.

## Notes for dashboard-side integration

- **`caldav_app_password_encrypted` encoding:** the proxy writes the AES-GCM blob using
  Postgres `bytea` hex transport (`\x` + hex) over PostgREST — **not** raw driver
  pass-through (supabase-js can't carry raw bytes in JSON). This corrects the chunk-12
  sidecar note. The dashboard never reads this column (only the proxy encrypts/decrypts
  it), so no dashboard code depends on the encoding — but the row-12 backfill should
  record it.

## iCloud app-specific password

Generate one at <https://appleid.apple.com/account/manage> → **Sign-In and
Security → App-Specific Passwords**. Use your Apple ID email as `apple_id` and the
generated password as `app_password`. (Requires two-factor auth on the Apple ID.)

## Manual end-to-end verification (operator, post-deploy)

The unit tests mock iCloud, so these live checks must be run by hand with a real
app-specific password. Grab a JWT from the dashboard app via
`supabase.auth.getSession()`.

```sh
JWT="<supabase access token>"
BASE="https://<your-vercel-url>"

# 1) Discover calendars
curl -sX POST "$BASE/api/calendar/test-credentials" \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{"apple_id":"you@icloud.com","app_password":"abcd-efgh-ijkl-mnop"}'

# 2) Save (pick a calendar_url from step 1)
curl -sX POST "$BASE/api/calendar/save-credentials" \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{"apple_id":"you@icloud.com","app_password":"abcd-efgh-ijkl-mnop","calendar_url":"https://caldav.icloud.com/.../home/"}'

# 3) Create an event → confirm it appears in Calendar.app within seconds
curl -sX POST "$BASE/api/calendar/events" \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{"title":"Proxy test","start":"2026-06-01T15:00:00Z","end":"2026-06-01T15:30:00Z"}'

# 3b) Planner mirror round trip (chunk 39): create tagged → PATCH → busy → DELETE ×2
curl -sX POST "$BASE/api/calendar/events" \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{"title":"Planner probe","start":"2026-06-01T16:00:00Z","end":"2026-06-01T16:30:00Z","source":"planner"}'
#    → {"ok":true,"uid":"hupo-block-<uuid>"}   (export UID=hupo-block-<uuid>)
curl -sX PATCH "$BASE/api/calendar/events" \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d "{\"uid\":\"$UID\",\"title\":\"Planner probe (moved)\",\"start\":\"2026-06-01T17:00:00Z\",\"end\":\"2026-06-01T17:30:00Z\"}"
#    → {"ok":true}; Calendar.app shows the event at the new time
curl -s "$BASE/api/calendar/busy?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z" \
  -H "Authorization: Bearer $JWT"
#    → plannerEvents contains {uid:$UID, start:17:00Z, end:17:30Z}; busy does NOT contain 17:00–17:30
curl -sX DELETE "$BASE/api/calendar/events?uid=$UID" -H "Authorization: Bearer $JWT"
#    → {"ok":true}
curl -sX DELETE "$BASE/api/calendar/events?uid=$UID" -H "Authorization: Bearer $JWT"
#    → {"ok":true,"missing":true}

# 4) Busy for a range
curl -s "$BASE/api/calendar/busy?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z" \
  -H "Authorization: Bearer $JWT"

# 5) No token → 401
curl -si "$BASE/api/calendar/busy?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z" | head -n 1
```

## Security notes

- The app-specific password and the Outlook ICS URL are never stored or logged
  in plaintext, and decrypted values never appear in logs or error messages.
- The service-role key lives only in Vercel env vars.
- CORS is restricted to `ALLOWED_ORIGINS` — never `*`.
- This repo ships **no** database migration; the `settings` CalDAV columns are
  owned by the main `dashboard` repo (chunk 2), and the `outlook_*` columns by
  its `09_outlook_ics.sql` migration (chunk 35).

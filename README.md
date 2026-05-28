# dashboard-caldav-proxy

Vercel serverless functions that broker Apple iCloud calendar (CalDAV) for the
`dashboard` app. iCloud requires Basic auth with an app-specific password, which
a browser can't do safely (CORS + credential handling). This proxy stores the
password **encrypted**, verifies the caller's Supabase JWT, and brokers every
CalDAV call. See `ARCHITECTURE.md` §7 in the main `dashboard` repo for the
canonical design.

## How it works

- **Auth** — every `/api/calendar/*` request must send `Authorization: Bearer <supabase-jwt>`.
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

| Method & path                         | Body / query                               | Success                                    | Notable failures                                                  |
| ------------------------------------- | ------------------------------------------ | ------------------------------------------ | ----------------------------------------------------------------- |
| `GET /api/health`                     | —                                          | `{ ok: true }`                             | —                                                                 |
| `POST /api/calendar/test-credentials` | `{ apple_id, app_password }`               | `{ ok: true, calendars: [{ url, name }] }` | `401 { error: "auth" }`, `400`                                    |
| `POST /api/calendar/save-credentials` | `{ apple_id, app_password, calendar_url }` | `{ ok: true }`                             | `400`                                                             |
| `GET /api/calendar/busy`              | `?from=<ISO>&to=<ISO>`                     | `{ ok: true, busy: [{ start, end }] }`     | `412 { error: "no_credentials" }`, `401 { error: "auth_failed" }` |
| `POST /api/calendar/events`           | `{ title, start, end, description? }`      | `{ ok: true, uid }`                        | `412`, `401 { error: "auth_failed" }`                             |

Missing/invalid JWT → `401 { ok: false, error: "unauthorized" }`. Upstream
iCloud network/other failures → `502 { ok: false, error: "network" | "other" }`.

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

# 4) Busy for a range
curl -s "$BASE/api/calendar/busy?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z" \
  -H "Authorization: Bearer $JWT"

# 5) No token → 401
curl -si "$BASE/api/calendar/busy?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z" | head -n 1
```

## Security notes

- The app-specific password is never stored or logged in plaintext, and decrypted
  values never appear in logs or error messages.
- The service-role key lives only in Vercel env vars.
- CORS is restricted to `ALLOWED_ORIGINS` — never `*`.
- This repo ships **no** database migration; the `settings` CalDAV columns are
  owned by the main `dashboard` repo (chunk 2).

# Local gateway — a Supabase-compatible API origin without Docker

The development machine cannot run Docker, so `supabase start` is not available. This folder
is a single Node process that puts the same HTTP surface as a Supabase project in front of a
**real PostgREST** and a **real PostgreSQL**:

| Path              | Production (Supabase) | Here                                                  |
| ----------------- | --------------------- | ----------------------------------------------------- |
| `/rest/v1/*`      | Kong → PostgREST      | streaming reverse proxy to PostgREST                  |
| `/auth/v1/*`      | GoTrue                | emulation on the real `auth.*` tables (`auth/`)       |
| `/storage/v1/*`   | Storage API + TUS     | emulation, files on disk, RLS decides (`storage/`)    |
| `/functions/v1/*` | Edge Runtime (Deno)   | `supabase/functions/<name>/index.ts` in-process (tsx) |
| `/dev/*`          | —                     | development helpers (`/dev/otp`, `/dev/health`)       |
| pg_cron jobs      | pg_cron               | timers inside the gateway                             |

The web app talks to it with an unmodified `@supabase/supabase-js`. The binding description of
what is and is not emulated is **`docs/contracts/local-gateway.md`** — read it before relying
on any behaviour.

## Run

```bash
npm run stack:start                                        # PostgreSQL + PostgREST + gateway
node --import tsx scripts/local-stack/gateway/server.ts    # the gateway alone (foreground)
```

`scripts/local-stack/supabase-shim.sql` (applied by `npm run db:reset` before the migrations)
creates what a Supabase project provides out of the box: API roles, the `auth` and `storage`
schemas, `auth.uid()`, default privileges.

## Configuration (environment variables only; `.env.local` is loaded when present)

| Variable                                          | Default                                          |                                                                |
| ------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------- |
| `GATEWAY_PORT`                                    | `54321`                                          |                                                                |
| `GATEWAY_HOST`                                    | `127.0.0.1`                                      | `0.0.0.0` to test from a phone on the LAN                      |
| `POSTGREST_URL`                                   | `http://127.0.0.1:54323`                         |                                                                |
| `DATABASE_URL`                                    | `postgresql://postgres@127.0.0.1:54322/istiqama` | superuser connection (auth tables, role switching)             |
| `SUPABASE_JWT_SECRET`                             | — (required, ≥ 32 chars)                         | HS256 secret shared with PostgREST                             |
| `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | — (required)                                     | JWTs signed with the secret (`npm run stack:setup` makes them) |
| `OTP_PROVIDER`                                    | `fake`                                           | anything else → codes go to the `otp-hook` function            |
| `STORAGE_DIR`                                     | `.local/storage`                                 | objects, `.tus/` upload state, `.tmp/`                         |
| `JWT_EXPIRY_SECONDS`                              | `[auth] jwt_expiry` or `3600`                    |                                                                |

Optional tuning (all have sensible defaults): `GATEWAY_LOG_LEVEL` (`info` \| `warn` \|
`silent` — use `warn` for load tests), `GATEWAY_CORS_ORIGIN` (`*`), `GATEWAY_DB_POOL` (16),
`AUTH_ENABLE_SIGNUP`, `OTP_EMAIL_EXPIRY_SECONDS`, `OTP_SMS_EXPIRY_SECONDS`,
`OTP_MIN_INTERVAL_SECONDS`, `OTP_MAX_PER_HOUR`, `OTP_TEST_CODES` (`2557…=123456,…`),
`REFRESH_TOKEN_REUSE_INTERVAL`, `REFRESH_TOKEN_ROTATION`, `MFA_CHALLENGE_EXPIRY_SECONDS`,
`STORAGE_FILE_SIZE_LIMIT`, `STORAGE_PHOTO_SIZE_LIMIT` (10 MB), `STORAGE_UPLOAD_RATE_PER_MINUTE`
(600), `FUNCTIONS_DIR`, `SITE_URL`, `REPORTS_REFRESH_MINUTES` (15), `PURGE_PHOTOS_EVERY_HOURS`
(24).

Settings that GoTrue/Storage normally take from `supabase/config.toml` are read from that
file when no variable is set (`[auth] enable_signup`, `jwt_expiry`,
`refresh_token_reuse_interval`, `[auth.email] otp_expiry` / `max_frequency`,
`[auth.sms.test_otp]`, `[storage] file_size_limit`, `[functions.<name>] verify_jwt`), so the
local stack and the Supabase CLI stack used in CI behave alike.

## Getting an OTP in development

With `OTP_PROVIDER=fake` nothing is sent. The code is

- written to the gateway log (`.local/logs/gateway.log`, line `"msg":"otp_issued"`), and
- returned by `GET /dev/otp?identifier=<email or phone>` → `{ "code": "123456", … }`
  (loopback clients only; used by the Playwright helpers).

Phone numbers listed in `[auth.sms.test_otp]` always get their fixed code, exactly as on the
CLI stack.

## Tests

```bash
npx vitest run scripts/local-stack/gateway/tests           # unit tests, no database needed
node --import tsx scripts/local-stack/gateway/smoke.ts                 # fetch-only, against the running stack
node --import tsx scripts/local-stack/gateway/smoke-client.ts          # real supabase-js + tus-js-client
#   add  --spawn --db <database>  to either script: it starts a private PostgREST (:54333) and
#   gateway (:54331) against that database (state in .local/smoke) and stops them afterwards.
```

- `tests/` — JWT issuing/verification, TOTP (RFC 6238 / RFC 4226 vectors) and Base32,
  refresh-token rotation and reuse detection with an in-memory store, TUS offset rules and
  the on-disk upload store (restart, interrupted chunk, overflow), path-traversal protection,
  Range parsing, multipart parsing, configuration, QR code structure.
- `smoke.ts` — otp → dev code → verify → refresh/rotation/reuse → PostgREST → MFA (aal2) →
  upload / list / signed URL / range / public bucket → TUS in two chunks with a gateway
  restart in between → functions → logout.
- `smoke-client.ts` — the same journey through the unmodified client libraries; this is the
  proof that the web app needs no gateway-specific code.

## Layout

```
server.ts          entry point: routing, Kong-style API-key check, CORS, cron timers
config.ts          environment + supabase/config.toml fallbacks
proxy.ts           /rest/v1 → PostgREST (keep-alive, streaming)
auth/              routes.ts (endpoints), store.ts (SQL on auth.*), refresh.ts (rotation logic), errors.ts
storage/           routes.ts (objects, buckets, TUS), tus.ts, paths.ts, range.ts, multipart.ts, files.ts
functions.ts       Edge Function host (Deno shim, tsx reload, Request/Response bridge)
jwt.ts totp.ts qr.ts ratelimit.ts db.ts http.ts log.ts
private-stack.ts   throw-away PostgREST + gateway for the smoke tests
```

Dependencies: Node built-ins, `pg`, `jsonwebtoken`, `dotenv` (and `tsx` to run TypeScript).
Passwords are checked by the database (`crypt()` from pgcrypto); TOTP, Base32, the QR encoder,
multipart and TUS are implemented here.

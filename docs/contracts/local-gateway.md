# Contract — local gateway and Supabase shim

> Scope: `scripts/local-stack/supabase-shim.sql` and `scripts/local-stack/gateway/**`.
> Audience: everyone who writes client code, Edge Functions, e2e tests or load tests.
> Rule of thumb: **program against Supabase, never against the gateway.** Everything the
> gateway adds on its own lives under `/dev/*` or is marked _local extension_ below.

## 1. What it is

Production: Supabase (Kong → PostgREST, GoTrue, Storage, Edge Runtime, pg_cron).
Local: portable PostgreSQL + real PostgREST + **one Node process** (`gateway/server.ts`) that
speaks the same wire protocol for the subset this application uses. CI runs the real Supabase
CLI stack, so compatibility is checked there; `gateway/smoke-client.ts` drives the gateway
with the unmodified `@supabase/supabase-js` and `tus-js-client`.

## 2. Client configuration (no gateway-specific code)

```ts
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    global: { headers: { 'x-device-id': deviceId } }, // read by private.device_id() / session_ok()
  },
);
```

- `VITE_SUPABASE_URL=http://127.0.0.1:54321` locally, the project URL in staging/production.
- Resumable uploads: `tus-js-client` with
  `endpoint: ${SUPABASE_URL}/storage/v1/upload/resumable`,
  `headers: { authorization: 'Bearer <access token>', apikey: <anon key>, 'x-upsert': 'true' | 'false', 'x-device-id': … }`,
  `metadata: { bucketName, objectName, contentType, cacheControl: '3600' }`,
  `chunkSize: 6 * 1024 * 1024` (real Supabase **requires** 6 MB chunks; the gateway accepts
  any size), `uploadDataDuringCreation: true`, `removeFingerprintOnSuccess: true`.
  Refresh the `authorization` header in `onBeforeRequest` for long uploads: every TUS request
  is authenticated and an expired token is refused.
- Every request to `/rest/v1` and `/auth/v1` must carry the `apikey` header (supabase-js does
  this). Without it the gateway answers 401 like Kong.

## 3. Endpoints

### 3.1 `/rest/v1/*` → PostgREST

Prefix stripped, streaming proxy. `Authorization` is forwarded; when absent the `apikey` is
used as bearer. All other headers pass through (`Prefer`, `Range`, `Accept`,
`Accept-Profile`, `Content-Profile`, `x-device-id`, `x-client-info`, `User-Agent`), so
`request.headers` inside SQL is what PostgREST gives you in production. CORS preflights are
answered by the gateway (requested headers are echoed; `Content-Range`, `Location`,
`Upload-Offset`, `Tus-Resumable`, `X-Total-Count`, `Link`, `X-Supabase-Api-Version` are
exposed).

### 3.2 `/auth/v1/*` (GoTrue subset)

| Endpoint                                   | Notes                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /otp`                                | `{ email \| phone, create_user, data, channel }` → `{}` (e-mail) or `{ message_id }` (phone). Unknown identifier: 422 `otp_disabled` when `create_user=false`, 422 `signup_disabled` when sign-ups are off. Per identifier: minimum interval (e-mail 1 s, SMS 5 s — CLI defaults) and 30 per hour → 429 `over_email_send_rate_limit` / `over_sms_send_rate_limit`. |
| `POST /verify`                             | `{ type: 'email' \| 'magiclink' \| 'signup' \| 'recovery' \| 'sms', email \| phone, token }` or `{ type, token_hash }` → session. Wrong, used or expired code: 403 `otp_expired`. Codes are single-use; e-mail codes live `[auth.email] otp_expiry` (600 s here), SMS codes 60 s.                                                                                  |
| `POST /token?grant_type=refresh_token`     | Rotation with reuse detection (§4.3). 400 `refresh_token_not_found` / `refresh_token_already_used` / `session_expired`.                                                                                                                                                                                                                                            |
| `POST /token?grant_type=password`          | `{ email \| phone, password }`, checked with `crypt()`. 400 `invalid_credentials`. Used by load tests and seeds only; the app signs in with OTP.                                                                                                                                                                                                                   |
| `GET /user`, `PUT /user`                   | `PUT` accepts `data` (merged into `user_metadata`), `password`, `email`, `phone` (applied immediately — auto-confirm).                                                                                                                                                                                                                                             |
| `POST /logout?scope=global\|local\|others` | 204. Deletes sessions (refresh tokens cascade). Access tokens stay valid for PostgREST until `exp`, as on Supabase — immediate cut-off is `private.session_ok()`'s job.                                                                                                                                                                                            |
| `POST /factors`                            | TOTP only: `{ factor_type: 'totp', friendly_name?, issuer? }` → `{ id, type, friendly_name, totp: { qr_code (SVG), secret, uri } }`.                                                                                                                                                                                                                               |
| `POST /factors/:id/challenge`              | → `{ id, type, expires_at }` (5 minutes).                                                                                                                                                                                                                                                                                                                          |
| `POST /factors/:id/verify`                 | `{ challenge_id, code }` → **new session** (`aal: "aal2"`, `amr` contains `totp`, new refresh token). Updates `auth.sessions.aal`, deletes the user's other sessions that are still aal1 and other unverified factors (GoTrue behaviour). 422 `mfa_verification_failed`, 422 `mfa_challenge_expired`.                                                              |
| `DELETE /factors/:id`                      | → `{ id }`; a verified factor needs an aal2 session.                                                                                                                                                                                                                                                                                                               |
| `GET /settings`, `GET /health`             | static.                                                                                                                                                                                                                                                                                                                                                            |
| Admin (service key)                        | `POST/GET /admin/users`, `GET/PUT/DELETE /admin/users/:id` (`should_soft_delete`), `GET /admin/users/:id/factors`, `DELETE /admin/users/:id/factors/:factorId`. Fields: `email`, `phone`, `password`, `email_confirm`, `phone_confirm`, `user_metadata`, `app_metadata`, `role`, `ban_duration` (Go duration or `none`), `id`.                                     |
| `POST /admin/users/:id/logout`             | **Local extension, does not exist in GoTrue.** Deletes every session of the user. See §6.1.                                                                                                                                                                                                                                                                        |

Factors are reported through the user object (`user.factors`), which is what
`supabase.auth.mfa.listFactors()` reads.

Session payload (identical to GoTrue):

```jsonc
{
  "access_token": "<jwt>",
  "token_type": "bearer",
  "expires_in": 3600,
  "expires_at": 1791044010,
  "refresh_token": "0u20m998iaz5",
  "user": {
    "id": "…",
    "aud": "authenticated",
    "role": "authenticated",
    "email": "…",
    "phone": "",
    "email_confirmed_at": "…",
    "confirmed_at": "…",
    "last_sign_in_at": "…",
    "app_metadata": { "provider": "email", "providers": ["email"] },
    "user_metadata": {},
    "factors": [
      {
        "id": "…",
        "friendly_name": "…",
        "factor_type": "totp",
        "status": "verified",
        "created_at": "…",
        "updated_at": "…",
      },
    ],
    "identities": [
      {
        "identity_id": "…",
        "id": "…",
        "user_id": "…",
        "identity_data": {},
        "provider": "email",
        "email": "…",
      },
    ],
    "created_at": "…",
    "updated_at": "…",
    "is_anonymous": false,
  },
}
```

JWT (HS256, `SUPABASE_JWT_SECRET`), claims of ARCHITECTURE Appendix A.5:

```jsonc
{ "iss": "http://127.0.0.1:54321/auth/v1", "sub": "<user id>", "aud": "authenticated", "role": "authenticated",
  "iat": 1791040410, "exp": 1791044010, "email": "…", "phone": "",          // phone without "+"
  "app_metadata": {}, "user_metadata": {}, "aal": "aal1" | "aal2",
  "amr": [{ "method": "totp" | "otp" | "password" | "magiclink" | "recovery", "timestamp": 1791040410 }],   // newest first
  "session_id": "<auth.sessions.id>", "is_anonymous": false }
```

Errors follow GoTrue's two formats: `{ "code": 403, "error_code": "otp_expired", "msg": "…" }`
by default, and `{ "code": "otp_expired", "message": "…" }` plus the echoed
`X-Supabase-Api-Version` header when the request carries `X-Supabase-Api-Version: 2024-01-01`
(supabase-js does) — in both cases `error.code === 'otp_expired'` in supabase-js. Database
outages are reported as 5xx so that supabase-js keeps the session and retries.

### 3.3 `/storage/v1/*`

| Endpoint                                                                                                            | Notes                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /object/:bucket/*`                                                                                            | upload; `multipart/form-data` (fields `cacheControl`, `metadata`, then the file — what storage-js sends for a `Blob`) or a raw body (`content-type`, `cache-control`, `x-metadata`). `x-upsert: true` to overwrite. → `{ Id, Key }` |
| `PUT /object/:bucket/*`                                                                                             | replace (upsert).                                                                                                                                                                                                                   |
| `GET\|HEAD /object/:bucket/*`, `/object/authenticated/:bucket/*`                                                    | download under the caller's role. `Range` (single range, suffix ranges), `ETag` / `If-None-Match` (304), `Cache-Control` from the upload, `?download=name`.                                                                         |
| `GET\|HEAD /object/public/:bucket/*`                                                                                | public buckets only, no credentials (PMTiles).                                                                                                                                                                                      |
| `POST /object/sign/:bucket/*`                                                                                       | `{ expiresIn }` → `{ signedURL: "/object/sign/<bucket>/<name>?token=…" }`; batch form `POST /object/sign/:bucket` with `{ expiresIn, paths }`.                                                                                      |
| `GET /object/sign/:bucket/*?token=`                                                                                 | token = JWT `{ url: "<bucket>/<name>", exp }`, bound to that object.                                                                                                                                                                |
| `POST /object/list/:bucket`                                                                                         | `{ prefix, limit, offset, sortBy: { column, order }, search }` → folders (`id: null`) then files of that level.                                                                                                                     |
| `DELETE /object/:bucket` `{ prefixes }`, `DELETE /object/:bucket/*`                                                 | under the caller's role; rows without a DELETE policy are simply not deleted (empty array).                                                                                                                                         |
| `POST /object/move`, `POST /object/copy`, `GET /object/info/:bucket/*`                                              | as storage-js calls them.                                                                                                                                                                                                           |
| `GET /bucket`, `GET /bucket/:id`, `POST /bucket`, `PUT /bucket/:id`, `DELETE /bucket/:id`, `POST /bucket/:id/empty` | under the caller's role: without a policy on `storage.buckets` users see **no** buckets (same as Supabase); the service key sees all.                                                                                               |
| `/upload/resumable`                                                                                                 | TUS 1.0.0: `OPTIONS`, `POST` (creation, creation-with-upload), `HEAD`, `PATCH`, `DELETE`. State on disk — an upload survives a gateway restart and an interrupted chunk keeps its received bytes. Uploads expire after 24 h.        |

Authorisation is the real mechanism: each metadata statement on `storage.objects` runs in a
transaction with `set local role <role of the JWT>` and `request.jwt.claims`,
`request.headers` (so `x-device-id` reaches `private.session_ok()`), `request.method`,
`request.path`. The RLS policies of migration 0015 decide; the service role bypasses RLS.
An upload first dry-runs the insert (rolled back), then receives the body, then writes the
row and moves the file into place in one transaction.

Limits: global `[storage] file_size_limit` (50 MiB), the bucket's `file_size_limit` and
`allowed_mime_types`, a hard 10 MB cap on bucket `photos`, and 600 object uploads per user per
minute (429, `Retry-After: 10`; the service role is exempt).

Error body `{ "statusCode": "404", "error": "not_found", "message": "Object not found" }`.
**As on Supabase the HTTP status is 400 for most failures** and the semantic code is in
`statusCode`: `"403"` + `Unauthorized` (RLS), `"404"` (`not_found`, `Bucket not found`),
`"409"` + `Duplicate`, `"415"` + `invalid_mime_type`. Real HTTP statuses: 413, 416, 429, 5xx.
With storage-js check `error.statusCode`, not `error.status`. TUS endpoints use plain HTTP
statuses with a text body (403, 404, 409, 412, 413, 415, 423, 429).

### 3.4 `/functions/v1/:name`

Loads `supabase/functions/<name>/index.ts` in-process. Contract for the module: export
`handler` (or a default export / `{ fetch }`) of type `(req: Request) => Response |
Promise<Response>`, and/or call `Deno.serve(handler)` — the gateway provides a minimal
`globalThis.Deno` (`env`, `serve` which only records the handler, `version`, `build`, `cwd`,
`readTextFile`, `readFile`) and `EdgeRuntime.waitUntil`.

- `req.url` is `http://<host>/<name>/<rest>?<query>` (no `/functions/v1` prefix), as hosted.
- JWT check before the function runs unless `[functions.<name>] verify_jwt = false` in
  `supabase/config.toml`: missing/invalid `Authorization` → 401. `OPTIONS` is never checked.
- **The gateway adds no CORS headers and forwards preflights to the function** — on Supabase
  the function must answer CORS itself.
- Environment: everything in `.env.local` plus `SUPABASE_URL`, `SUPABASE_DB_URL`.
- Imports: relative `.ts` files, bare specifiers that resolve from `node_modules`, and
  `npm:<pkg>[@version]` (mapped to the installed package). `jsr:` and `https:` imports do not
  work here.
- Edits to `index.ts` or anything it imports are picked up on the next request.
- Unknown function: 404 `{ "code": "NOT_FOUND" }`; import failure: 503 `{ "code": "BOOT_ERROR" }`;
  exception: 500 `{ "code": "WORKER_ERROR" }`.

### 3.5 Timers (pg_cron stand-in)

As the database owner, without JWT claims, skipped silently while the function is missing:
`public.refresh_reports()` every 15 min (first run 1 min after start),
`private.rate_limit_cleanup()` hourly, `private.expire_export_jobs()` daily, and the
`purge-photos` function daily (invoked with the service key).

### 3.6 `/dev/*` (never on Supabase)

- `GET /dev/otp?identifier=<email|phone>` → `{ code, identifier, channel, expires_at }`; only
  with `OTP_PROVIDER=fake`, only from loopback. On the CI stack read the code from the mail
  catcher (port 54324) or use an `[auth.sms.test_otp]` number — keep that switch inside the
  e2e helper.
- `GET /dev/health` → `{ status, database, auth_schema, postgrest, otp_provider }`.

## 4. Behaviour worth knowing

1. **Sign-ups.** `[auth] enable_signup = false`: `signInWithOtp` only works for users created
   through the admin API or a seed.
2. **Phone numbers** are stored and returned without the leading `+` (GoTrue does the same).
3. **Refresh tokens.** A token is revoked when exchanged. Re-sending the token that was just
   exchanged returns the same new session (lost response on a flaky network). Any other
   reuse outside `refresh_token_reuse_interval` (10 s) revokes every token of that session:
   the device must sign in again. One corner is stricter than GoTrue: once a family is
   revoked nothing of it can be exchanged, not even inside the interval.
4. **MFA.** After `mfa.verify` the old access token is still aal1; use the returned session
   (supabase-js stores it automatically).
5. **OTP delivery** with a provider other than `fake`: the gateway POSTs GoTrue's hook payload
   (`{ user, sms: { otp } }` or `{ user, email_data: { token, token_hash, … } }`) to the
   `otp-hook` function with the service key and header `x-otp-provider`.

## 5. Deliberately not emulated

- Auth: magic-link redirects (`GET /verify`), PKCE, OAuth/SSO/SAML, anonymous sign-in,
  `/signup`, `/recover`, `/invite`, `/resend`, `/reauthenticate`, e-mail/phone change
  confirmation, identity linking, phone/WebAuthn factors, `generateLink`, captcha, JWKS /
  asymmetric signing keys (`auth.getClaims()` falls back to `getUser()`), audit log entries,
  per-IP rate limits, MFA challenge IP binding.
- Storage: image transformations (`/render/image`), signed upload URLs, `list-v2`, the S3
  protocol, TUS extensions other than creation / creation-with-upload / termination /
  expiration, `last_accessed_at` updates.
- Platform: Realtime, GraphQL, Vault, pg_net, pg_cron itself, supautils, pg-safeupdate
  (PostgREST on Supabase rejects `UPDATE`/`DELETE` without a filter; here it does not).

## 6. Differences from real Supabase — do not rely on the local behaviour

1. **`POST /auth/v1/admin/users/:id/logout` is local only.** Portable ways to end a user's
   sessions from the `admin` function: a `SECURITY DEFINER` SQL function restricted to the
   service role that runs `delete from auth.sessions where user_id = $1` (works here and on
   Supabase), or `auth.admin.updateUserById(id, { ban_duration })`.
2. **Upload rate limiting exists only in the gateway.** Supabase Storage has none of its own;
   production needs an equivalent (for example an insert trigger on `storage.objects`
   calling `private.rate_limit`, or a rule at the edge).
3. **Migrations run as a superuser locally.** On Supabase `postgres` is not a superuser:
   `alter table storage.objects …`, creating event triggers or extensions outside the
   allow-list can pass here and fail there. CI is the judge.
4. **Statement timeouts are reproduced** (`anon` 3 s, `authenticated` 8 s, `authenticator`
   8 s + `lock_timeout` 8 s; PostgREST applies them per request). A long RPC fails locally
   exactly as it would in production.
5. Rate limits (OTP, verify, uploads) are in memory, per identifier/user, and reset when
   the gateway restarts.
6. Object names are case-sensitive in the database but the files live on a case-insensitive
   filesystem on Windows: two names that differ only by case would share a file. (Our names
   are UUID based.)
7. A file dropped into `.local/storage/<bucket>/` is **not** an object: publish through the
   API (service key) so that the `storage.objects` row exists — in production there is no
   other way. The global 50 MiB limit applies to the service key too; a large PMTiles archive
   needs a larger `[storage] file_size_limit` (and a paid Supabase plan).
8. Edge Functions run on Node, in the gateway process: no isolate, no CPU/memory/wall-clock
   limits, Node globals are visible. Keep functions to web-standard APIs and `Deno.env`.
9. Time-stamps inside `user.factors[]` / `identities[]` use PostgreSQL's ISO form
   (`…+00:00`) instead of `…Z`.
10. HS256 only. Never verify JWTs in the browser with the secret; never ship the secret.

## 7. The shim (`supabase-shim.sql`)

Run by `npm run db:reset` before the migrations; idempotent; safe to run concurrently for
different databases of the cluster.

- Roles `anon`, `authenticated`, `service_role` (bypassrls), `authenticator` (login,
  noinherit, member of the three, password `postgres`), `supabase_auth_admin`,
  `supabase_storage_admin`; the role-level timeouts of §6.4.
- Schemas `extensions`, `auth`, `storage`; `usage` on `public`, `extensions`, `auth`,
  `storage` for the API roles; database `search_path = "$user", public, extensions`;
  `pgcrypto` and `uuid-ossp` in `extensions`.
- **Supabase's default privileges**: everything the migration role creates in `public`
  (tables, routines, sequences) is granted to `anon`, `authenticated`, `service_role`.
  Migrations must revoke explicitly (ARCHITECTURE Appendix A.1).
- `auth.users`, `identities`, `sessions`, `refresh_tokens`, `mfa_factors`, `mfa_challenges`,
  `mfa_amr_claims`, `one_time_tokens` with GoTrue's column names and types; owned by
  `supabase_auth_admin`, RLS enabled, no privileges for API roles. `auth.uid()`,
  `auth.role()`, `auth.email()`, `auth.jwt()` read `request.jwt.claims` /
  `request.jwt.claim.*` exactly like Supabase.
- `storage.buckets` (incl. `file_size_limit`, `allowed_mime_types`), `storage.objects` (incl.
  generated `path_tokens`, unique `(bucket_id, name)`), RLS enabled on both, `ALL` granted to
  the API roles (as on Supabase — policies decide), `storage.foldername(text) → text[]`,
  `storage.filename(text)`, `storage.extension(text)`.
- PostgREST schema-cache reload event triggers (`pgrst_ddl_watch`, `pgrst_drop_watch`).
- Not provided: `pg_cron`, `pg_net`, `vault`, `realtime`, `graphql`, `supabase_functions`.

## 8. Load tests

The proxy is a single Node process (one core). In a local benchmark with 300 keep-alive
connections it relayed about 3,600 requests/s, against about 4,800 requests/s for PostgREST
called directly by the same (Node, single-threaded) load generator. Run the gateway with
`GATEWAY_LOG_LEVEL=warn` during k6 runs. To measure
the database alone, point k6 at PostgREST directly (`http://127.0.0.1:54323`, same JWTs,
paths without `/rest/v1`). Tokens for virtual users: `POST /auth/v1/token?grant_type=password`
for seeded users, or JWTs minted in the k6 script with `SUPABASE_JWT_SECRET` (claims of
§3.2; `session_id` may be any UUID because PostgREST does not look sessions up).

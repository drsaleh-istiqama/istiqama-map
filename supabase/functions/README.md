# Edge Functions (`supabase/functions`)

Server-side helpers that the database cannot do on its own: rate-limited wrappers, cache
headers, file production/parsing, the Auth admin half of a revocation, retention, and the
SMS hook. **Authorisation always stays in the database**: every function acts with the
caller's JWT (RLS + the permission checks inside the `SECURITY DEFINER` RPCs) and uses the
service role only where a contract says so.

| Function       | Request                                                                                                             | Caller                                               | Contract                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------- |
| `sync_push`    | `POST` body = RPC args `{ p_ops, p_device_id }` (aliases `ops`, `device_id`; device id falls back to `x-device-id`) | user                                                 | `docs/contracts/sync.md` §4   |
| `sync_pull`    | `POST` body = RPC args `{ p_cursor, p_limit }` (aliases `cursor`, `limit`)                                          | user                                                 | `sync.md` §5                  |
| `tiles`        | `GET /tiles/{z}/{x}/{y}?f=<json filters>&e=<scope epoch>`                                                           | user                                                 | `geo-search-tiles.md` §6      |
| `export`       | `POST { format, lang, filters }` or `POST { job_id }`; `GET ?job=<id>`                                              | user                                                 | `reports-import-export.md` §4 |
| `import`       | `POST` multipart (`file`, `lang`, `options`), raw file body, or JSON `{ rows, meta }` / `{ storage_path, options }` | user (writer)                                        | `reports-import-export.md` §5 |
| `admin`        | `POST { action, … }`                                                                                                | administrator                                        | `people-admin.md` §6          |
| `purge-photos` | `POST { limit?, max_batches? }`                                                                                     | **service role only**                                | `reports-import-export.md` §6 |
| `otp-hook`     | `POST` Auth hook payload                                                                                            | Supabase Auth (signed) / local gateway (service key) | Auth "Send SMS hook"          |

Unit tests: `npx vitest run supabase/functions` · live smoke against a running stack:
`node --import tsx supabase/functions/smoke.ts` (see [Tests](#tests)).

---

## 1. Runtime model (Deno on Supabase, Node under the local gateway)

- Each folder has `index.ts` exporting `handler` (and `default`) of type
  `(req: Request) => Promise<Response>`. `serveIfEntryPoint(import.meta, handler)` calls
  `Deno.serve(handler)` only on the Edge Runtime when the module is the worker's entry point;
  the local gateway (`scripts/local-stack/gateway/functions.ts`) and Vitest import the module
  and call `handler` directly.
- Only Web-standard APIs (`fetch`, `Request`/`Response`, streams, `crypto.subtle`,
  `CompressionStream`/`DecompressionStream`, `TextEncoder`). No Node built-ins.
- Bare specifiers are mapped in `deno.json` (`@supabase/supabase-js`, `xlsx`); under Node
  they resolve from `node_modules`. Relative imports always carry the `.ts` extension.
- Environment: `_shared/env.ts` (`Deno.env.get`, else `process.env`; empty = unset).
- Background work (export): `runInBackground()` = `EdgeRuntime.waitUntil(promise)` when it
  exists; under the gateway the promise simply keeps running after the response. On Supabase
  background work is still bounded by the worker's wall-clock limit (150 s free / 400 s paid).
- Every response goes through `createHandler()` (`_shared/http.ts`): CORS (+ preflight),
  method check, error mapping, `Server-Timing`.

## 2. Authentication and authorisation

| Function                                                       | `verify_jwt` (config.toml / dashboard)                                                            | Inside the function                                                                                                                                                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync_push`, `sync_pull`, `tiles`, `export`, `import`, `admin` | `true` (default)                                                                                  | the platform verified the token; the function decodes it (`_shared/auth.ts`) to learn the user id, and sends the **same token** on to PostgREST / Storage, where it is verified again and where RLS and the RPCs decide |
| `purge-photos`                                                 | `true` works with the legacy JWT service key; with the new non-JWT `sb_secret_…` keys set `false` | the bearer (or `apikey`) must **equal** `SUPABASE_SERVICE_ROLE_KEY` (constant-time compare). A token that merely _claims_ `role: service_role` is refused                                                               |
| `otp-hook`                                                     | **`false`** (Auth sends no JWT)                                                                   | Standard Webhooks signature, or the service key (local gateway)                                                                                                                                                         |

This is the Supabase model: with `verify_jwt = true` the Edge Runtime relay rejects missing,
expired or badly signed tokens before the function runs. The decoded identity is used only
for rate-limit keys; anything done with the service role uses ids returned by the database
for the caller's token (job owner, RPC result), never claims taken from the token.
If `verify_jwt` is ever turned off for a user-facing function (e.g. asymmetric signing keys
verified in code), set `FUNCTIONS_VERIFY_JWT=getuser`: `requireUser()` then validates every
token with `GET /auth/v1/user` (one extra round trip).

`config.toml` additions needed for a Supabase CLI / hosted deployment (owned by the lead):

```toml
[functions.otp-hook]
verify_jwt = false

# only once an SMS provider exists (owner decision #4); the hosted equivalent is
# Dashboard → Authentication → Hooks → "Send SMS hook" (HTTPS) with a generated secret
[auth.hook.send_sms]
enabled = true
uri = "https://<project-ref>.supabase.co/functions/v1/otp-hook"
secrets = "env(SEND_SMS_HOOK_SECRET)"
```

## 3. Errors, CORS, rate limits

- **Error body** = the PostgREST shape the web app already handles for direct RPC calls:
  `{ "code": "PT403", "message": "forbidden", "details": "…" | null, "hint": "…" | null }`.
  Switch on `message`. Database errors keep their code/message/details/hint; the HTTP status
  follows PostgREST (`PTxxx` → xxx, `42501` → 403, `23505` → 409, `40001`/`40P01` → 503, …).
  `429` always carries `Retry-After`.
- **CORS**: `APP_ORIGINS` = comma-separated allowed origins (`*` allowed but not
  recommended). Unset → only `http://localhost:5173`, `:4173` and the `127.0.0.1` twins.
  Neither Supabase nor the gateway adds CORS headers to function responses.
- **Rate limits** (`_shared/ratelimit.ts`): `private.rate_limit()` is not reachable from a
  function (schema `private` is not exposed and no public wrapper exists), so the functions
  use an **in-memory sliding window per isolate**. For everything except `tiles` the
  authoritative limit is the one inside the RPC (shared by all isolates); the function only
  sheds floods early. For `tiles` (the RPC is `STABLE` and cannot use the DB limiter) the
  in-memory limit is the only one: with N warm isolates a user can reach N × the limit, and
  counters reset when an isolate is recycled.

| Function    | Per user                     | Database limit behind it               |
| ----------- | ---------------------------- | -------------------------------------- |
| `sync_push` | 120 / min                    | `sync_push` 120 / min                  |
| `sync_pull` | 600 / min                    | `sync_pull` 600 / min                  |
| `tiles`     | 1,200 / min                  | none                                   |
| `export`    | 30 POST / min, 240 GET / min | `export_request` 20 / h, 3 active jobs |
| `import`    | 20 / min                     | `import_stage` 30 / h                  |
| `admin`     | 120 / min                    | `admin_write` 120 / min                |

## 4. Environment variables

Provided by the platform: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
(locally from `.env.local`). Everything below is optional.

| Variable                                                             | Default                   | Used by                                                                |
| -------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------- |
| `APP_ORIGINS`                                                        | local dev origins         | all (CORS) — **set it in staging/production**                          |
| `APP_ENV` (or `VITE_APP_ENV`)                                        | `development`             | `production` disables the fake OTP provider entirely                   |
| `FUNCTIONS_VERIFY_JWT`                                               | –                         | `getuser`: validate tokens with the Auth server (see §2)               |
| `SYNC_PUSH_RATE_PER_MINUTE` / `SYNC_PUSH_MAX_BYTES`                  | 120 / 2 MiB               | `sync_push`                                                            |
| `SYNC_PULL_RATE_PER_MINUTE`                                          | 600                       | `sync_pull`                                                            |
| `TILES_RATE_PER_MINUTE` / `TILES_GZIP`                               | 1200 / `true`             | `tiles`                                                                |
| `EXPORT_PAGE_SIZE`                                                   | 1000 (max 2000)           | `export` — rows per `export_rows` call                                 |
| `EXPORT_XLSX_MAX_ROWS`                                               | 200,000                   | `export` — beyond it the job is delivered as CSV                       |
| `EXPORT_SIGNED_URL_SECONDS`                                          | 300 (30…3600)             | `export` — lifetime of the download URL                                |
| `EXPORT_MAX_ATTEMPTS` / `EXPORT_STALE_SECONDS`                       | 3 / 120                   | `export` — restart of abandoned jobs                                   |
| `EXPORT_CSV_UPLOAD`                                                  | `stream`                  | `export` — `buffer` builds the CSV in memory before uploading          |
| `IMPORT_MAX_BYTES` / `IMPORT_MAX_JSON_BYTES`                         | 10 MiB / 16 MiB           | `import`                                                               |
| `PURGE_TIME_BUDGET_SECONDS`                                          | 100                       | `purge-photos`                                                         |
| `AUTH_LOGOUT_RPC`                                                    | `admin_end_auth_sessions` | `admin` — `none` skips the RPC step (§5.6)                             |
| `SEND_SMS_HOOK_SECRET`, `SEND_EMAIL_HOOK_SECRET`, `AUTH_HOOK_SECRET` | –                         | `otp-hook` — `v1,whsec_…`; several space-separated during a rotation   |
| `OTP_PROVIDER`, `OTP_PROVIDER_<ISO2>`                                | –                         | `otp-hook` — provider per country (`OTP_PROVIDER_TZ=…`)                |
| `OTP_FAKE_LOG_CODES`                                                 | `true`                    | `otp-hook` — `false`: the fake provider hides the code in its log line |

## 5. The functions

### 5.1 `sync_push`, `sync_pull`

Thin wrappers so that the web transport can switch between `POST /rest/v1/rpc/<name>` and
`POST /functions/v1/<name>` by configuration only: same body, same response, same errors.
The caller's `Authorization`, `apikey` and `x-device-id` are forwarded; PostgREST's status
and body are passed through unchanged (including `rejected` results, `device_mismatch`,
`session_revoked`); `x-ratelimit-limit` / `x-ratelimit-remaining` and `Server-Timing`
(`rpc;dur=…`) are added. A gateway hiccup (502/503, connection reset) is retried once — safe
because `sync_push` is idempotent by `op_id` and a pull page is repeatable. Insert ops carry
`created_at` (offline entry time, sync.md §4.2 rule 4) untouched.

### 5.2 `tiles`

`GET /functions/v1/tiles/{z}/{x}/{y}` (optional `.mvt`/`.pbf`) `?f=<json>` with the keys
`country_id`, `branch_id`, `type`, `status`, `record_state` (string or array) and `layers`;
anything else is dropped. Calls `GET /rest/v1/rpc/tile_projects` with
`Accept: application/vnd.mapbox-vector-tile` and the caller's credentials.

- `z` 0…22, `x`/`y` inside the zoom level, else `422`; not a tile path → `404`.
- `200` MVT body / `204` for an empty tile (same headers) / `304` for a matching
  `If-None-Match`.
- `Cache-Control`: z < 14 `private, max-age=300, stale-while-revalidate=600`; z ≥ 14
  `private, max-age=30`; errors `no-store`. Never `public` — tiles depend on the caller's scope.
- `ETag` = first 128 bits of SHA-256 of the body (weak `W/…` when the body is gzipped);
  `Vary: Authorization, Accept-Encoding`. The `e=` parameter is ignored (cache buster).

### 5.3 `export`

1. `POST { "format": "csv"|"xlsx", "lang": "ar"|"sw"|"en", "filters": {…} }` → `export_request`
   with the caller's JWT → **202** `{ job, status: "?job=<id>" }` at once. (Or
   `POST { "job_id" }` for a job the client created itself, the contract flow.)
2. In the background, with the **caller's JWT**: `export_columns(lang)` once, then
   `export_rows(job, after, 1000)` until `done` — so scope and column visibility (no salary
   columns without restricted access) are the database's decision.
3. File: header row = `columns[].header`; enum/boolean cells translated through
   `enums[column.enum][String(value)]`; `null` → empty. CSV = UTF-8 with BOM, CRLF, RFC 4180,
   formula guard (a text cell starting with `=` `+` `-` `@` — also after leading white space and
   in full-width form — tab or CR gets a leading `'`). XLSX = one sheet, right-to-left for
   `dir: rtl`, bold frozen header row, numbers as numbers, text as inline strings (never
   formulas), same guard.
4. Upload to bucket `exports` at `{user_id}/{job_id}.{ext}` and `export_finish(…, 'done', …)`
   with the **service key** (it creates the `export.ready` notification). Any failure →
   partial file removed, `export_finish(…, 'failed', p_error)` (`export.failed`
   notification). A cancelled job makes the next `export_rows` fail with `PT409` → failed.
5. `GET ?job=<id>` → `{ job, download?: { url, path, expires_in, bucket, storage_path,
file_name, bytes, row_count }, fallback? }`. The signed URL (5 minutes) is created with
   the **caller's** token, so only the owner of the folder can obtain it; RLS hides other
   users' jobs (`404 export_job_not_found`).

Memory and size:

- CSV is streamed: each page is converted and encoded immediately and uploaded while it is
  produced (`EXPORT_CSV_UPLOAD=buffer` if a Storage deployment refuses chunked uploads).
- XLSX is written by our own streaming writer (`_shared/xlsx.ts`), deflated page by page:
  only the compressed archive (~10–20 % of the CSV size) is held until the upload. SheetJS CE
  is not used for writing because it cannot freeze panes and keeps one object per cell.
  **Practical limit: 200,000 rows** (`EXPORT_XLSX_MAX_ROWS`; Excel itself stops at 1,048,575);
  beyond it the job is delivered as CSV, `stats.fallback` / the `fallback` key of the status
  response say so (`{ from: "xlsx", to: "csv", reason: "row_limit", limit }`).
- Measured CSV size: 650–800 bytes per project row → **a 100,000-project CSV is 65–80 MB,
  above the default 50 MiB Storage file limit**. Raise `[storage] file_size_limit` (and the
  hosted project's limit) to ≥ 200 MiB, or the upload of such an export fails (job `failed`,
  message `PT413 storage_error`).
- A worker killed by the wall-clock limit leaves the job `running`; a new `POST { job_id }`
  after `EXPORT_STALE_SECONDS` restarts it from the first page (at most
  `EXPORT_MAX_ATTEMPTS`); `private.expire_export_jobs()` fails jobs stuck for a day.

### 5.4 `import`

Parses the file on the server and calls `import_stage(p_meta, p_rows)` with the **caller's
JWT**; everything after staging (`import_preview`, `import_set_action`, `import_commit`,
`import_rollback`) is called by the web app directly. Response = the `import_stage` summary
plus `file` (what was read: `kind`, `headers`, `header_row`, `rows`, `source_rows` when blank
rows were skipped, `sheet`/`sheets`, `encoding`, `delimiter`, `warnings`).

- Inputs: multipart (`file`, optional `lang`, optional `options` JSON
  `{ file_name, country_id, branch_id, column_map, sheet, delimiter }`); the raw file as the
  body (options in the query string, name in `x-file-name`); JSON `{ storage_path }` for a file
  the caller uploaded to its own folder of bucket `imports`; JSON `{ rows, meta }` for rows
  parsed on the device (v2 migration: `source_kind: "v2_json" | "v2_local"`).
- CSV: BOM, `,` `;` tab (or Excel's `sep=` line), quoted fields with delimiters / quotes /
  line breaks, UTF-8 / UTF-16 (BOM) / windows-1256 (warning `encoding_windows_1256`).
- XLSX: first visible sheet (or `options.sheet`), first non-empty row = header. Read by
  `_shared/xlsx-read.ts`, not SheetJS (the npm build has open CVEs for crafted workbooks):
  ZIP central directory only, inflated bytes counted (zip bombs), sheet streamed and reading
  stops at the row limit. **Values only**: a formula cell yields its cached value (warning
  `formulas_ignored`), macros are never opened (`macros_ignored`), `.xls` / encrypted files →
  `415 unsupported_file_type`.
- Limits: 10 MiB per file, **5,000 data rows** (`422 too_many_rows`, nothing staged), empty
  file / header only → `422 empty_file`. Our own export's formula guard (`'=…`) is removed
  again, so an exported file re-imports cleanly.

### 5.5 `purge-photos`

Service role only. Loop: `photos_to_purge(limit)` → remove the full image and the thumbnail
from bucket `photos` → `mark_photos_purged(ids)`; rows are marked only after their objects
are gone (idempotent, safe after a crash); stops when nothing is left, after `max_batches`,
after `PURGE_TIME_BUDGET_SECONDS`, or when the same batch comes back (no progress → `more:
true`). Then the files of `expired` export jobs are deleted from bucket `exports` and their
`storage_path` is cleared (the row stays).
Response: `{ photos: { marked, objects_removed, batches, more }, exports: { files_removed,
jobs_cleared }, duration_ms }`.
Scheduling: locally the gateway timer calls it daily with the service key; on Supabase use a
daily Supabase Cron job (`pg_cron` + `pg_net`) that POSTs to the function with the service
key taken from Vault.

### 5.6 `admin`

`POST { "action": … }`:

| action            | body                                                                                                    | RPC (caller's JWT)                                                | then (service role)                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `revoke_sessions` | `user_id`, `device_id?`                                                                                 | `admin_revoke_sessions`                                           | end the user's Auth sessions when `auth_logout_required`                                              |
| `set_user_active` | `user_id`, `active`                                                                                     | `admin_set_user_active`                                           | end sessions when deactivating; ban (`876000h`) / unban the Auth user                                 |
| `restore_device`  | `user_id`, `device_id`                                                                                  | `admin_restore_device`                                            | –                                                                                                     |
| `set_role`        | `user_id`, `role`, `scope_type`, `scope_id?`                                                            | `admin_set_role`                                                  | –                                                                                                     |
| `remove_role`     | `role_id`                                                                                               | `admin_remove_role`                                               | –                                                                                                     |
| `create_user`     | `email` and/or `phone` (E.164), `full_name`, `preferred_language?`, `role?`, `scope_type?`, `scope_id?` | `my_context` (must be `is_hq`), profile upsert + `admin_set_role` | create the Auth user first (self sign-up is disabled); deleted again if the profile cannot be written |

The database authorises every action; when the RPC refuses, the service role is never used.
The response is the RPC result plus `auth_logout: { done, method, detail? }` /
`auth_ban: { done, banned }`.

**Ending Auth sessions (refresh tokens).** GoTrue has no "sign user X out" admin endpoint —
`auth.admin.signOut(jwt)` needs the _user's own_ access token. The function therefore tries,
in order:

1. RPC `admin_end_auth_sessions(p_user_id uuid)` (name: `AUTH_LOGOUT_RPC`) — portable, works
   on Supabase and locally, **but does not exist yet** (migrations are owned by the database
   team). Proposed SQL:
   ```sql
   create or replace function public.admin_end_auth_sessions(p_user_id uuid)
   returns integer language plpgsql volatile security definer
   set search_path = public, extensions, private, pg_temp
   as $$
   declare v_n integer;
   begin
     perform private.require_service_role();
     delete from auth.sessions s where s.user_id = p_user_id;   -- refresh tokens cascade
     get diagnostics v_n = row_count;
     return v_n;
   end;
   $$;
   revoke execute on function public.admin_end_auth_sessions(uuid) from public, anon, authenticated;
   grant execute on function public.admin_end_auth_sessions(uuid) to service_role;
   ```
   (Alternatively `admin_revoke_sessions` / `admin_set_user_active` could delete the sessions
   themselves and stop asking for `auth_logout_required`.)
2. `POST /auth/v1/admin/users/{id}/logout` — **local gateway only**.

If neither exists (today: a hosted project) the response says `auth_logout.done: false`; the
access tokens are dead anyway (`sessions_revoked_at`), but a refresh token would yield a new
one — the UI should tell the administrator to deactivate the account (a banned user cannot
refresh), which `set_user_active(false)` does.

### 5.7 `otp-hook`

Supabase Auth "Send SMS hook" (also accepts the "Send Email hook" payload):

```jsonc
// request (Standard Webhooks: headers webhook-id, webhook-timestamp, webhook-signature)
{ "user": { "id": "…", "phone": "255700000001", … }, "sms": { "otp": "123456" } }
{ "user": { "id": "…", "email": "…" }, "email_data": { "token": "123456", "token_hash": "…", "email_action_type": "…" } }
// response
{}                                                     // 200: handed to the provider
{ "error": { "http_code": 401, "message": "…" } }      // hook error format, same HTTP status
```

- Signature: HMAC-SHA256 over `${webhook-id}.${webhook-timestamp}.${raw body}` with the key
  of the secret `v1,whsec_<base64>` (prefixes optional); the header may list several
  `v1,<base64>` signatures; timestamps older/newer than 5 minutes are refused (replay).
  Configure the same secret in the hook settings and in `SEND_SMS_HOOK_SECRET`.
- The local gateway calls the hook with the service key and `x-otp-provider` instead.
- Providers (`otp-hook/providers.ts`): selected by `OTP_PROVIDER_<ISO2>` of the phone's
  country (TZ, KE, UG, RW, BI, MZ, OM by calling code), else the gateway's hint, else
  `OTP_PROVIDER`. **Only `fake` exists** (owner decision #4 is open): it writes one log line
  (masked recipient; the code unless `OTP_FAKE_LOG_CODES=false`) and sends/stores nothing; it
  refuses to run with `APP_ENV=production`. **Behind the real (signed) hook the provider must
  be configured explicitly** (`OTP_PROVIDER=fake` on a hosted staging project): an
  unconfigured project answers `500 No OTP provider is configured` instead of writing sign-in
  codes into the function log. An unknown provider name → 500 (fail closed).
- Adding a provider: implement `OtpProvider` (`send(message)` → throw `OtpProviderError` with
  an HTTP status on failure), register it in `PROVIDERS`, set `OTP_PROVIDER_<ISO2>=<name>`
  and its credentials as function secrets.

## 6. Tests

- **Unit** (`*.test.ts`, Vitest "node" project): CSV writer/reader and injection guard
  (Arabic included), XLSX writer (read back by SheetJS and by our reader), ZIP, XLSX reader
  incl. zip bombs / formulas / macros / prototype pollution, labels, tile path/filters/cache
  helpers, rate limiter, webhook signatures, error mapping, CORS, and handler tests that run
  the real supabase-js clients against `_shared/fake-api.ts` (a recording stand-in for the
  API gateway) to assert which credentials every request carries and in which order:
  `export`, `import`, `admin`, `purge-photos`, `tiles`, `sync_*`, `otp-hook`.
- **Live smoke** (`node --import tsx supabase/functions/smoke.ts`, reads `.env.local`):
  signs in as the seeded staging users (password grant) and exercises every function through
  the gateway — Arabic CSV/XLSX exports of `collector.pemba` (headers, translated values, no
  salary column, only Pemba), Swahili + filter, viewer columns, ownership of jobs and files,
  an HQ export at aal2 (a dedicated `smoke.hq@example.org` account gets `hq_admin` and a TOTP
  factor for the run only), the admin revocation chain on a throw-away
  `smoke.target@example.org`, CSV/XLSX imports (valid / invalid / duplicate), tiles
  (200/204/304, headers), the sync wrappers (incl. an insert carrying `created_at`, deleted
  again), purge-photos and the OTP hook. It creates export jobs/files, never-committed import
  batches and one soft-deleted donor; it never resets anything.

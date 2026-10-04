# Istiqama Projects Map v3 — Architecture & Contracts

> **Status:** binding contract for every engineer/agent working on this repo.
> The product spec is `docs/BRIEF.md` (Arabic, highest authority). This document turns the
> brief into concrete names, signatures and module boundaries. If this file and the brief
> disagree, the brief wins — fix this file in the same change.
>
> **Reconciled with the code on 2026-10-04 (Units 0–4 built).** The detailed, per-area
> contracts are in `docs/contracts/` (`schema.md`, `authz.md`, `sync.md`,
> `geo-search-tiles.md`, `people-admin.md`, `reports-import-export.md`, `reference-data.md`,
> `local-gateway.md`, `web.md`); where this overview is shorter than a contract, the contract
> holds the exact rule. §9 lists what exists and how it is tested.

## 0. Ground rules

- Code, comments, commit messages: **English**. UI strings: only in `apps/web/locales/{ar,sw,en}.json`.
- No secrets in the repo. Everything configurable lives in env vars (`.env.example`).
- Soft delete everywhere (`deleted_at`). No hard `DELETE` grants to API roles.
- Every DB object needed by the app is created by a file in `supabase/migrations/` and must be
  valid on **real Supabase** (hosted or self-hosted). Things Supabase provides out of the box
  (roles `anon`/`authenticated`/`service_role`, schemas `auth`/`storage`/`extensions`,
  `auth.uid()`, `auth.jwt()`, `storage.objects`…) are provided locally by
  `scripts/local-stack/supabase-shim.sql`, never by a migration.
- The web app talks to the backend **only** through `@supabase/supabase-js` behind thin
  adapters (`src/auth/provider.ts`, `src/sync/transport.ts`, `src/photos/storage.ts`).
  Switching local stack → Supabase Cloud → self-hosted Supabase is an env change only.

## 1. Runtime topology

```
Browser (PWA: Preact + Dexie + MapLibre + Workbox)
   │  supabase-js (REST/RPC, Auth, Storage TUS, Functions)
   ▼
API origin  :54321   ── production: Supabase (Kong)      local: scripts/local-stack/gateway
   ├─ /rest/v1/*      → PostgREST (real binary locally, :54323)
   ├─ /auth/v1/*      → GoTrue           (local: gateway emulation, fake OTP provider)
   ├─ /storage/v1/*   → Storage API+TUS  (local: gateway emulation on disk, RLS-checked)
   └─ /functions/v1/* → Edge Functions   (local: gateway loads supabase/functions/*/index.ts)
   ▼
PostgreSQL 17 + PostGIS + pg_trgm + unaccent (+ pgTAP for tests, pg_cron in production)
Object storage: buckets `photos`, `exports`, `imports`, `tiles` (PMTiles + map packs)
```

### Local stack (no Docker)

| Piece                                        | Where                          | Port        |
| -------------------------------------------- | ------------------------------ | ----------- |
| Portable PostgreSQL 17 + PostGIS 3.6 + pgTAP | `.local/pg` (git-ignored)      | 54322       |
| PostgREST (real binary)                      | `.local/postgrest`             | 54323       |
| Gateway (Supabase-compatible emulator, Node) | `scripts/local-stack/gateway/` | 54321       |
| Vite dev / preview                           | `apps/web`                     | 5173 / 4173 |

Root npm scripts (the only commands a developer needs):

| Script                                  | Does                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `npm run stack:setup`                   | download + extract portable binaries, `initdb`, generate `.env.local` (random JWT secret, anon/service keys) |
| `npm run stack:start` / `stack:stop`    | start/stop PG + PostgREST + gateway (logs in `.local/logs`)                                                  |
| `npm run db:reset`                      | drop/create DB, apply shim + all migrations (+ `supabase/seed.staging.sql` unless `--no-seed`)               |
| `npm run test:db`                       | run pgTAP files in `supabase/tests/` (TAP parsed by `scripts/local-stack/run-pgtap.ts`)                      |
| `npm run dev` / `build` / `preview`     | web app                                                                                                      |
| `npm test`                              | Vitest (web + functions)                                                                                     |
| `npm run e2e`                           | Playwright against the local stack                                                                           |
| `npm run load:seed` / `load:test`       | generate 100k/500k/1M dataset, run k6                                                                        |
| `npm run lint` / `format` / `typecheck` | ESLint, Prettier, tsc                                                                                        |

Also: `stack:status` (health of the three processes), `boundaries:import` (geoBoundaries
ADM1–ADM3, or an official file with `--file`), `pmtiles:build` (East-Africa basemap and
per-region offline packs).

`db:reset` accepts `--db <name>` (default `istiqama`), `--upto <NNNN>`, `--only <ranges>` and
`--no-seed` so that parallel workers can test against private databases (`imap_<area>`); the
shared `istiqama` database is never dropped by workers.

What the gateway emulates (exact list and known differences: `docs/contracts/local-gateway.md`):
GoTrue subset (e-mail/phone OTP with the `fake` provider, refresh tokens, TOTP factors, admin
users API, JWTs with `iat`/`aal`/`session_id`), Storage (objects, signed URLs, TUS resumable
uploads, access decided by `storage.objects` RLS under the caller's role), Edge Functions
(loads `supabase/functions/<name>/index.ts` under Node), timers that replace `pg_cron`
(`refresh_reports()` every 15 min, photo purge daily) and `/dev/otp` for tests (only with
`OTP_PROVIDER=fake`). Local-only database objects (roles, `auth`/`storage` schemas,
`auth.uid()`, …) live in `scripts/local-stack/supabase-shim.sql`, never in a migration.

The development basemap is a Protomaps build (`.local/tiles/east-africa.pmtiles`, z0–10,
~100 MB, not committed) served from the `tiles` bucket (`VITE_TILES_URL`); map glyphs and
sprites are self-hosted in `apps/web/public/map/`.

CI (GitHub Actions, ubuntu; `.github/workflows/ci.yml`, `deploy.yml`, described in
`docs/CI.md`) uses the **real** Supabase CLI stack (`supabase start`, `supabase test db`) —
this is how real-Supabase compatibility is verified.

## 2. Database

Schemas: `public` (tables + API-exposed RPC), `private` (helpers, never exposed), plus
Supabase's `auth`, `storage`, `extensions`. Extensions are created with
`create extension if not exists <x> with schema extensions` (`postgis`, `pg_trgm`, `unaccent`,
`pgcrypto`). All functions pin `set search_path = public, extensions, pg_temp` (+ `private`
when needed).

### 2.1 Standard columns and triggers

Every table has: `id uuid primary key`, `created_at timestamptz not null default now()`,
`updated_at timestamptz not null default now()`, `created_by uuid`, `updated_by uuid`,
`version int not null default 1`, `deleted_at timestamptz`.
Syncable tables add `sync_xid bigint not null` (see §3.2).

- `private.tg_std()` BEFORE INSERT/UPDATE: maintains `updated_at`, `updated_by`
  (`auth.uid()` when present), `created_by` on insert, `version = old.version + 1` on update,
  `sync_xid = private.current_xid()`.
- `private.tg_audit()` AFTER INSERT/UPDATE/DELETE on every table → `audit_log`
  (table, row id, op, old/new JSONB, `changed_fields text[]`, `row_version`, user, device id
  from `private.device_id()`, time). Geometry is logged as EWKT text.
- `private.uuid_v7()` server-side UUIDv7 generator (clients generate their own).
- `private.norm(text)` IMMUTABLE: unaccent + lower + Arabic normalisation
  (strip tashkeel `ً-ٰٟۖ-ۭ` and tatweel, `أإآ→ا`, `ى→ي`, `ة→ه`,
  collapse whitespace). The TypeScript twin is `apps/web/src/lib/normalize.ts`; both are
  tested against the same fixture `supabase/tests/fixtures/normalize.json`.

### 2.2 Tables (public)

Types are text + CHECK (not enums). `std` = the standard columns above. `S` = syncable.

**Geography**

- `countries` S — std, `iso2 char(2) unique`, `iso3 char(3)`, `name_ar`, `name_en`, `name_sw`,
  `default_currency char(3)`, `active bool`.
- `admin_areas` S (rows only; shapes via RPC) — std, `country_id`, `parent_id`,
  `level smallint` (1..3), `code` (geoBoundaries shapeID / COD-AB p-code), `short_code`
  (2–3 letters, used in project codes), `name_ar`, `name_en`, `name_sw`,
  `geom geometry(MultiPolygon,4326)` GiST, `geom_simple geometry(MultiPolygon,4326)`.
  Unique `(country_id, level, code)`.
- `localities` S — std, `country_id`, `admin_area_id`, `name_ar`, `name_latin`, `name_norm`,
  `geom geometry(Point,4326)`, `status` (`proposed`|`approved`), `approved_by`, `approved_at`.

**Organisation**

- `branches` S — std, `country_id`, `code`, `name_ar`, `name_en`, `name_sw`,
  `admin_area_ids uuid[]`, `active`.

**Projects**

- `projects` S — std, `code` (server-generated `TZ-PN-000123`, null until first sync),
  `external_id` (import key, unique when not null), `name_ar` (required), `name_latin`,
  `type` (`mosque`|`school`|`combined`), `status` (`active`|`maintenance`|`building`|`inactive`),
  `capacity int`, `geom geometry(Point,4326)` GiST, `gps_accuracy_m real`,
  `location_source` (`gps`|`map`|`import`), `country_id`, `admin_area_id`, `locality_id`,
  `branch_id`, `builder`, `build_year smallint`, `build_date date` (optional),
  `record_state` (`draft`|`submitted`|`approved`|`returned`), `review_note`, `reviewed_by`,
  `reviewed_at`, `completeness smallint` (0..100, server-computed), `search_norm text`
  (trigger-maintained), `import_batch_id`, `migration_note` (v2-migration flag written by the
  collector's device, cleared by a reviewer — decision D9).
  On the wire (sync/RPC) geometry is `lon`/`lat` numbers, never WKB.
  Indexes: GiST(`geom`); GIN trgm on `name_ar`, `name_latin`, `search_norm`;
  `(country_id, status, type)`; `(branch_id)`; `(sync_xid, id)`.
  Triggers: `admin_area_id`/`country_id` computed from `geom` by `ST_Contains` on the deepest
  matching `admin_areas` level (client value is kept only when no polygon contains the point);
  `code` generated on first insert from a per-country counter; `completeness` recomputed
  when the project or any child row changes.
- `project_land` S (1:1, unique `project_id`) — `ownership`
  (`association`|`waqf`|`person`|`government`|`other`), `owner_name`, `area_m2`,
  `utilization_pct` (0..100), `expandable bool`, `notes`.
- `project_facilities` S (1:1) — `teacher_housing`, `imam_housing`, `guest_housing`, `library`,
  `hall` (bool), `quran_count`, `quran_need`, `hall_capacity` (int),
  `student_transport` (`available`|`needed`|`not_needed`),
  `students_origin` (`nearby`|`mixed`|`distant`).
- `project_maintenance` S (1:n) — `project_id`, `reported_on date`, `description`,
  `priority` (`low`|`medium`|`high`|`urgent`), `estimated_cost numeric`, `currency char(3)`,
  `state` (`open`|`in_progress`|`done`|`cancelled`), `resolved_on date`.
- `project_photos` S (1:n, max 10 live rows per project, one cover) — `project_id`,
  `storage_path_full`, `storage_path_thumb`, `taken_at`, `width`, `height`, `bytes`, `is_cover`,
  `category` (v2 list: `unspecified`|`mosque_front`|`mosque_inside`|`school_front`|
  `school_inside`|`land`|`facilities`|`maintenance`|`other`), `caption`,
  `upload_state` (`pending`|`uploaded`), `purged_at`.
- `donors` S — `name_ar`, `name_latin`, `name_norm`, `notes`.
- `project_donors` S — `project_id`, `donor_id`, `amount numeric`, `currency char(3)`,
  `year smallint`.

**People**

- `persons` S — `name_ar`, `name_latin`, `name_normalized` (trigger, GIN trgm), `phone_e164`,
  `gender` (`male`|`female`), `birth_year smallint`, `birth_date date` (optional),
  `home_admin_area_id`, `home_area_text`, `education_level`, `graduated_from`,
  `country_id`, `branch_id` (scope), `merged_into_id`.
- `person_merge_requests` S (supervisor+) — `source_person_id`, `target_person_id`,
  `state` (`pending`|`merged`|`rejected`|`reverted`), `reason`, `decided_by`, `decided_at`,
  `undo jsonb`.
- `project_staff` S — `project_id`, `person_id`,
  `role` (`imam`|`teacher`|`agent`|`administrator`|`manager`|`other`), `start_date`, `end_date`.
- `staff_compensation` **RESTRICTED** — `project_staff_id`, `monthly_amount numeric(14,2)`,
  `currency` (`TZS`|`KES`|`UGX`|`RWF`|`BIF`|`MZN`|`OMR`|`USD`), `effective_from date`.
- `fx_rates` S — `currency`, `usd_per_unit numeric`, `effective_date`. Never sum different
  currencies without conversion; reports return per-currency totals **and** USD.

**Community**

- `option_values` S — `list_key`, `code`, `name_ar`, `name_en`, `name_sw`, `sort_order`,
  `active`. List keys: `daawa_activities`, `social_features`, `livelihoods`,
  `religious_issues`, `religious_challenges`, `social_challenges`, `proposed_activities`.
- `community_profiles` S (1:1 project) — `branch_name`, `population`, `muslim_pct`, and for each
  list key a `uuid[]` column of `option_values.id` plus `<key>_other text` (free text only
  when "other" is chosen — v2 parity).
- `community_sensitive` **RESTRICTED** (1:1 project) — `ibadi_families`, `omani_families`,
  `omani_student_pct`, `ibadi_student_pct`, `omani_teacher_pct`, `ibadi_teacher_pct`,
  `guest_financial_capacity` (`good`|`limited`|`none`).

**Governance / operations**

- `profiles` (id = `auth.users.id`) — `full_name`, `phone`, `preferred_language`
  (`ar`|`sw`|`en`), `active`, `sessions_revoked_at`.
- `user_roles` — `user_id`, `role` (`field_collector`|`branch_supervisor`|`country_manager`|
  `hq_admin`|`viewer`), `scope_type` (`global`|`country`|`branch`), `scope_id`.
- `devices` — `user_id`, `device_id`, `label`, `user_agent`, `last_seen_at`, `last_push_at`,
  `last_pull_at`, `pending_ops int`, `pending_photos int`, `app_version`, `revoked_at`.
- `audit_log` (append-only, bigint identity).
- `sync_conflicts` S (supervisor+) — `table_name`, `row_id`, `project_id`, `field`,
  `base_version`, `server_value jsonb`, `client_value jsonb`, `client_user_id`,
  `client_device_id`, `client_op_id`, `state` (`open`|`resolved_server`|`resolved_client`),
  `resolved_by`, `resolved_at`.
- `sync_applied_ops` — `op_id uuid pk`, `user_id`, `device_id`, `result jsonb`, `applied_at`
  (idempotency ledger).
- `restricted_access_log` — who/when/which restricted rows were read.
- `export_jobs`, `notifications` S (own rows), `import_batches`, `import_rows`, `map_packs` S,
  `app_settings`, `private.rate_limit_buckets` (unlogged).

### 2.3 Roles, scope and RLS

RLS is enabled **and forced** on every table. Helper functions (all `STABLE`, `SECURITY
DEFINER`, wrapped as `(select private.fn())` inside policies so they run once per statement):

- `private.session_ok()` — false when the profile is inactive, the JWT `iat` is older than
  `profiles.sessions_revoked_at`, or the device (`x-device-id` request header) is revoked.
- `private.aal2()` — `auth.jwt()->>'aal' = 'aal2'`.
- `private.my_roles()` → rows `(role, scope_type, scope_id)`; returns nothing when
  `session_ok()` is false; `country_manager` and `hq_admin` rows are returned **only at aal2**
  (MFA is mandatory for them).
- `private.is_hq()`, `private.my_country_ids()`, `private.my_branch_ids()`,
  `private.can_read_project(country_id, branch_id)`, `private.can_write_project(...)`,
  `private.can_review(country_id, branch_id)`, `private.can_see_restricted(country_id)`,
  `private.can_see_people()`.

| Role                     | Read                                                                                     | Write                                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `field_collector`        | projects + children + persons in own scope; **never** restricted tables                  | own records (creator) in scope; edits to submitted/approved own records send them back to `submitted`; can add maintenance entries and photos to any project in scope |
| `branch_supervisor`      | as above for the branch                                                                  | everything in branch; approve/return; approve localities; merge persons; resolve conflicts                                                                            |
| `country_manager` (aal2) | everything in country incl. restricted (logged)                                          | everything in country                                                                                                                                                 |
| `hq_admin` (aal2)        | everything                                                                               | everything + users, countries, branches, option lists, fx                                                                                                             |
| `viewer`                 | projects, public children, aggregated reports; **no** persons, staff, phones, restricted | nothing                                                                                                                                                               |

- Field data tables are written **only** through `sync_push` (SECURITY DEFINER with the
  helper checks above); `authenticated` has no direct INSERT/UPDATE/DELETE on them.
- Reference/admin tables (`countries`, `admin_areas`, `branches`, `option_values`, `fx_rates`,
  `user_roles`, `profiles`, `map_packs`) allow direct DML to `hq_admin` via RLS policies.
- **Restricted tables have no direct grants at all.** They are read only through logged
  SECURITY DEFINER functions (`restricted_read`, the restricted section of `sync_pull`,
  payroll reports) and written only through `sync_push`.
- Phones are masked (`private.mask_phone`) in anything a `viewer` can reach.

### 2.4 RPC surface (public functions exposed through PostgREST)

| Function                                                                                                                                                                                                                                                                 | Notes                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `my_context()` → jsonb                                                                                                                                                                                                                                                   | profile, roles, scopes, `aal`, capability flags, `scope_epoch`                                                                               |
| `register_device(p_device_id text, p_label text, p_app_version text)`                                                                                                                                                                                                    | upsert device, returns `{revoked}`                                                                                                           |
| `sync_push(p_ops jsonb, p_device_id text)` → jsonb                                                                                                                                                                                                                       | §3.1                                                                                                                                         |
| `sync_pull(p_cursor jsonb, p_limit int default 500)` → jsonb                                                                                                                                                                                                             | §3.2                                                                                                                                         |
| `locate_point(p_lon float8, p_lat float8)` → jsonb                                                                                                                                                                                                                       | country + admin chain + nearby localities                                                                                                    |
| `admin_area_shapes(p_country_id uuid, p_level int)` → jsonb                                                                                                                                                                                                              | simplified GeoJSON for offline geofill (levels 1–2)                                                                                          |
| `project_duplicates(p_type text, p_lon float8, p_lat float8, p_name text, p_locality_id uuid, p_exclude_id uuid)` → jsonb                                                                                                                                                | same type within 150 m, or similar name in same locality                                                                                     |
| `person_candidates(p_name text, p_phone text, p_admin_area_id uuid)` → jsonb                                                                                                                                                                                             | phone match, trigram ≥ 0.6, same area; never merges                                                                                          |
| `merge_persons(p_source uuid, p_target uuid, p_reason text)`, `revert_person_merge(p_request_id uuid)`                                                                                                                                                                   | supervisor+                                                                                                                                  |
| `request_person_merge(p_source, p_target, p_reason)`, `resolve_person_merge_request(p_request_id, p_decision, p_note)`                                                                                                                                                   | a collector (or the v2 migration) proposes, a supervisor approves/rejects (D12)                                                              |
| `merge_localities(p_source, p_target)`, `revert_locality_merge(p_merge_id)`                                                                                                                                                                                              | supervisor+: duplicate villages (D14)                                                                                                        |
| `report_device_status(p_device_id, p_pending_ops, p_pending_photos, p_app_version)`                                                                                                                                                                                      | every device reports its queue for the sync-status dashboard                                                                                 |
| `user_display_names(p_ids uuid[])`, `server_info()`                                                                                                                                                                                                                      | names of creators/reviewers in scope; server time + version                                                                                  |
| `resolve_conflict(p_conflict_id uuid, p_choice text)`                                                                                                                                                                                                                    | `server`\|`client`                                                                                                                           |
| `search(p_q text, p_limit int default 20, p_kinds text[] default null)` → jsonb                                                                                                                                                                                          | projects (ar/latin/code), localities, staff names, donors                                                                                    |
| `projects_page(p_filters jsonb, p_after jsonb, p_limit int default 50)` → jsonb                                                                                                                                                                                          | keyset, never OFFSET                                                                                                                         |
| `tile_projects(z int, x int, y int, p_filters jsonb default '{}')` → bytea                                                                                                                                                                                               | MVT, layers `clusters`/`points`/`needs`                                                                                                      |
| `restricted_read(p_table text, p_project_ids uuid[])` → jsonb                                                                                                                                                                                                            | logged                                                                                                                                       |
| `dashboard(p_scope_type text, p_scope_id uuid)` → jsonb                                                                                                                                                                                                                  | from materialized views                                                                                                                      |
| `report_project(p_id uuid)`, `report_donor(p_id uuid)`, `report_country(p_id uuid)` → jsonb                                                                                                                                                                              | data for print/PDF views                                                                                                                     |
| `import_template(p_lang)`, `import_stage(p_meta jsonb, p_rows jsonb)`, `import_preview(p_batch_id, p_after, p_limit, p_only)`, `import_set_action(p_batch_id, p_row_no, p_action, p_target_id)`, `import_commit(p_batch_id uuid)`, `import_rollback(p_batch_id uuid)`    | merge by `external_id`, never replace; per-row action (create / update / skip) chosen in the preview                                         |
| `export_columns(p_lang)`, `export_request(p_format text, p_lang text, p_filters jsonb)`, `export_rows(p_job_id uuid, p_after jsonb, p_limit int)`, `export_cancel(p_job_id)`                                                                                             | used by the `export` Edge Function with the caller's JWT; the download link is issued by the function, never signed in the browser           |
| `admin_set_role(...)`, `admin_remove_role(...)`, `admin_revoke_sessions(p_user_id uuid, p_device_id text default null)`, `admin_restore_device(p_user_id, p_device_id)`, `admin_set_user_active(p_user_id, p_active)`, `admin_users(p_search, p_limit)`, `sync_status()` | hq_admin; a country manager ends sessions and blocks/restores devices of the users of their own country (D16); sync status also for managers |
| `refresh_reports()` (private, not exposed)                                                                                                                                                                                                                               | cron every 15 minutes (`pg_cron` in production, gateway timer locally)                                                                       |

Custom errors use `raise exception ... using errcode = 'PTxxx'` so PostgREST maps them to HTTP
status (`PT403` forbidden, `PT409` conflict, `PT422` validation, `PT429` rate limit).

## 3. Sync protocol

### 3.1 Push

Client `outbox` rows are sent in batches of ≤ 50, ordered parent-before-child, through one
call (one transaction; each op runs in its own sub-transaction so a bad op cannot abort the
batch):

```jsonc
// request: sync_push(p_ops, p_device_id)
[{ "op_id": "<uuidv7>", "table": "projects", "id": "<uuidv7>", "kind": "upsert" | "delete",
   "base_version": 0,            // 0 = row was created on this device
   "fields": { "name_ar": "…", "lon": 39.7, "lat": -5.05 },   // only changed fields on update
   "client_ts": "2026-10-03T10:00:00Z" }]
// response
{ "results": [{ "op_id": "…", "status": "applied" | "merged" | "conflict" | "rejected" | "duplicate",
                "version": 3, "conflict_ids": ["…"], "error": { "code": "…", "message": "…" } }],
  "server_time": "…" }
```

Rules (field-level merge):

1. `op_id` already in `sync_applied_ops` → return the stored result (`duplicate`), do nothing.
2. Row missing → authorise + insert (`applied`). Insert of an existing id with identical
   creator → treated as update.
3. `base_version = current version` → apply (`applied`).
4. `base_version < current` → fields changed on the server since `base_version` come from
   `audit_log` (changes made by the **same device** are ignored). Disjoint field sets →
   apply (`merged`). Overlapping fields with different values → one `sync_conflicts` row per
   field, non-conflicting fields still applied (`conflict`). A supervisor resolves each
   conflict with `resolve_conflict`.
5. Authorisation/validation failure → `rejected` with an error code; the client parks the op
   in a "needs attention" list and continues.

Workflow transitions travel as ordinary field changes (`record_state`, `review_note`,
`localities.status`) and are validated server-side per role.

Restricted rows (`staff_compensation`, `community_sensitive`) entered by a field collector
live only in the local `restricted_local` store until `sync_push` acknowledges them, then
they are deleted from the device.

### 3.2 Pull

Every syncable row carries `sync_xid` = id of the transaction that last wrote it.
A pull round fixes `hi = pg_snapshot_xmin(pg_current_snapshot())` and returns rows with
`lo ≤ sync_xid < hi`, so rows from still-running transactions are never skipped; they simply
arrive in the next round. Pages are keyset-ordered by `(sync_xid, id)` per table.

> **Operational consequence (observed 2026-10-04):** the snapshot xmin is **cluster-wide**.
> Any long transaction on the same PostgreSQL server — in any database — holds `hi` back, and
> rows written after it starts reach devices only when it ends. Locally this happened while
> load data was generated in another database (`imap_load`): a conflict inserted in
> `istiqama` arrived minutes later. In production keep long-running work (bulk loads,
> `pg_dump` in a repeatable-read snapshot, long reports) off the primary or short, and watch
> `pg_stat_activity.backend_xmin` age in monitoring.

```jsonc
// request: sync_pull(p_cursor, p_limit)        first call: p_cursor = null
// response
{ "changes": [{ "table": "projects", "rows": [{ "id": "…", "version": 3, "deleted_at": null, "lon": …, "lat": … }] }],
  "cursor": { "lo": 123, "hi": 456, "t": 7, "x": 300, "id": "…" },   // opaque to the client
  "done": false, "server_time": "…", "scope_epoch": "…" }
```

- Rows are filtered to the caller's scope by the same helpers RLS uses. `viewer` never
  receives people tables. Restricted tables are included only for `country_manager`/`hq_admin`
  and each page is written to `restricted_access_log`.
- Tombstones are rows with `deleted_at` set.
- When `scope_epoch` (hash of the caller's roles) changes, the client wipes scoped tables
  and starts again from `null`.
- Table order: `countries`, `admin_areas`, `branches`, `option_values`, `fx_rates`,
  `localities`, `donors`, `projects`, `project_land`, `project_facilities`,
  `project_maintenance`, `project_photos`, `project_donors`, `persons`, `project_staff`,
  `community_profiles`, `staff_compensation`_, `community_sensitive`_,
  `person_merge_requests`, `sync_conflicts`, `notifications`, `map_packs` (* restricted).

### 3.3 Photos

Compressed on device (full ≤ 1600 px q0.8, thumb 400 px; WebP, JPEG fallback), EXIF stripped
except capture time, stored as Blobs in IndexedDB, uploaded with TUS resumable uploads to
bucket `photos` at `projects/{iso2}/{project_id}/{photo_id}_{full|thumb}.webp`, optional
"Wi-Fi only". The `project_photos` row syncs through the outbox; `upload_state` flips to
`uploaded` when both objects exist. Thumbnails are shown in lists/map; full images are
fetched on demand through short-lived signed URLs.

## 4. Web app (`apps/web`)

Preact + `@preact/signals`, TypeScript strict, Vite, `vite-plugin-pwa` (Workbox,
`injectManifest`). Initial JS ≤ 200 kB gzip: MapLibre, PMTiles, XLSX parsing, Sentry and admin
screens are lazy chunks. Self-hosted Tajawal (`@fontsource/tajawal`). Corporate palette: navy
`#0f2545` + gold `#c8a24a`. All CSS uses logical properties; `dir`/`lang` are set on `<html>`
from the active locale (ar = RTL default; sw, en = LTR).

Module list as built (2026-10-04; ownership and public APIs: `docs/contracts/web.md`):

```
src/
  main.tsx, app.tsx, routes.ts (history router, per-view filters), env.ts,
  version.ts (__APP_VERSION__ from package.json), sw.ts (Workbox injectManifest),
  contract.typecheck.ts (type assertions of the module contract)
  lib/        normalize, uuidv7, geo (haversine, point-in-polygon), similarity, csv, prefs
              (the ONLY localStorage access), debounce, completeness
  i18n/       state (locale signal, dir, Intl tags; Arabic uses Western digits), index (t,
              setLocale, lazy dictionaries), format (number/date/currency), names (pickName)
  ui/         Badge, Button, Chips, ConfirmDialog, EmptyState, Field (inline errors), Link,
              Modal (focus trap, Esc asks), Select, Spinner, SyncBadge, Toast, VirtualList,
              appSettings (staging badge), monitoring (Sentry, lazy), shell/ (Shell, Topbar,
              Navigation: sidebar ≥ 900 px, bottom bar map·projects·add·maintenance·reports +
              "more" sheet, Banners offline/update, AccountCard, RouteOutlet), pwa/ (register,
              CSP, icon generator)
  db/         dexie (schema `istiqama-map`), tables (syncable registry), apply (pull),
              write (local writes + outbox), ack (push results), bundle (project + children),
              list (keyset pages), search (local index), match, meta, blobs, derive, tokens
  auth/       supabase (client), session, store, LoginView (e-mail / phone OTP), MfaView
              (TOTP enrol + verify), PinSetup, PinLock, vault (session token encrypted under a
              PIN-derived key, WebCrypto), idle (15-minute lock), device (device id), context
              (my_context → capability flags), AuthGate
  sync/       engine (online event, every 2 min, "sync now"), push (≤ 50 ops), pull (500 rows),
              transport, photoQueue + tusUploader (resumable, Wi-Fi only), status (badge),
              storage (persist/estimate), network, locks, backoff, clock, device
  photos/     compress (1600/400 px, WebP→JPEG), exif (keep capture time only), PhotoEditor,
              Gallery, PhotoThumb, persist (blobs in IndexedDB), detached (photos finished
              after the form closed), urls (signed URLs for full size), storage
  map/        MapPage, MapView, mapEngine (MapLibre lazy chunk), style, layers (clusters,
              points, needs heat maps), tiles (MVT from tile_projects < z14, local points ≥ z14),
              basemapProtocol/basemapRuntime (PMTiles online or from an offline pack),
              packs/packStore/packsRuntime + PacksSection (offline map packs), PickerDialog
              (pick on map), locate (one "my location" marker), SelectedProjectCard, glyphs
  projects/   ProjectFormPage + form/ (sections in brief §7.1 order: type, name, location,
              place auto-filled, status, photos, then folded optional sections; autosaved
              drafts, validation next to each field, duplicates, geo checks, completeness),
              ProjectsPage + ProjectList (virtualised keyset register), ProjectDetailsPage,
              MaintenancePage, IncompletePage, ReviewPage (submitted, conflicts, proposed
              villages, operations that need attention), ReturnDialog
  people/     PeoplePage (directory + merge requests tabs), PersonCard, PersonForm,
              PersonPicker (candidates: phone, trigram ≥ 0.6, area — never merges),
              MergeDialog, MergeRequests
  reports/    ReportsPage + Dashboard (per scope, from materialized views), charts, AreaMap,
              ExportPanel (async CSV/XLSX jobs) + NotificationsBell, PrintPage (project card,
              donor report, country report — print-optimised pages, D4)
  import/     ImportPage (template → upload → preview with per-row action → commit →
              history with rollback)
  migration/  V2MigrationPrompt (first run on a device holding v2 keys), MigrationDialog
              (summary → upload as drafts → report), V2ImportSection (v2 JSON files), runner,
              v2read/v2map (v2 shapes → v3 rows, no person merging)
  admin/      AdminPage: UsersPanel (+ CreateUserDialog, RoleDialog, revoke sessions/devices),
              CountriesPanel, BranchesPanel, OptionsPanel, FxPanel, MapPacksPanel,
              SettingsPanel, SyncStatusPanel
  settings/   SettingsPage: LanguageSection, StorageSection (usage, pending, Wi-Fi only),
              map packs (from src/map), SecuritySection (PIN change, lock now, sign out),
              v2 import, AboutSection
```

UI strings: fragments `apps/web/locales/_parts/<namespace>.{ar,sw,en}.json` merged by
`npm run locales -w apps/web` into `locales/{ar,sw,en}.json`; the labels of enumerated values
(`enum.*`) are generated from `private.enum_labels` by `scripts/gen-enum-locales.ts` (D11).

Local database (Dexie, name `istiqama-map`): one store per syncable table keyed by `id`
(+ indexes needed for lists and search), plus local-only stores `outbox`, `photo_blobs`,
`drafts`, `meta`, `restricted_local`, `packs`, `failed_ops`. `localStorage` holds UI
preferences only.

Testing hooks: interactive elements carry stable `data-testid` attributes
(`nav-map`, `add-project`, `form-name`, `sync-badge`, `sync-now`, …).

## 5. Map

MapLibre GL JS (CSP worker build) + `pmtiles` protocol. Basemap: Protomaps PMTiles for East
Africa on our own storage (`VITE_TILES_URL`), glyphs/sprites self-hosted. Never
`tile.openstreetmap.org`.

- zoom < 14: vector tiles from `tile_projects` (server-side clustering from a materialized
  cluster pyramid); `needs` layer feeds heat maps (maintenance, Qurans, housing).
- zoom ≥ 14: individual points from the local database for the current viewport.
- Offline packs: pre-built per-region PMTiles (`scripts/build-pmtiles`), listed in
  `map_packs` with byte size shown before download, stored in OPFS/IndexedDB and read through
  a custom PMTiles source.

## 6. Edge Functions (`supabase/functions`)

Deno-compatible TypeScript with a shared `_shared/` folder; each `index.ts` exports a
`handler(req: Request): Promise<Response>` and calls `Deno.serve(handler)` only when `Deno`
exists, so the local gateway can load the same file under Node. Bare import specifiers are
mapped in `supabase/functions/deno.json`.

`sync_push`, `sync_pull` (thin rate-limited wrappers around the RPCs), `tiles` (cache headers
around `tile_projects`), `export` (async CSV/XLSX → `exports` bucket → notification),
`import` (server-side CSV/XLSX parsing → `import_stage`), `admin` (session revocation through
the Auth admin API), `purge-photos` (90-day retention), `otp-hook` (pluggable SMS provider;
`fake` in development).

## 7. Security baseline

Strict CSP (no external scripts, no inline scripts), HSTS, service-role key only in Edge
Functions, DB-level rate limiting for RPC and upload paths, audit log on every table, logged
reads of restricted tables, PIN lock after 15 minutes idle with the session token encrypted
under a PIN-derived key, immediate session/device revocation.

## 8. Decisions that deviate from or extend the brief

| #   | Decision                                                                                                                      | Why                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| D1  | Local development uses portable PostgreSQL + real PostgREST + a Supabase-compatible gateway instead of the Supabase CLI stack | No Docker on the development machine; CI still runs the real Supabase stack         |
| D2  | `sync_xid` + snapshot-xmin cursor instead of timestamps                                                                       | Timestamps and plain sequences can skip rows committed out of order                 |
| D3  | Restricted tables are reachable only through logged functions                                                                 | PostgreSQL has no SELECT triggers; this is the only way to guarantee the access log |
| D4  | PDF reports are print-optimised pages rendered by the browser engine                                                          | Correct Arabic shaping and RTL without shipping a PDF/shaping engine                |
| D5  | `admin_area_id` is computed from the point when a boundary contains it; a manual value is kept only when no boundary matches  | Reconciles brief §2.3 (computed) with §7.1 (correctable)                            |
| D6  | Photo `category`/`caption`, `birth_date`, `home_area_text`, `<list>_other` kept                                               | v2 parity (brief rule: no v2 feature removed without replacement)                   |

Decisions taken while building (Units 1–4). Owner-level questions are tracked in
`docs/OWNER_DECISIONS.md`; the rows marked _interim_ apply one of those temporary rules.

| #   | Decision                                                                                                                                                                                                                                                          | Why                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| D7  | _Interim_ (owner item ح): `viewer` sees **approved** projects only (and their public children) on every path — map, lists, search, dashboards, print, export, sync                                                                                                | The viewer role serves donor relations ("public reports"); drafts are not public. Removing it = one predicate (`authz.md` §4.2 note 6) |
| D8  | _Interim_ (owner item ز): any edit by a field collector to a submitted/approved record sends it back to `submitted`                                                                                                                                               | A supervisor must see every field change before it counts as approved                                                                  |
| D9  | v2-migration flag in its own column `projects.migration_note` (owner item أ, migration 0073), not in `review_note`                                                                                                                                                | `review_note` belongs to the reviewer and the server drops it from collectors                                                          |
| D10 | Restricted rows written by a collector are **blind writes**: matched by natural key (`(project_staff_id, effective_from)`, `project_id`), answered `{applied, version:null}`, never read back, removed from the device after the acknowledgement (`sync.md` §4.4) | Brief §3: restricted data never travels to collector devices                                                                           |
| D11 | Labels of enumerated values (types, statuses, roles, …) have one source: `private.enum_labels` (migration 0053) → generated `enum.*` locale fragments and the export dictionary                                                                                   | The UI, CSV/XLSX export and print show the same words in ar/sw/en                                                                      |
| D12 | Collectors **request** person merges (`request_person_merge`); supervisors decide. The v2 migration creates persons and merge **suggestions**, never merges                                                                                                       | Brief §2.4 forbids automatic merging; v2 names still need a human decision                                                             |
| D13 | Map labels use self-hosted Noto Sans SDF glyphs (Arabic + Latin, OFL) in `public/map/`; the UI uses Tajawal                                                                                                                                                       | MapLibre needs PBF glyph ranges; no external font host                                                                                 |
| D14 | Duplicate villages are merged by a supervisor (`merge_localities`) and can be reverted                                                                                                                                                                            | Proposed villages typed in the field often duplicate approved ones                                                                     |
| D15 | Every device reports its queue (`report_device_status`); the sync-status dashboard lists users/devices with pending, failed and stale work                                                                                                                        | Brief §1 "sync-status dashboard"; supervisors find phones that never sync                                                              |
| D16 | A country manager ends sessions and blocks or restores devices of the users **of their own country**; accounts, roles and lists stay with head office                                                                                                             | Lost phones must be revoked without waiting for head office                                                                            |
| D17 | Export files are downloaded through a link issued by the `export` function for the caller's own live job; the browser never signs export URLs                                                                                                                     | Exports may contain payroll columns                                                                                                    |
| D18 | Arabic numbers use Western digits (`ar-u-nu-latn`, one constant in `src/i18n/state.ts`)                                                                                                                                                                           | Codes, coordinates and phone numbers read the same in all languages                                                                    |
| D19 | Lighthouse cannot be installed on the development machine: `scripts/lighthouse/` measures the same categories through Chrome DevTools Protocol locally; CI runs the real Lighthouse (`docs/CI.md`)                                                                | No downloads allowed locally                                                                                                           |
| D20 | The user-guide screenshots are regenerated by `apps/web/tests/e2e/screenshots.spec.ts` (`GUIDE_SCREENS=1`) and `docs/screens/optimize.py`                                                                                                                         | Guides stay true to the shipped screens                                                                                                |

## 9. What exists (2026-10-04)

| Area                                                                                                  | Where                                                                                                   | Verified by                                                                                                             |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Schema, RLS, sync, geo/search/tiles, people, admin, reports, import/export, retention, reference data | `supabase/migrations/` (50 files, ranges of Appendix A.2 + 0070–0073 integration/follow-ups)            | pgTAP `supabase/tests/` (34 files, 2 331 assertions)                                                                    |
| Edge Functions                                                                                        | `supabase/functions/{sync_push,sync_pull,tiles,export,import,admin,purge-photos,otp-hook}` + `_shared/` | functions smoke (93 checks, `supabase/functions/smoke.ts`)                                                              |
| Web app                                                                                               | `apps/web/src/*` (§4)                                                                                   | Vitest (2 197 tests, all modules); Playwright 17/17 incl. acceptance criteria 3 (field), 4 (conflict), 6 (v2 migration) |
| Live integration (app modules against the running stack)                                              | `apps/web/vitest.integration.config.ts`                                                                 | 51 live checks                                                                                                          |
| Local stack                                                                                           | `scripts/local-stack/`                                                                                  | `stack:status`, gateway self-checks                                                                                     |
| Boundaries                                                                                            | `scripts/import-boundaries/`                                                                            | 9 776 admin areas for the 7 countries (staging)                                                                         |
| Basemap and offline packs                                                                             | `scripts/build-pmtiles/`                                                                                | unit tests; packs listed in `map_packs`                                                                                 |
| Load data and k6                                                                                      | `scripts/generate-load-data/`, `load-tests/`                                                            | report in `load-tests/results/report.md` (Unit 5, in progress)                                                          |
| Backup / restore drill                                                                                | `scripts/backup/` (dump, restore, drill, photo replication)                                             | `docs/RUNBOOK.md` (Unit 5)                                                                                              |
| CI/CD                                                                                                 | `.github/workflows/ci.yml`, `deploy.yml`                                                                | `docs/CI.md`                                                                                                            |
| User guides                                                                                           | `docs/USER_GUIDE_ar.md`, `docs/USER_GUIDE_sw.md`, `docs/screens/{ar,sw}/`                               | screenshots spec (D20)                                                                                                  |

---

## Appendix A — Exact names shared between migrations (binding)

### A.1 Supabase default privileges (do not forget)

On Supabase every new table/function/sequence in `public` is automatically granted to `anon`,
`authenticated` and `service_role` (the local shim reproduces this). Therefore **each
migration explicitly revokes** what must not be reachable: `revoke all on <table> from anon`
for every table, `revoke insert, update, delete` on field-data tables from `authenticated`,
`revoke all` on restricted tables from `authenticated`, and
`revoke execute on function … from public, anon` for every RPC (then
`grant execute … to authenticated`). pgTAP verifies that `anon` can read nothing.

### A.2 Migration file names and ownership

`supabase/migrations/20261003<NNNN>00_<name>.sql` where `NNNN` is a 4-digit sequence:

| Range     | Area                                                                                                                                |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 0001–0009 | extensions, `private` helpers (`norm`, `uuid_v7`, `current_xid`…), all tables, indexes, std/audit triggers, derived-column triggers |
| 0010–0019 | authorisation helpers, RLS policies, grants/revokes, storage buckets + policies                                                     |
| 0020–0029 | sync registry, `sync_push`, `sync_pull`, `resolve_conflict`, `my_context`, `register_device`                                        |
| 0030–0039 | `locate_point`, `admin_area_shapes`, `project_duplicates`, `search`, `projects_page`, cluster pyramid + `tile_projects`             |
| 0040–0049 | `person_candidates`, merge/revert, `restricted_read`, admin RPCs, `sync_status`, rate limiting                                      |
| 0050–0059 | report materialized views, `dashboard`, `report_*`, import, export, cron jobs, photo retention                                      |
| 0060–0069 | reference data (countries, option lists, fx placeholders, app settings)                                                             |

pgTAP files: `supabase/tests/<NN>_<name>.test.sql`, each wrapped in `begin; … rollback;`
except `00_helpers.test.sql`, which installs the persistent `tests` schema.

### A.3 `private` helpers

```sql
private.current_xid() returns bigint            -- pg_current_xact_id() as bigint
private.safe_xid()    returns bigint            -- pg_snapshot_xmin(pg_current_snapshot()) as bigint
private.device_id()   returns text              -- request header x-device-id, else current_setting('app.device_id', true)
private.norm(text)    returns text  immutable   -- search normalisation (Arabic + Latin)
private.uuid_v7()     returns uuid
private.mask_phone(text) returns text immutable -- +255•••••123

-- session / role state (STABLE, SECURITY DEFINER, search_path pinned)
private.session_ok() returns boolean
private.aal2()       returns boolean
private.my_roles()   returns table(role text, scope_type text, scope_id uuid)
private.is_hq()      returns boolean                         -- hq_admin at aal2

-- scope triples: all_access + country ids + branch ids, per capability
private.read_all()        returns boolean;  private.read_countries()        returns uuid[];  private.read_branches()   returns uuid[]   -- any role
private.people_all()      returns boolean;  private.people_countries()      returns uuid[];  private.people_branches() returns uuid[]   -- any role except viewer
private.write_all()       returns boolean;  private.write_countries()       returns uuid[];  private.write_branches()  returns uuid[]   -- collector, supervisor, manager, hq
private.review_all()      returns boolean;  private.review_countries()      returns uuid[];  private.review_branches() returns uuid[]   -- supervisor, manager, hq
private.restricted_all()  returns boolean;  private.restricted_countries()  returns uuid[]                                              -- manager (country), hq

-- row-level convenience wrappers built on the triples
private.can_read_project(p_country uuid, p_branch uuid)  returns boolean
private.can_see_people(p_country uuid, p_branch uuid)    returns boolean
private.can_write_project(p_country uuid, p_branch uuid) returns boolean
private.can_review(p_country uuid, p_branch uuid)        returns boolean
private.can_see_restricted(p_country uuid)               returns boolean
private.project_scope(p_project uuid) returns table(country_id uuid, branch_id uuid, created_by uuid, record_state text)
private.rate_limit(p_key text, p_max int, p_window interval) returns void   -- raises PT429
private.log_restricted(p_table text, p_ids uuid[], p_context text) returns void
```

A branch-scoped role matches rows whose `branch_id` equals the scope; a country-scoped role
matches rows whose `country_id` equals the scope; a global scope matches everything.
In RLS policies always call them as `(select private.read_all())` etc. (initplan caching).

### A.4 pgTAP helpers (`tests` schema, installed by `supabase/tests/00_helpers.test.sql`)

```sql
tests.create_user(p_email text, p_role text, p_scope_type text, p_scope_id uuid) returns uuid
tests.login_as(p_user uuid, p_aal text default 'aal2', p_device text default 'dev-test') returns void
       -- set local role authenticated; request.jwt.claims = {sub, role, aud, aal, iat, session_id}; request.headers = {"x-device-id": …}
tests.login_anon() returns void
tests.logout() returns void                      -- reset role and claims (back to the superuser running the test)
tests.fixture() returns void                     -- idempotent base fixture (call inside the test transaction)
tests.id(p_key text) returns uuid                -- ids of fixture objects
```

Fixture keys: countries `tz`, `ke`; admin areas `tz_pemba_north`, `tz_tanga`, `ke_mombasa`
(simple square polygons); branches `br_pemba`, `br_tanga`, `br_mombasa`; users `u_hq`,
`u_mgr_tz`, `u_mgr_ke`, `u_sup_pemba`, `u_col_pemba`, `u_col_pemba2`, `u_col_tanga`,
`u_col_ke`, `u_viewer_tz`, `u_viewer_global`; projects `p_pemba_1` (approved, by
`u_col_pemba`), `p_pemba_2` (draft, by `u_col_pemba`), `p_tanga_1` (approved, by
`u_col_tanga`), `p_ke_1` (approved, by `u_col_ke`); each project has one staff member with a
compensation row and a `community_sensitive` row.

### A.5 JWT claims (GoTrue-compatible; issued locally by the gateway)

`{ sub, role: "authenticated", aud: "authenticated", email, phone, aal: "aal1"|"aal2",
amr: [{method, timestamp}], session_id, iat, exp, app_metadata, user_metadata }`.
Anonymous/API-key requests carry `role: "anon"`. The service key carries `role: "service_role"`.

### A.6 Local gateway endpoints (subset of the Supabase API that the app uses)

- `POST /auth/v1/otp` (email or phone, `create_user`), `POST /auth/v1/verify`,
  `POST /auth/v1/token?grant_type=refresh_token|password`, `GET /auth/v1/user`,
  `PUT /auth/v1/user`, `POST /auth/v1/logout`, MFA TOTP:
  `POST /auth/v1/factors`, `POST /auth/v1/factors/:id/challenge`,
  `POST /auth/v1/factors/:id/verify`, `DELETE /auth/v1/factors/:id`; admin (service key):
  `POST/GET/PUT/DELETE /auth/v1/admin/users[/:id]`, `POST /auth/v1/admin/users/:id/logout`.
- Development only: `GET /dev/otp?identifier=<email|phone>` returns the last OTP issued by the
  fake provider (used by Playwright); disabled unless `OTP_PROVIDER=fake`.
- `/rest/v1/*` → PostgREST. `/storage/v1/object/*` (upload, download, `sign`, `public`,
  `list`, delete) and TUS `/storage/v1/upload/resumable` backed by `.local/storage`, with
  access decided by inserting/selecting `storage.objects` under the caller's role (RLS).
- `/functions/v1/<name>` → `supabase/functions/<name>/index.ts` handler.
- Timers replacing `pg_cron`: `refresh_reports()` every 15 min, `purge-photos` daily.

# Authorisation contract (migrations 0010–0019)

What is implemented for brief §3 / ARCHITECTURE §2.3 + Appendix A: the helper functions, the
table privileges, every RLS policy, the storage policies and the pgTAP harness.
Read this instead of the SQL. Source files:

| File | Content |
|---|---|
| `20261003001000_authz_helpers.sql` | `private.*` helpers (Appendix A.3) |
| `20261003001100_rls_baseline_grants.sql` | RLS on + forced everywhere, all grants/revokes |
| `20261003001200_rls_reference_admin.sql` | policies: reference tables, `profiles`, `user_roles`, `devices`; profile column guard; last-hq_admin guard |
| `20261003001300_rls_field_data.sql` | policies: projects, children, people, localities, donors, conflicts, notifications |
| `20261003001400_rls_logs_jobs_restricted.sql` | policies: logs, job tables; restricted tables (none) |
| `20261003001500_storage_buckets_policies.sql` | buckets + `storage.objects` policies |
| `supabase/tests/00_helpers.test.sql` | `tests.*` harness and fixtures (Appendix A.4) |
| `supabase/tests/10…16_*.test.sql` | 886 assertions proving the matrix below (isolation, roles, restricted + logs, admin tables, session/MFA, storage, catalog) |

## 1. Model in one page

- **Three API roles.** `anon` has nothing (no privilege, no policy, no function). `authenticated`
  is every signed-in user; what a user may do is decided by `user_roles` rows through the helpers
  below. `service_role` (Edge Functions only) and the migration role bypass RLS.
- **Direct SQL (PostgREST tables) is a read path only.** `authenticated` can `SELECT` rows of
  its scope and, as `hq_admin`, `INSERT`/`UPDATE` reference and admin tables. Field data is
  written **only** through SECURITY DEFINER RPCs (`sync_push`, import, merge, …). Nobody holds
  `DELETE`/`TRUNCATE` (soft delete = `UPDATE deleted_at`).
- **Restricted tables** (`staff_compensation`, `community_sensitive`) and the sync ledger
  (`sync_applied_ops`) have **no privilege and no policy** for API roles — not even `hq_admin`
  can read them with direct SQL. They are reachable only through SECURITY DEFINER functions that
  call `private.can_see_restricted()` / `restricted_*()` **and** `private.log_restricted()`.
  The same holds for the two side doors that carry restricted values: `audit_log` rows of the
  restricted tables and `sync_conflicts` rows whose `table_name` is a restricted table are
  invisible to direct SQL for everybody.
- **Scope rule (Appendix A.3).** A role grant is `(role, scope_type, scope_id)`:
  `global` matches every row, `country` matches rows whose `country_id = scope_id`, `branch`
  matches rows whose `branch_id = scope_id`. Nothing else is inferred (a country scope does
  *not* match a row with a NULL `country_id` through its branch).
- **Session gate.** Every helper returns "nothing" unless `private.session_ok()`:
  profile exists, `active`, not soft-deleted; JWT `iat` ≥ `profiles.sessions_revoked_at` (when
  set; a token without `iat` fails); the device in the `x-device-id` header is not revoked for
  this user. A revocation therefore takes effect on the next statement.
- **MFA gate.** `country_manager` and `hq_admin` grants count only when the JWT has
  `aal = 'aal2'`. At AAL1 those users are signed-in users without any role (they can read
  reference data, their own profile and their own `user_roles` rows — the app uses that to ask
  for MFA).

## 2. Helpers (`private`, all `STABLE SECURITY DEFINER`, `search_path = public, extensions, private, pg_temp`)

```sql
private.session_ok() returns boolean
private.aal2()       returns boolean
private.my_roles()   returns table(role text, scope_type text, scope_id uuid)
private.is_hq()      returns boolean            -- hq_admin + global + aal2

-- scope triples; arrays are never NULL ('{}' when empty)
private.read_all()        boolean;  private.read_countries()        uuid[];  private.read_branches()   uuid[]  -- any role
private.people_all()      boolean;  private.people_countries()      uuid[];  private.people_branches() uuid[]  -- all but viewer
private.write_all()       boolean;  private.write_countries()       uuid[];  private.write_branches()  uuid[]  -- collector, supervisor, manager, hq
private.review_all()      boolean;  private.review_countries()      uuid[];  private.review_branches() uuid[]  -- supervisor, manager, hq
private.restricted_all()  boolean;  private.restricted_countries()  uuid[]                                     -- manager, hq

-- single-row wrappers; return false (never NULL) for NULL arguments
private.can_read_project(p_country uuid, p_branch uuid)  returns boolean
private.can_see_people(p_country uuid, p_branch uuid)    returns boolean
private.can_write_project(p_country uuid, p_branch uuid) returns boolean
private.can_review(p_country uuid, p_branch uuid)        returns boolean
private.can_see_restricted(p_country uuid)               returns boolean   -- country or global only

private.project_scope(p_project uuid)
  returns table(country_id uuid, branch_id uuid, created_by uuid, record_state text)

-- added by this area (not in Appendix A.3)
private.photo_object_project(p_name text) returns uuid   -- project id of a photos object name, NULL if malformed
private.photo_object_writable(p_name text) returns boolean -- may the caller create/replace this photos object (§4.4)
private.tg_profiles_guard()                              -- trigger t05_guard on profiles
private.tg_keep_hq_admin()                               -- triggers t85_keep_hq_admin on user_roles, profiles (§4.1)
private.authz_scope_all(text[]) / authz_scope_ids(text[], text) / authz_can(text[], uuid, uuid)  -- internal
```

| Role | read | people | write | review | restricted |
|---|:-:|:-:|:-:|:-:|:-:|
| `field_collector` | ✓ | ✓ | ✓ | – | – |
| `branch_supervisor` | ✓ | ✓ | ✓ | ✓ | – |
| `country_manager` (AAL2) | ✓ | ✓ | ✓ | ✓ | ✓ (country/global scope) |
| `hq_admin` (AAL2, always global) | ✓ | ✓ | ✓ | ✓ | ✓ |
| `viewer` | ✓ | – | – | – | – |

Execute privileges: `authenticated` and `service_role` may execute every helper **except**
`private.project_scope()`, which returns raw facts without any check and is therefore executable
only by the migration role / `service_role` (i.e. from SECURITY DEFINER code). `anon` cannot
execute anything (no USAGE on `private`). The helpers only describe the *caller*, so exposing
them to `authenticated` leaks nothing; schema `private` is not exposed through PostgREST.

Cost: one helper call ≈ 0.03–0.1 ms (PL/pgSQL, plans cached per connection). They are `STABLE`;
PostgreSQL does not cache results across calls, so:

- in a **policy** always write `(select private.read_all())` (InitPlan: once per statement);
- in a **function** call a helper once and keep the value in a variable; never call a `can_*`
  wrapper per row of a large set — filter with the triple instead.

"Write" and "review" are capabilities, not the whole business rule. The helpers answer *"may
this caller write/review inside this scope at all"*. Rules such as "a collector edits only
records it created", "an edit of an approved record goes back to `submitted`" or "only
`record_state` transitions listed in the workflow" belong to the RPC that performs the write
(use `project_scope().created_by` / `.record_state`).

## 3. Calling the helpers from SECURITY DEFINER code

Every SECURITY DEFINER function must authorise by itself — RLS does not apply to it.

```sql
-- (a) one row
select * into v from private.project_scope(p_project_id);
if not found then
  raise exception 'forbidden' using errcode = 'PT403';   -- do not reveal whether the id exists
end if;
if not private.can_write_project(v.country_id, v.branch_id) then
  raise exception 'forbidden' using errcode = 'PT403';
end if;
-- collector-only rule (creator) is yours:
if not private.can_review(v.country_id, v.branch_id) and v.created_by is distinct from auth.uid() then
  raise exception 'forbidden' using errcode = 'PT403';
end if;

-- (b) a set: fetch the triple once, filter with plain predicates (index friendly)
v_all       := private.read_all();
v_countries := private.read_countries();
v_branches  := private.read_branches();
... where v_all or p.country_id = any (v_countries) or p.branch_id = any (v_branches)
-- (for the hottest paths branch on v_all and use two statements, so that the scoped
--  statement can use projects_country_sync_idx / projects_branch_sync_idx)

-- (c) people: never for viewer
v_people_all := private.people_all();  -- + people_countries(), people_branches()

-- (d) restricted rows: check, then log exactly what is returned
if not private.can_see_restricted(v.country_id) then
  raise exception 'forbidden' using errcode = 'PT403';
end if;
perform private.log_restricted('staff_compensation', v_ids, 'restricted_read');

-- (e) admin RPCs
if not private.is_hq() then raise exception 'forbidden' using errcode = 'PT403'; end if;
```

Rules:

1. A caller without a valid session gets empty triples/false everywhere — no extra
   `session_ok()` call is needed after using a helper. Functions that use **no** helper (for
   example "own rows" RPCs keyed by `auth.uid()`) must call `private.session_ok()` themselves.
2. Never trust `country_id`/`branch_id` sent by the client for an existing row: take them from
   `project_scope()` (or the row). For a new row, authorise the values that will be stored.
3. Do not return people columns (names of persons, phones) to callers without `people_*`;
   mask phones with `private.mask_phone()` for anything a viewer can reach.
4. Restricted columns and row images (`staff_compensation`, `community_sensitive`, their
   `audit_log` rows, `sync_conflicts.server_value/client_value` of those tables) only after
   `can_see_restricted()`/`restricted_*()` **and** with `log_restricted()`.
5. `revoke execute on function … from public, anon; grant execute … to authenticated;` for every
   RPC (pgTAP file 16 fails otherwise), and pin `search_path`.
6. A service-role or cron caller has no `auth.uid()`: all helpers return false/empty for it.
   Such code must not depend on them.

## 4. Permission matrix — direct SQL as `authenticated`

`S` = SELECT, `I` = INSERT, `U` = UPDATE. Nobody has DELETE/TRUNCATE. "scope" = rows matching
the role's scope (§1). Columns: field collector, branch supervisor, country manager (AAL2),
hq_admin (AAL2), viewer. Manager/HQ at AAL1 and users without a role behave like the last column
of the *reference* rows only (valid session) and see nothing else.

### 4.1 Reference and admin tables

| Table | collector | supervisor | manager | hq_admin | viewer | Policies |
|---|---|---|---|---|---|---|
| `countries`, `admin_areas`, `branches`, `option_values`, `fx_rates`, `map_packs` | S all | S all | S all | S I U all | S all | `<t>_select` (`session_ok`), `<t>_insert_hq`, `<t>_update_hq` |
| `app_settings` | S `is_public` | S `is_public` | S `is_public` | S I U all | S `is_public` | `app_settings_select`, `_insert_hq`, `_update_hq` |
| `profiles` | S own; U own¹ | S own; U own¹ | S own + users of own country²; U own¹ | S I U all | S own; U own¹ | `profiles_select_own/_hq/_manager`, `profiles_insert_hq`, `profiles_update_hq/_own` + triggers `t05_guard`, `t85_keep_hq_admin` |
| `user_roles` | S own | S own | S own + grants scoped to own country² | S I U all | S own | `user_roles_select_own/_hq/_manager`, `_insert_hq`, `_update_hq` + trigger `t85_keep_hq_admin` |
| `devices` | S own | S own | S own + devices of users of own country² | S I U all | S own | `devices_select_own/_hq/_manager`, `_insert_hq`, `_update_hq` |

¹ Only `full_name`, `phone`, `preferred_language` (trigger `t05_guard`, SQLSTATE `PT403`
otherwise). `active`, `sessions_revoked_at`, `deleted_at`, `id`, creation metadata are for
`hq_admin` and SECURITY DEFINER code.
² "Users of own country" = users holding a live role grant with `scope_type = 'country'` and
that country, or `scope_type = 'branch'` and a branch of that country. Read-only.

Nobody can grant a role to themselves or anybody else by direct SQL except `hq_admin` at AAL2
(`user_roles_insert_hq` / `_update_hq`). Device registration and heartbeat go through
`register_device` (RPC), not direct DML.

**At least one effective `hq_admin` remains** (a live `global` `hq_admin` grant whose profile
is `active` and not soft-deleted). `admin_remove_role` / `admin_set_user_active` refuse to
remove the last one, and so does direct DML: the AFTER UPDATE row triggers
`t85_keep_hq_admin` on `user_roles` (old row = live global `hq_admin` grant: soft delete,
re-scope, change of `role` or `user_id`) and on `profiles` (old row active and live: deactivate,
soft delete, change of `id`) raise `PT409 last_hq_admin` when, after the whole statement, no
effective `hq_admin` is left. They fire only for statements run by `authenticated`/`anon`
(the trigger's `WHEN` sees the role of the statement): SECURITY DEFINER code checks for itself,
and `service_role` / the migration role remain the break-glass path. Two administrators
removing each other in concurrent transactions can still both succeed (same as the RPCs).

### 4.2 Field data (SELECT only; writes through RPC)

| Table | collector | supervisor | manager | hq_admin | viewer | Predicate |
|---|---|---|---|---|---|---|
| `projects` | scope | scope | scope | all | scope | read triple on `country_id`/`branch_id` |
| `project_land`, `project_facilities`, `project_maintenance`, `project_photos`, `project_donors`, `community_profiles` | scope | scope | scope | all | scope | parent project in read scope |
| `persons` | scope | scope | scope | all | **–** | people triple on `persons.country_id`/`branch_id` |
| `project_staff` | scope | scope | scope | all | **–** | parent project in people scope |
| `localities` | country³ | country³ | country | all | country³ / all | `country_id` in read countries or in the country of a read branch |
| `donors` | linked⁴ + own | linked⁴ + own | linked⁴ + own | all | linked⁴ (global viewer: all) | see ⁴ |
| `person_merge_requests` | – | scope | scope | all | – | source or target person in review scope |
| `sync_conflicts`⁵ | – | scope | scope | all | – | project / person / locality of the conflict in review scope |
| `notifications` | own | own | own | own | own | `user_id = auth.uid()` |

³ A locality has a country but no branch: branch-scoped roles see the localities of the country
their branch belongs to (it is geographic reference data, like `admin_areas`).
⁴ Donors have no scope columns. Visible: to global readers; when linked through
`project_donors` to a project in the caller's read scope; to their creator (`created_by`).
⁵ Never rows with `table_name in ('staff_compensation', 'community_sensitive')`. Conflicts on
tables other than projects/children (`project_id`), `persons` and `localities` are visible to
global reviewers only.

Soft-deleted rows stay visible inside the scope (tombstones); filter `deleted_at is null` in
the client query.

### 4.3 Jobs, logs, restricted

| Table | collector | supervisor | manager | hq_admin | viewer | Notes |
|---|---|---|---|---|---|---|
| `export_jobs`, `import_batches` | S own | S own | S own | S own | S own | `user_id = auth.uid()`; written by RPC |
| `import_rows` | S own | S own | S own | S own | S own | rows of own batches |
| `audit_log` | – | – | – | S (not the rows of restricted tables) | – | append-only for every role |
| `restricted_access_log` | – | – | – | S | – | append-only; `service_role` has no U/D either |
| `staff_compensation`, `community_sensitive` | ✗ | ✗ | ✗ | ✗ | ✗ | no privilege, no policy: `42501` |
| `sync_applied_ops` | ✗ | ✗ | ✗ | ✗ | ✗ | no privilege, no policy |

`–` = privilege exists but no row is visible; `✗` = `permission denied` (SQLSTATE `42501`).

### 4.4 Storage (`storage.objects`)

| Bucket | Read (select / signed URL) | Write (insert / update) | Delete |
|---|---|---|---|
| `photos` (private) `projects/{ISO2}/{project_id}/{photo_id}_{full\|thumb}.{webp\|jpg\|jpeg}` | caller can read the project (viewer included) | caller may edit the photo **row**: `{project_id}/{photo_id}` is a live `project_photos` row of a live project, and the caller is its creator with write scope on the project or a reviewer of the project (`private.photo_object_writable`; applies to insert, upsert/TUS overwrite and move — old and new name) | nobody (service role: `purge-photos`) |
| `exports`, `imports` (private) `{auth.uid()}/…` | own folder | own folder | nobody |
| `tiles` (public) | every signed-in user with a valid session; anonymous HTTP through the public endpoint | `hq_admin` | `hq_admin` |

Notes: the project row **and the `project_photos` row** must exist on the server before the
photo's objects are uploaded (push the outbox first; the photo queue already waits for both
acknowledgements). A photo object is the content of its row, so it follows the row's edit
rule (sync registry class `creator`): another collector of the branch can add own photos to
any project in scope but cannot overwrite, plant or move the objects of somebody else's photo
row; reviewers can. The object name's ISO2 segment must be the one of the row's
`storage_path_full`/`storage_path_thumb` or the project's current country (the client may
upload before its corrected path reaches the server: JPEG fallback, country assigned by the
server); the extension may be any of the three. The `photos` bucket is limited to 5 MB and
`image/webp`, `image/jpeg`; `imports` to 25 MB. `exports` objects may be written by the owner's
JWT or by the service role.

**Upload rate limiting (brief §11) — which layer.** The database bounds the *number* of photo
objects: no object without a live photo row, at most 3 × 3 × 2 names per row, at most 10 live
rows per project, and rows are written only through `sync_push` (rate limited, 120 calls/min).
The *request rate* of uploads is not limited in the database: Storage evaluates these policies
in a permission test that it rolls back (the local gateway does the same dry run), so a
`private.rate_limit` counter inside a policy would not persist. It is limited in front of
Storage — the local gateway (600 object uploads per user per minute, `local-gateway.md` §3.3)
and, in production, an edge rule (see `local-gateway.md` "known gaps" item 2).

## 5. Table privileges of `authenticated` (pgTAP file 16 pins these lists)

- `SELECT, INSERT, UPDATE`: `countries`, `admin_areas`, `branches`, `option_values`, `fx_rates`,
  `map_packs`, `app_settings`, `profiles`, `user_roles`, `devices`.
- `SELECT`: `localities`, `projects`, `project_land`, `project_facilities`, `project_maintenance`,
  `project_photos`, `donors`, `project_donors`, `persons`, `project_staff`,
  `person_merge_requests`, `community_profiles`, `sync_conflicts`, `notifications`,
  `export_jobs`, `import_batches`, `import_rows`, `audit_log`, `restricted_access_log`.
- `project_land` is granted **column by column**: every column except `owner_name`. A private
  landowner is a person and the name is people data (schema.md); RLS cannot hide one column per
  caller, so the name reaches people-scoped callers only through `sync_pull`
  (`private.sync_wire_list` blanks it for callers without people scope on the row),
  `report_project` (key omitted) and export (column class `people`). Pinned by test 16.
- nothing: `staff_compensation`, `community_sensitive`, `sync_applied_ops`, every sequence,
  everything in schema `private`.
- `anon`: nothing. Migration 0011 also removes `anon` from the default privileges of schema
  `public`, so tables/sequences created by later migrations are not granted to `anon`
  automatically; functions still need the explicit `revoke … from public, anon`.

### Adding a table or an RPC later

1. Create it with RLS enabled **and forced**, `revoke all … from public, anon, authenticated`,
   then grant the minimum and add policies that use the helpers (`to authenticated` only).
2. Add the table to this document and to the lists in `supabase/tests/16_authz_catalog.test.sql`
   (the file fails until the table is classified — that is intended).
3. RPC: `security definer`, pinned `search_path`, own authorisation (§3),
   `revoke execute … from public, anon`.

## 6. pgTAP harness (`tests` schema, `supabase/tests/00_helpers.test.sql`)

```sql
tests.create_user(p_email text, p_role text, p_scope_type text, p_scope_id uuid) returns uuid
tests.login_as(p_user uuid, p_aal text default 'aal2', p_device text default 'dev-test') returns void
tests.login_anon() returns void
tests.logout() returns void
tests.fixture() returns void
tests.id(p_key text) returns uuid

-- extras
tests.set_claim(p_name text, p_value jsonb)     -- override one JWT claim of the current login
tests.fixture_extra()                           -- rows in every other scoped table (calls fixture())
tests.fixture_storage()                         -- storage.objects rows (calls fixture())
tests.fixture_projects() / tests.fixture_users() returns uuid[]
tests.ids(variadic p_keys text[]) returns uuid[]              -- sorted
tests.kind_ids(p_kind text) returns uuid[]                    -- e.g. all 'photo:<project>' ids
tests.visible(p_table text, p_among uuid[] default null) returns uuid[]   -- sorted ids the current role sees
tests._uuid(p_seed text) returns uuid                         -- deterministic id for ad-hoc rows
```

- Every test file: `begin; set local search_path = public, extensions, tests; select plan(n);
  select tests.fixture(); … select * from finish(); rollback;`. Run `00_helpers` first on a
  fresh database (it drops and recreates schema `tests`).
- `login_as` sets `role authenticated`, `request.jwt.claims` = `{sub, role, aud, aal, iat, exp,
  session_id}` (`iat` = now, whole seconds) and `request.headers` = `{"x-device-id": …}`
  (`p_device => null`: no header), all transaction-local. `create_user(email, null, null, null)`
  creates a user without a role; user ids are derived from the e-mail
  (`tests._uuid('user:' || email)`).
- Do privileged setup (`update profiles …`, extra rows) after `tests.logout()` or before the
  first login. The fixture must be called while no login is active.
- Write assertions against fixture ids (`tests.id`, `tests.visible(table, candidates)`), not
  against global counts: the database may also contain reference data or the staging seed.

Fixture (`tests.fixture()`), ids through `tests.id('<key>')`:

| Keys | Rows |
|---|---|
| `tz`, `ke` | countries with iso2 `TZ`, `KE` (existing rows are reused) |
| `tz_pemba_north`, `tz_tanga`, `ke_mombasa` | level-1 `admin_areas`, short codes `PN`, `TG`, `MB`, squares lon/lat `39.60..39.90 / -5.20..-4.80`, `38.80..39.30 / -5.40..-4.80`, `39.50..39.80 / -4.20..-3.90` |
| `br_pemba`, `br_tanga`, `br_mombasa` | branches (TZ, TZ, KE) |
| `u_hq` | `hq_admin`, global |
| `u_mgr_tz`, `u_mgr_ke` | `country_manager`, country |
| `u_sup_pemba` | `branch_supervisor`, `br_pemba` |
| `u_col_pemba`, `u_col_pemba2` | `field_collector`, `br_pemba` |
| `u_col_tanga` | `field_collector`, `br_tanga` |
| `u_col_ke` | `field_collector`, `br_mombasa` |
| `u_viewer_tz`, `u_viewer_global` | `viewer`, country `tz` / global |
| `p_pemba_1` (approved), `p_pemba_2` (draft) | projects by `u_col_pemba` in `br_pemba`, points `(39.75,-5.05)`, `(39.70,-4.95)` |
| `p_tanga_1` (approved) | by `u_col_tanga` in `br_tanga`, `(39.10,-5.07)` |
| `p_ke_1` (approved) | by `u_col_ke` in `br_mombasa`, `(39.66,-4.05)` |
| `person:<p>`, `staff:<p>`, `comp:<p>`, `sens:<p>`, `photo:<p>`, `maint:<p>` | per project: one person (imam, phone `+2557000000N` / `+254700000004`), its `project_staff` row, one `staff_compensation` (250000 TZS/KES from 2024-01-01), one `community_sensitive`, one uploaded cover photo, one open maintenance entry |

`tests.fixture_extra()` adds: `land:<p>`, `fac:<p>`, `community:<p>`, `donor:<p>` +
`pdonor:<p>`, `conflict:<p>` (table `projects`, field `capacity`) for every project;
`donor_unlinked` (by `u_col_pemba`); `person2:<p>`, `merge:<p>` (pending), `pconflict:<p>`
(table `persons`) for `p_pemba_1` and `p_ke_1`; `loc:<area>` (proposed) and `lconflict:<area>`
for the three areas; `notif:<u>`, `export:<u>`, `import:<u>`, `importrow:<u>`, `device:<u>`
(device id `dev-<u>`) for `u_col_pemba`, `u_col_ke`, `u_hq`; `setting_public`,
`setting_private`, `map_pack`, `option_value`, `fx_rate`, `applied_op`, one
`restricted_access_log` row (context `tests.fixture_extra`).

## 7. Things to know

- **BYPASSRLS.** RLS is forced on every table. The SECURITY DEFINER helpers (and every RPC)
  work because their owner bypasses RLS: `postgres` on Supabase, the superuser locally. Do not
  change the owner of these functions to a role without `BYPASSRLS`.
- **Session revocation needs both halves.** `profiles.sessions_revoked_at` kills access tokens
  that are still valid (checked on every statement). Refresh tokens must be revoked through the
  Auth admin API at the same time (the `admin` Edge Function); otherwise a refreshed token gets
  a new `iat` and passes again. A token issued in the same second as the revocation is refused
  (fail closed) — the user simply signs in again.
- **Device revocation is bound to the header.** `devices.revoked_at` blocks requests that carry
  that `x-device-id` for that user. A request without the header is judged by profile and token
  only, so revoking a lost phone must also revoke the user's sessions (`admin_revoke_sessions`
  with the device should set `sessions_revoked_at` or sign the session out).
- **Supervisors do not read other users' profiles** by direct SQL (only own row); names of
  creators/reviewers for lists must come from RPCs.
- **Performance of direct reads.** Filtered reads are index driven (`project_photos` by
  `project_id` ≈ 1–5 ms at 1 M rows). Unfiltered reads of a child table are a hash semi-join
  against the caller's projects (≈ 0.4–0.9 s over 1 M photo rows) and `projects` itself is a
  sequential scan with a cheap filter (≈ 30–80 ms at 100 k rows). The hot paths (`sync_pull`,
  tiles, search, pages) are RPCs and must filter with the triples themselves (§3 b).

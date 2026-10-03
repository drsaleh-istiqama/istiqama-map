# People matching, restricted data, administration, sync status (migrations 0040–0049)

Contract for brief §2.4 (persons), §3 (roles, session/device revocation), §11 (rate limiting,
access log) and the sync-status board of §1. Read this instead of the SQL.

| File | Content |
|---|---|
| `20261003004000_rate_limit_restricted_log.sql` | `private.rate_limit`, `private.rate_limit_cleanup`, `private.log_restricted` |
| `20261003004100_person_candidates.sql` | lookup table `private.person_names` + triggers, `person_candidates` |
| `20261003004200_person_merge.sql` | `merge_persons`, `revert_person_merge`, `request_person_merge`, `resolve_person_merge_request` |
| `20261003004300_restricted_read.sql` | `restricted_read` |
| `20261003004400_admin_rpcs.sql` | `admin_users`, `admin_set_role`, `admin_remove_role`, `admin_set_user_active`, `admin_revoke_sessions`, `admin_restore_device` |
| `20261003004500_sync_status.sql` | `private.sync_rejections` + `private.log_sync_rejection`, `report_device_status`, `sync_status` |
| `supabase/tests/40…45_*.test.sql` | 286 pgTAP assertions |

## 0. Conventions

- Every public function is `SECURITY DEFINER`, pins `search_path`, authorises the caller itself
  and is executable by `authenticated` (and `service_role`) only — never by `anon`.
- All of them write (rate-limit bucket, logs, data), so they are `VOLATILE`: call them with
  **POST** (`supabase.rpc(...)`, never `{ get: true }`).
- Errors: `raise exception '<code>' using errcode = 'PTxxx', detail = '<sentence>'`.
  PostgREST returns `{ code: "PTxxx", message: "<code>", details: "<sentence>", hint }` with
  HTTP status `xxx`. Switch on `message`, show a translated text.

| HTTP / SQLSTATE | `message` | When |
|---|---|---|
| 401 `PT401` | `not_authenticated` | no JWT user |
| 403 `PT403` | `forbidden` | role/scope does not allow the call |
| 403 `PT403` | `mfa_required` | admin RPC called by an `hq_admin`/`country_manager` whose token is not `aal2` |
| 404 `PT404` | `person_not_found`, `merge_request_not_found`, `user_not_found`, `role_not_found`, `device_not_found` | also returned for rows outside the caller's scope (no existence oracle) |
| 409 `PT409` | `person_already_merged`, `merge_not_revertible`, `request_not_pending`, `last_hq_admin`, `cannot_deactivate_self` | state conflicts |
| 422 `PT422` | `invalid_argument`, `invalid_table`, `too_many_projects`, `invalid_role_scope`, `invalid_device_id`, `device_mismatch` | validation |
| 429 `PT429` | `rate_limited` | see §1 (`hint`: "Retry in N seconds.") |

Remember (authz contract): `country_manager` and `hq_admin` are effective **only at `aal2`**;
a revoked session/device or an inactive profile has no roles at all, so every function below
answers `forbidden` for it.

## 1. Rate limiting — `private.rate_limit(p_key text, p_max integer, p_window interval) returns void`

Fixed-window counter in the unlogged table `private.rate_limit_buckets`
(`user_id, bucket_key, window_start` PK, `hits`, `expires_at`).

- Bucket = `auth.uid()` (nil UUID when there is no user) + `p_key` + window start
  (`floor(epoch / window) * window`, wall clock). One atomic upsert; the caller locks only its
  own row, so users never block each other. Two concurrent calls of the *same* user on the
  *same* key serialise until the first transaction ends — keep keys per function.
- More than `p_max` calls in the window → `PT429 rate_limited`. The refused call's increment is
  rolled back with its transaction, so the bucket stays at `p_max` and the next window starts
  from zero. The first hit of a new window deletes the caller's finished windows for that key;
  `private.rate_limit_cleanup(p_grace interval default '10 minutes') returns integer` removes
  the windows of callers that never came back (scheduled hourly by migration 0058).
- Call it **first thing after authorisation** in a `VOLATILE` function:
  `perform private.rate_limit('sync_push', 120, interval '1 minute');`
  It cannot be used from a `STABLE` function or a GET request (read-only transaction).
- Kill switch for load tests that share accounts between virtual users:
  `alter database <db> set app.rate_limit = 'off';` (API clients cannot set it).
- Invalid arguments (`p_max < 1`, window < 1 s, empty key) raise SQLSTATE `22023`.

Limits used in this area (per user): `person_candidates` 300/min · `merge_persons` (merge,
revert, resolve share the key) 60/min · `request_person_merge` 60/min · `restricted_read`
60/min · `admin_read` (`admin_users`, `sync_status`) 120/min · `admin_write` (the other admin
RPCs) 120/min · `report_device_status` 60/min.

## 2. Restricted access log — `private.log_restricted(p_table text, p_ids uuid[], p_context text) returns void`

Writes one `restricted_access_log` row: `user_id = auth.uid()`, `device_id = private.device_id()`,
`table_name`, `row_ids` (ids of the **restricted rows** returned), `row_count`, `context`
(≤ 200 chars), `accessed_at = clock_timestamp()`. `p_table` must be `staff_compensation` or
`community_sensitive` (else `22023`). Call it once per statement/page that returns restricted
rows; an empty id list is still logged. Executable only by the function owner and
`service_role` (i.e. from SECURITY DEFINER code).

## 3. `person_candidates(p_name text, p_phone text, p_admin_area_id uuid) returns jsonb`

"Possible matching persons" for the staff form. **Read-only: it never merges or changes
anything.** Any role with a people scope (everything except `viewer`); `forbidden` otherwise.

Matching (inside the caller's people scope, live and unmerged persons only):

1. **Phone**: `p_phone` is reduced to digits (`00` prefix = `+`) and compared with
   `persons.phone_e164` (7–15 digits; pass E.164).
2. **Name**: `private.norm(p_name)` is compared with `norm(name_ar)` and `norm(name_latin)`
   **separately** (the stored `name_normalized` holds both scripts, which would halve the score
   of a person who has both). Trigram similarity ≥ **0.6**, GIN index, `%` operator with
   `pg_trgm.similarity_threshold` set locally. The best of the two is reported.
   A single word (no space after normalisation) can only reach 0.6 against a name that *is*
   that word, so it is looked up by equality. Fewer than 2 characters: no name search.
   The threshold is read from `app_settings` key `persons.name_similarity` (default 0.6,
   clamped to 0.4..1), so the server follows the same setting the client reads.
3. **Area**: `same_area` = the person's home area is `p_admin_area_id`, one of its ancestors or
   inside it, **or** the person works in a project located in `p_admin_area_id`.

Ranking: phone matches, then same-area, then similarity (desc), then name. At most 12
candidates (taken from the 40 best name matches, same-area first, plus all phone matches).

```jsonc
[
  {
    "id": "…",
    "name_ar": "محمد بن سالم الحارثي",
    "name_latin": null,
    "phone": "+255711111111",          // private.mask_phone() form when phone_masked
    "phone_masked": false,             // true only when the caller may not see this person's phone
    "gender": "male",
    "birth_year": 1980,
    "home_area": { "id": "…", "name_ar": "…", "name_en": "…", "name_sw": "…", "text": null } , // or null
    "roles": ["imam", "teacher"],      // distinct roles in projects the caller can read
    "staff": [                         // live assignments in projects the caller can read
      { "project_staff_id": "…", "project_id": "…", "project_code": "TZ-PN-000123",
        "project_name_ar": "…", "project_name_latin": "…", "project_type": "mosque",
        "role": "teacher", "start_date": "2021-03-01", "end_date": null }
    ],
    "hidden_projects": 0,              // assignments in projects outside the caller's read scope
    "similarity": 1.000,               // null when no name was given
    "same_area": true,
    "reasons": ["phone", "name", "area"]   // any non-empty subset, in this order
  }
]
```

`[]` when nothing matches or nothing usable was passed. The offline twin
(`findLocalPersonCandidates`) should use the same rule: per-script similarity ≥ 0.6, equality
for single words.

Implementation notes for other teams:

- `private.person_names (person_id, script 'ar'|'latin', name_norm, n_trgm, country_id,
  branch_id)` is maintained by the triggers `t85_person_names_ins` / `t85_person_names_upd` on
  `persons`. **Bulk loaders that disable triggers must call `select
  private.person_names_rebuild();` afterwards.**
- pg_trgm needs a database whose `LC_CTYPE` is not `C` (see §9).

## 4. Merging persons

All four functions return `jsonb`. "Reviewer of a person" = `private.can_review(person.country_id,
person.branch_id)` (branch supervisor of that branch, country manager of that country, HQ).
Merging/reverting/deciding requires review rights over **both** persons.

### `merge_persons(p_source uuid, p_target uuid, p_reason text)`

1. Live `project_staff` rows of the source are re-pointed to the target. A row that would
   duplicate an assignment the target already has (same project, same role, same `end_date`,
   compatible `start_date`) is soft-deleted instead ("collapsed"); its live salary rows move to
   the surviving assignment only when that one has none.
2. The source is soft-deleted with `merged_into_id = target`.
3. Blank fields of the target are filled from the source (`name_latin`, `phone_e164`, `gender`,
   `birth_year`, `birth_date`, `home_admin_area_id` + `home_area_text` as a pair,
   `education_level`, `graduated_from`). Existing target values are never overwritten.
4. A `person_merge_requests` row with `state = 'merged'`, `decided_by/decided_at` and the
   `undo` document is written.

```jsonc
{ "request_id": "…", "state": "merged", "source_id": "…", "target_id": "…",
  "moved_staff": 1, "collapsed_staff": 1, "filled_fields": ["birth_year", "gender", "phone_e164"] }
```

`undo` (owned by these functions, do not edit):

```jsonc
{ "v": 1, "source_id": "…", "target_id": "…",
  "moved_staff": ["<project_staff.id>", …],
  "collapsed_staff": [{ "id": "<soft-deleted staff id>", "kept_id": "<surviving staff id>",
                        "moved_compensation": ["<staff_compensation.id>", …] }],
  "target_filled": { "phone_e164": "+255…" },
  "merged_by": "…", "merged_at": "…",
  "reverted_by": "…", "reverted_at": "…",        // after a revert
  "decision_note": "…" }                          // after a rejection with a note
```

Errors: `forbidden`, `person_not_found`, `invalid_argument` (same id / null),
`person_already_merged` (source or target deleted/merged).

### `revert_person_merge(p_request_id uuid)`

Restores exactly the previous state from `undo`: moved staff rows go back to the source
(rows re-pointed to yet another person in the meantime are skipped and counted), collapsed rows
are un-deleted and get their salary rows back, the source is live again
(`deleted_at = null`, `merged_into_id = null`), and fields the merge copied to the target are
cleared **unless somebody changed them since**. Request state → `reverted`.

```jsonc
{ "request_id": "…", "state": "reverted", "source_id": "…", "target_id": "…",
  "restored_staff": 1, "skipped_staff": 0, "restored_collapsed": 1,
  "reset_fields": ["phone_e164", "gender", "birth_year"] }
```

`merge_not_revertible` when the request is not `merged`, has no undo data, the source is no
longer merged into the target, or the target has itself been merged later (revert the newer
merge first — chains are undone in reverse order).

### `request_person_merge(p_source uuid, p_target uuid, p_reason text)`

Anyone who may see both persons (e.g. a collector) proposes a merge:
`{ "request_id": "…", "state": "pending", "created": true }`. The same pair (either direction)
with a pending request returns that request with `created: false`. Nothing is merged.
(`sync_push` can also create a pending request; both paths are equivalent.)

### `resolve_person_merge_request(p_request_id uuid, p_decision text, p_note text default null)`

`p_decision = 'approve'` → performs the merge under the same request id and returns the
`merge_persons` shape. `'reject'` → `{ "request_id", "state": "rejected", "source_id",
"target_id" }` (note kept in `undo.decision_note`). `request_not_pending` otherwise.

All writes are ordinary updates: `version`/`sync_xid` change (devices pull the re-pointed
staff rows, the deleted source and the changed target) and `audit_log` records them under the
reviewer.

## 5. `restricted_read(p_table text, p_project_ids uuid[]) returns jsonb`

The only interactive read path to `staff_compensation` and `community_sensitive`.

- Callers without any restricted capability (`restricted_all()` false and no
  `restricted_countries()`) → `forbidden`. That is everybody except `country_manager` and
  `hq_admin` at `aal2`.
- Project ids are de-duplicated; more than **200** → `too_many_projects`. Projects that are
  soft-deleted or in a country the caller may not see are **dropped silently**
  (`project_ids` in the answer lists the accepted ones).
- **Exactly one `restricted_access_log` row per call** (also when no row is returned), with the
  ids of the restricted rows returned and
  `context = 'restricted_read requested=<n> allowed=<m>'`.

```jsonc
// p_table = 'staff_compensation'
{ "table": "staff_compensation", "as_of": "2026-10-03", "project_ids": ["…"],
  "rows": [
    { "id": "…", "project_id": "…", "project_staff_id": "…", "person_id": "…",
      "person_name_ar": "…", "person_name_latin": "…", "role": "imam",
      "monthly_amount": 250000.00, "currency": "TZS", "effective_from": "2024-01-01",
      "is_current": true,              // in force today and the assignment has not ended
      "usd_per_unit": 0.00039,         // latest fx_rates row with effective_date <= today; 1 for USD; null = no rate
      "fx_date": "2026-10-01",         // effective_date of that rate (null for USD / no rate)
      "usd_amount": 97.50,             // round(monthly_amount * usd_per_unit, 2); null = no rate
      "version": 1, "updated_at": "…" }
  ],
  "totals": {                          // current salaries only
    "by_currency": [ { "currency": "TZS", "staff_count": 2, "monthly_amount": 500000.00, "usd_amount": 195.00 } ],
    "usd_total": 295.00,               // converted currencies only
    "usd_complete": false,             // false when a currency has no rate …
    "missing_rates": ["OMR"]           // … listed here
  } }

// p_table = 'community_sensitive'
{ "table": "community_sensitive", "as_of": "2026-10-03", "project_ids": ["…"],
  "rows": [ { "id": "…", "project_id": "…", "ibadi_families": 12, "omani_families": 3,
              "omani_student_pct": 5.00, "ibadi_student_pct": 40.00, "omani_teacher_pct": null,
              "ibadi_teacher_pct": null, "guest_financial_capacity": "limited",
              "version": 1, "updated_at": "…" } ] }
```

Amounts of different currencies are never added: totals are one line per currency; the only
cross-currency figure is `usd_total`, built from converted amounts. All history rows of an
assignment are returned (`is_current` marks the one that counts).

## 6. Administration

`hq_admin` unless stated. `country_manager` "own country" = users holding a live role scoped to
one of the manager's countries or to a branch of it, **and not** an `hq_admin`.

### `admin_users(p_search text default null, p_limit integer default 2000) returns jsonb`

`hq_admin`: everybody; `country_manager`: own country. `p_search` matches name / e-mail / phone
(normalised, substring); `p_limit` 1..5000. Sorted by name.

```jsonc
[ { "id": "…", "full_name": "…", "email": "…", "phone": "…", "preferred_language": "ar",
    "active": true, "sessions_revoked_at": null, "created_at": "…", "last_sign_in_at": null,
    "roles": [ { "id": "<user_roles.id>", "role": "field_collector", "scope_type": "branch",
                 "scope_id": "…", "scope_name_ar": "…", "scope_name_en": "…", "scope_name_sw": "…",
                 "country_id": "…", "created_at": "…" } ],
    "devices": [ { "id": "…", "device_id": "…", "label": "…", "user_agent": "…", "app_version": "3.0.0",
                   "last_seen_at": "…", "last_push_at": "…", "last_pull_at": "…",
                   "pending_ops": 0, "pending_photos": 0, "revoked_at": null } ] } ]
```

`email` and `last_sign_in_at` come from `auth.users` (phones are returned unmasked: only
administrators can call this).

### `admin_set_role(p_user_id uuid, p_role text, p_scope_type text, p_scope_id uuid) returns jsonb`

| role | allowed scope |
|---|---|
| `hq_admin` | `global` |
| `country_manager` | `country` |
| `branch_supervisor` | `branch` |
| `field_collector` | `branch` or `country` |
| `viewer` | `global`, `country` or `branch` |

`global` ⇒ `p_scope_id` null; otherwise the country/branch must exist (`invalid_role_scope`).
Unknown user (no profile) ⇒ `user_not_found`. Idempotent; a previously removed identical grant
is revived (same id).
`{ "id": "<user_roles.id>", "user_id", "role", "scope_type", "scope_id", "created": true|false }`

### `admin_remove_role(p_role_id uuid) returns jsonb`

Soft-deletes the grant: `{ "id", "user_id", "removed": true|false }`. The last active
`hq_admin` cannot be removed (`last_hq_admin`). Effective on the user's next statement; the
client notices through `scope_epoch`.

### `admin_set_user_active(p_user_id uuid, p_active boolean) returns jsonb`

`{ "user_id", "active", "changed", "auth_logout_required": <not p_active> }`. Deactivating also
sets `sessions_revoked_at` (tokens issued before stay dead after a later reactivation). Not on
oneself (`cannot_deactivate_self`), not on the last active `hq_admin` (`last_hq_admin`).

### `admin_revoke_sessions(p_user_id uuid, p_device_id text default null) returns jsonb`

`hq_admin`: anybody. `country_manager`: own country (others → `user_not_found`).

- without device: `profiles.sessions_revoked_at = now` → `private.session_ok()` is false for
  every token issued before; the user's very next statement returns nothing.
  `{ "user_id", "device_id": null, "scope": "user", "revoked_at", "auth_logout_required": true }`
- with device: `devices.revoked_at = now` (blocked until restored) **and**
  `sessions_revoked_at = now` — the device block depends on the `x-device-id` header, which a
  stolen token can omit. `{ …, "device_id": "…", "scope": "device", "auth_logout_required": true }`.
  Unknown device ⇒ `device_not_found`.

**The `admin` Edge Function must call this RPC with the administrator's JWT and then, when
`auth_logout_required`, sign the user out through the Auth admin API** (refresh tokens);
otherwise a refreshed token gets a new `iat` and passes again. If the lost phone's SIM receives
the sign-in codes, deactivate the account instead.

### `admin_restore_device(p_user_id uuid, p_device_id text) returns jsonb`

`{ "user_id", "device_id", "restored": true|false }`; `device_not_found` when unknown.

## 7. Sync status

### `report_device_status(p_device_id text, p_pending_ops integer, p_pending_photos integer, p_app_version text) returns jsonb`

Called by the client after every sync cycle (any signed-in user, own device only). Upserts
`devices (user_id, device_id)`: `pending_ops`, `pending_photos` (negative → 0, null → keep),
`app_version` (≤ 40 chars, null → keep), `last_seen_at = now()`. `p_device_id` must match
`^[A-Za-z0-9._:-]{1,128}$` (`invalid_device_id`) and the `x-device-id` header when present
(`device_mismatch`) — same rules as `register_device`. A revoked device may still report (its
heartbeat is what the administrator wants to see).
`{ "device_id", "revoked": false, "revoked_at": null, "session_ok": true, "server_time": "…" }`
→ when `revoked` or not `session_ok` the client should lock itself and sign out.

### `sync_status() returns jsonb`

`hq_admin`: all users; `country_manager`: own country.

```jsonc
{ "generated_at": "…", "scope": "all" | "country", "country_ids": null | ["…"], "window_days": 7,
  "summary": { "users": 10, "users_without_device": 7, "devices": 4, "stale_devices": 1,
               "pending_ops": 40, "pending_photos": 15, "open_conflicts": 3, "rejected_7d": 3 },
  "users": [                           // users needing attention first (conflicts + rejections, pending ops), then by name
    { "user_id": "…", "full_name": "…", "active": true,
      "roles": [ { "role": "field_collector", "scope_type": "branch", "scope_id": "…" } ],
      "device_count": 2,
      "pending_ops": 40, "pending_photos": 15,        // devices that are not revoked
      "open_conflicts": 3, "rejected_7d": 2,          // all of the user's, with or without device id
      "last_seen_at": "…", "last_push_at": "…", "last_pull_at": "…",   // latest over the devices
      "devices": [
        { "id": "…", "device_id": "…", "label": "…", "user_agent": "…", "app_version": "3.0.1",
          "last_seen_at": "…", "last_push_at": "…", "last_pull_at": "…",
          "pending_ops": 0, "pending_photos": 3,
          "open_conflicts": 2,          // sync_conflicts.state = 'open' raised by this device
          "rejected_7d": 2,             // operations of this device rejected by sync_push in the last 7 days
          "stale": false,               // not revoked and not seen for more than 7 days
          "revoked_at": null } ] } ] }
```

### Rejected operations — `private.log_sync_rejection(p_user_id uuid, p_device_id text, p_op jsonb, p_error jsonb) returns void`

`sync_push` rolls a rejected operation back and (deliberately) does not keep it in
`sync_applied_ops`, so the server has no record of it. `rejected_7d` is counted from
`private.sync_rejections (rejected_at, user_id, device_id, op_id, table_name, row_id, code,
error)`, which is filled by this helper. **`sync_push` has to call it in its exception
handler** (after the sub-transaction was rolled back):

```sql
perform private.log_sync_rejection(v_uid, v_device, v_op, v_res -> 'error');
```

`p_op` = the operation as sent (`op_id`, `table`, `id` are extracted when well-formed),
`p_error` = the error object returned to the client (`code` is stored). It never raises.
`private.sync_rejections_cleanup(p_keep interval default '30 days') returns integer` prunes the
log (schedule it daily with the other jobs). Until the call is added `rejected_7d` is 0.

## 8. Phone masking

No function of this area that a `viewer` can call returns a phone number: `person_candidates`,
the merge RPCs, `restricted_read`, the admin RPCs and `sync_status` all refuse viewers.
`person_candidates` additionally masks (`private.mask_phone`) any phone of a person outside the
caller's people scope, should such a row ever be listed.

## 9. Operational requirements

- **`LC_CTYPE` must not be `C`.** With `C`, pg_trgm extracts no trigrams from non-ASCII text:
  Arabic names (and Arabic search) silently match nothing. Supabase databases
  (`en_US.UTF-8` / `C.UTF-8`) are fine. Migration 0040 raises a WARNING and
  `41_person_candidates.test.sql` fails its first assertion on such a database. Local
  databases must be created with e.g. `lc_ctype 'en-US'` (Windows) / `'en_US.UTF-8'`.
- `auth.users` must expose `email`, `phone`, `last_sign_in_at` (real GoTrue does).
- Functions are owned by a role with `BYPASSRLS` (RLS is forced on every table).
- `person_candidates` measured on 500,000 persons / 750,000 names (shared development machine,
  synthetic names built from 30 given names and 20 family names — a worst case for trigram
  matching): full common name 100–300 ms, two common words 30 ms, three common words up to
  550 ms, Latin name 70 ms, phone only or single word < 10 ms. The cost is the GIN scan of
  very frequent trigrams plus one similarity computation per candidate inside the trigram-count
  window; a branch or country scope is ANDed in the index.
- `private.person_names` adds one row per person and script (≈ 200 MB with indexes at 500k
  persons) and one trigger execution per person insert / rename / scope move.

# Sync contract (server side)

Binding for the web sync engine (`apps/web/src/sync`, `src/db/tables.ts`), the Edge Function
wrappers and the load tests. Source: brief §3, §4; `docs/ARCHITECTURE.md` §3.
Implemented by migrations `0020`–`0025` (`supabase/migrations/2026100300{20..25}00_*.sql`),
tested by `supabase/tests/2*_*.test.sql`.

| RPC (POST `/rest/v1/rpc/<name>`)                       | Purpose                                                     |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| `my_context()`                                         | who am I, effective scope, capability flags, `scope_epoch`  |
| `register_device(p_device_id, p_label, p_app_version)` | upsert the device row, returns `{revoked}`                  |
| `sync_push(p_ops, p_device_id)`                        | apply ≤ 50 outbox operations, idempotent, field-level merge |
| `sync_pull(p_cursor, p_limit)`                         | scoped change feed, paged                                   |
| `resolve_conflict(p_conflict_id, p_choice)`            | reviewer decision on a field conflict                       |

All five are `SECURITY DEFINER`, executable by `authenticated` only. Every request must carry
the header **`x-device-id: <device id>`** (1–128 chars of `[A-Za-z0-9._:-]`); `sync_push` and
`register_device` reject the call (`PT422 device_mismatch`) when the header and the
`p_device_id` argument differ. Except for `my_context()` they all write (rate limiter,
heartbeat, access log), so call them with POST, never GET.

---

## 1. Table registry (`private.sync_tables`)

`apps/web/src/db/tables.ts` must list the same tables in the same order.

| #   | Table                   | Scope of a row                 | Audience (pull) | insert         | update         | delete         | Notes                                                               |
| --- | ----------------------- | ------------------------------ | --------------- | -------------- | -------------- | -------------- | ------------------------------------------------------------------- |
| 10  | `countries`             | global                         | all             | –              | –              | –              | reference                                                           |
| 20  | `admin_areas`           | country                        | all             | –              | –              | –              | sent **without** `geom`/`geom_simple` (shapes: `admin_area_shapes`) |
| 30  | `branches`              | global                         | all             | –              | –              | –              | reference                                                           |
| 40  | `option_values`         | global                         | all             | –              | –              | –              | reference                                                           |
| 50  | `fx_rates`              | global                         | all             | –              | –              | –              | reference                                                           |
| 60  | `localities`            | country                        | all             | writer         | creator        | creator        | `lon`/`lat`; collectors only `proposed`                             |
| 70  | `donors`                | donor (own + linked, §5.5)     | all             | writer         | writer         | creator        | update / delete only for a donor the caller can see                 |
| 80  | `projects`              | row (`country_id`,`branch_id`) | all             | writer         | creator        | creator        | `lon`/`lat`; `record_state` workflow                                |
| 90  | `project_land`          | project                        | all             | project_editor | project_editor | project_editor | natural key `project_id`                                            |
| 100 | `project_facilities`    | project                        | all             | project_editor | project_editor | project_editor | natural key `project_id`                                            |
| 110 | `project_maintenance`   | project                        | all             | writer         | creator        | creator        |                                                                     |
| 120 | `project_photos`        | project                        | all             | writer         | creator        | creator        | paths default server-side                                           |
| 130 | `project_donors`        | project                        | all             | project_editor | project_editor | project_editor | donor must be visible to the caller                                 |
| 140 | `persons`               | row                            | **people**      | writer         | writer         | creator        | never merged automatically                                          |
| 150 | `project_staff`         | project                        | **people**      | project_editor | project_editor | project_editor | person must be visible to the caller                                |
| 160 | `community_profiles`    | project                        | all             | project_editor | project_editor | project_editor | natural key `project_id`                                            |
| 170 | `staff_compensation`    | staff → project                | **restricted**  | writer         | writer         | creator        | blind writes; natural key `(project_staff_id, effective_from)`      |
| 180 | `community_sensitive`   | project                        | **restricted**  | writer         | writer         | creator        | blind writes; natural key `project_id`                              |
| 190 | `person_merge_requests` | person (source)                | **review**      | reviewer       | reviewer       | reviewer       | only `pending` / `pending → rejected`                               |
| 200 | `sync_conflicts`        | conflict                       | **review**      | –              | –              | –              | resolve with `resolve_conflict`                                     |
| 210 | `notifications`         | own (`user_id`)                | own rows        | –              | self           | –              | only `read_at` is writable                                          |
| 220 | `map_packs`             | global                         | all             | –              | –              | –              | reference                                                           |

**Scope kinds.** `global`: no row filter. `country`: `country_id` ∈ countries of the caller
(country-scoped roles + the countries of branch-scoped roles). `row`: the Appendix A.3 rule
(global matches all, country scope matches `country_id`, branch scope matches `branch_id`).
`project` / `staff` / `person`: the same rule applied to the parent project / person.
`donor`: donors have no country or branch — a row is in scope when the caller is a global
reader, created the donor, or can read a project the donor is linked to (§5.5). This is the
rule of the RLS policy on `donors`; `sync_pull` and `sync_push` apply exactly the same one.

**Audience.** `all` = any role (read triple) · `people` = any role except `viewer` ·
`review` = branch_supervisor, country_manager, hq_admin · `restricted` = country_manager
(own country) and hq_admin, both only at `aal2`.

**Role classes for push** (evaluated on the scope of the row / its parent project):

| Class            | Who                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------ |
| `writer`         | field_collector, branch_supervisor, country_manager, hq_admin with the row in scope        |
| `creator`        | the user who created the row (and still has write scope), or a reviewer in scope           |
| `project_editor` | whoever may edit the parent project: its creator (with write scope) or a reviewer in scope |
| `reviewer`       | branch_supervisor / country_manager / hq_admin with the row in scope                       |
| `self`           | the owner of the row                                                                       |
| –                | not writable through `sync_push` (`table_not_writable` / `operation_not_allowed`)          |

After changing the registry run `select private.sync_refresh();` (validates it, creates
missing indexes, regenerates `private.sync_changed_tables`).

---

## 2. `my_context()` → jsonb

```jsonc
{
  "user_id": "…",
  "profile": {
    "id": "…",
    "full_name": "…",
    "phone": null,
    "preferred_language": "ar",
    "active": true,
  },
  "roles": [{ "role": "field_collector", "scope_type": "branch", "scope_id": "…" }], // effective now
  "assigned_roles": [{ "role": "…", "scope_type": "…", "scope_id": "…" }], // granted (may need MFA)
  "scopes": {
    "read": { "all": false, "countries": [], "branches": ["…"] },
    "people": { "all": false, "countries": [], "branches": ["…"] },
    "write": { "all": false, "countries": [], "branches": ["…"] },
    "review": { "all": false, "countries": [], "branches": [] },
    "restricted": { "all": false, "countries": [] },
  },
  "aal": "aal1",
  "mfa_required": false, // a country_manager / hq_admin grant exists but the session is aal1
  "session_ok": true, // false: account inactive, sessions revoked or device revoked → sign out
  "capabilities": {
    "can_write": true,
    "can_review": false,
    "can_see_restricted": false,
    "can_see_people": true,
    "is_hq": false,
  },
  "device_id": "…",
  "scope_epoch": "…",
  "server_time": "…",
}
```

`country_manager` / `hq_admin` are effective only at `aal2`; at `aal1` they appear in
`assigned_roles` only and `mfa_required` is `true`. Never raises for a revoked session
(returns `session_ok: false`); raises `PT401` without a JWT.

## 3. `register_device(...)` → jsonb

`{ "device_id": "…", "revoked": false, "revoked_at": null, "session_ok": true, "server_time": "…" }`

Upserts `devices(user_id, device_id)`: label, app version, user agent, `last_seen_at`.
Call it after sign-in (and when the label or app version changes). A revoked device stays
revoked: on `revoked: true` **or** `session_ok: false` wipe local data and sign out.
**Nothing is written** when the session is not valid (`private.session_ok()` false: inactive
account, revoked sessions, revoked `x-device-id` device) or when the named device row is
revoked (also when the header is missing); the answer then only reports `revoked` /
`revoked_at` of the existing row (if any) and `session_ok`. A valid caller re-registering a
device row that an administrator soft-deleted (not revoked) brings it back
(`deleted_at = null`): the device is in use and belongs on the sync-status board; blocking a
device is `revoked_at`. Errors: `PT422 invalid_device_id`,
`PT422 device_mismatch`, `PT429` (60 / minute). The per-cycle heartbeat with the pending
counters is `report_device_status()` (see `people-admin.md` §7); `sync_push` stamps
`devices.last_push_at`, a completed pull round stamps `devices.last_pull_at`.

---

## 4. `sync_push(p_ops jsonb, p_device_id text)` → jsonb

```jsonc
// p_ops: array, at most 50 elements, parents before children
[{ "op_id": "<uuid>",            // idempotency key, generated once when the op is queued
   "table": "projects",
   "id": "<uuidv7>",             // row id generated on the device
   "kind": "upsert" | "delete",
   "base_version": 0,            // version of the row the edit was made on; 0 = created on this device
   "fields": { "name_ar": "…", "lon": 39.7, "lat": -5.05,    // upsert: changed fields only (all fields on insert)
               "created_at": "2026-10-01T07:12:00Z" },       // insert only: when the row was created on the device
   "client_ts": "2026-10-03T10:00:00Z" }]                    // informational

// response: one result per op, in input order
{ "results": [
    { "op_id": "…", "status": "applied", "version": 3 },
    { "op_id": "…", "status": "merged", "version": 5 },
    { "op_id": "…", "status": "conflict", "version": 5,
      "conflict_ids": ["…"], "conflict_fields": ["builder"],
      "server_values": { "builder": "…" } },                 // never present for restricted tables
    { "op_id": "…", "status": "rejected",
      "error": { "code": "out_of_scope", "message": "…", "sqlstate": "PT403",
                 "constraint": "…", "column": "…" } },         // constraint/column only for DB constraint errors
    { "op_id": "…", "status": "duplicate", "original_status": "applied", "version": 3 } ],
  "server_time": "…" }
```

Optional result keys: `row_id` (the op was applied to a different, already existing row —
see natural keys; never for a blind write, §4.4), `ignored_fields` (names in `fields` that
are not columns).

### 4.1 Status → what the client does

| Status      | Meaning                                                                                                               | Client                                                                                                                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `applied`   | written (or nothing to change); for a blind write on a restricted table always this, with `version: null` (§4.4)      | drop the op; set the local row `version` to `version` unless a newer local edit is pending                                                                                                                                   |
| `merged`    | written although other devices changed other fields meanwhile                                                         | same as `applied`; the merged row arrives with the next pull                                                                                                                                                                 |
| `conflict`  | the fields in `conflict_fields` were **not** written (same field changed elsewhere), the other fields were            | drop the op; overwrite the local copy of each conflicting field with `server_values[field]` (location: `{"geom": {"lon", "lat"}}`); the reviewer decides, the result arrives through pull                                    |
| `duplicate` | this `op_id` was applied before                                                                                       | drop the op; treat like `original_status`                                                                                                                                                                                    |
| `rejected`  | nothing was written; the op is not in the ledger (only logged in `private.sync_rejections` for the sync-status board) | move the op to `failed_ops` ("needs attention"); keep going. The same `op_id` may be sent again after the cause is fixed. `parent_missing` normally means wrong order or a rejected parent: retry after the parent succeeded |

Every `rejected` result (including `invalid_op` and `op_id_taken`) is logged once with user,
device, op id, table, row id and error code (`private.log_sync_rejection`, written outside the
rolled-back sub-transaction). `sync_status()` reports the count of the last 7 days as
`rejected_7d` per user and per device (`people-admin.md` §7);
`private.sync_rejections_cleanup()` removes log rows older than 30 days. Whole-call errors
are not logged there. pgTAP file 21 asserts the whole chain (push → log → `rejected_7d`).

Whole-call errors (HTTP error, nothing applied — retry the same batch later, it is idempotent):

| SQLSTATE → HTTP           | Message                                                               | When                                                             |
| ------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `PT401` → 401             | `not_authenticated`                                                   | no JWT                                                           |
| `PT403` → 403             | `session_revoked`                                                     | account inactive, sessions revoked, or device revoked → sign out |
| `PT422` → 422             | `invalid_ops`, `too_many_ops`, `invalid_device_id`, `device_mismatch` | malformed call (more than 50 ops is refused)                     |
| `PT429` → 429             | rate limit                                                            | 120 calls / minute / user; retry after the window                |
| `40001`, `40P01`, `55P03` | serialization failure / deadlock / lock timeout                       | retry the batch                                                  |

### 4.2 Rules applied to every operation

1. **Idempotency.** `op_id` found in `sync_applied_ops` → stored result with status
   `duplicate` (an op id used by another user → `rejected/op_id_taken`). Rejected ops are
   not stored.
2. **Server-managed columns are ignored silently**: `id` (on update), `version`,
   `created_at` (on update; on insert see rule 4), `created_by`, `updated_at`, `updated_by`,
   `sync_xid`, `deleted_at`
   (deletion only through `kind: "delete"`), geometry columns (send `lon`/`lat`), and per
   table: projects `code`, `completeness`, `search_norm`, `import_batch_id`, `reviewed_by`,
   `reviewed_at`; localities `name_norm`, `approved_by`, `approved_at`; donors `name_norm`;
   persons `name_normalized`, `merged_into_id`; photos `purged_at`; merge requests
   `decided_by`, `decided_at`, `undo`. `review_note` is ignored unless the caller is a
   reviewer. Unknown names are ignored and reported in `ignored_fields`.
3. **Location.** `lon` and `lat` must be sent together (both `null` clears the point);
   range −180..180 / −90..90, else `rejected/invalid_coordinates`. Stored as
   `Point, SRID 4326`. Pull returns `lon`/`lat`, never `geom`.
4. **Insert** (row id unknown on the server): role class of `insert`.
   - `projects`, `persons`: when `branch_id` is missing and the caller's only write scope
     is one branch, it is defaulted; `country_id` defaults from the branch (or from the
     caller's single country scope). Otherwise send them. For `projects` the server then
     derives `country_id`/`admin_area_id` from the point; the stored row must still be in
     the caller's write scope (`out_of_scope`) and its branch must belong to its country
     (`branch_country_mismatch`). A project's `locality_id` must name a locality of the
     project's (stored, derived) country, on insert and whenever `locality_id` or the
     location/country changes (`locality_country_mismatch`, PT422): the locality's names
     are copied into `search_norm` and shown with the project.
   - `localities`: `country_id` defaults from the caller's single country.
   - children: the parent must exist (`parent_missing`) and be live (`parent_deleted`).
   - **`created_at`** (every table): an insert may carry the time at which the row was
     created on the device (ISO 8601 **with** offset or `Z`). It is stored as sent, so the
     offline entry time survives a late sync. A value more than 5 minutes ahead of the
     server clock is replaced by the server time; a missing, `null`, blank or infinite value
     means "now"; anything that is not a timestamp rejects the op (`invalid_value`) — also
     when the insert is then redirected to an existing row by a natural key (the value is
     checked before the lookup). There is no lower bound: a device whose clock is in the
     past stores that past time. On update (also when an insert is redirected to an
     existing row by a natural key) a valid `created_at` is ignored — it never changes
     after the insert.
5. **Natural keys.** For `project_land`, `project_facilities`, `community_profiles`,
   `community_sensitive` (one live row per `project_id`) and `staff_compensation` (one
   live row per `project_staff_id` + `effective_from`, send both): an insert whose key
   already has a live row is applied to that row as an update with `base_version` 0 and the
   result carries `row_id` = id of the existing row (not for a blind write, §4.4). The
   client deletes its local row with the op's `id`; the canonical row arrives through pull
   (never for restricted tables on a collector's device). A key column left out takes its
   column default before the lookup (`staff_compensation.effective_from` = today), so the
   insert finds the row it would otherwise collide with. A redirected insert is still an
   insert: under a deleted parent it is refused with `parent_deleted`, exactly as when
   the key has no live row.
6. **Update** (row exists): role class of `update`; a row that is soft-deleted →
   `rejected/row_deleted`; `base_version` 0 for a row created by somebody else →
   `rejected/id_taken`; parent links (`project_id`, `project_staff_id`,
   `source_person_id`, `target_person_id`) cannot change (`immutable_field`).
   Only fields whose value really differs take part in the merge:
   - `base_version` = current version → write (`applied`).
   - `base_version` < current version → the fields changed since `base_version` by
     **other devices** are read from `audit_log` (changes made by the calling device are
     ignored, so a queue of edits recorded against the same base never conflicts with
     itself). Disjoint → write (`merged`). A field changed on both sides to different
     values → one `sync_conflicts` row per field (`state: open`), that field is left
     untouched, the remaining fields are written (`conflict`).
7. **Delete** = soft delete (`deleted_at`). Unknown or already deleted row → `applied`
   (no-op). Otherwise: role class of `delete`, then the **workflow rules of §4.3** for the
   row's current state (a delete is a state change: e.g. a collector cannot delete his
   approved project or an approved locality). A delete on a stale base still deletes
   (`merged`). Children of a deleted project are **not** deleted on the server; the client
   drops them locally when the project tombstone arrives.
8. One sub-transaction per op: a rejected op leaves no trace and does not affect the
   others. The audit trigger records the calling device for every row written.

### 4.3 Workflow rules (validated against the current server state, never merged)

**`projects.record_state`**

| Caller                        | Allowed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| creator without review rights | insert as `draft` (default) or `submitted`; `draft → submitted`, `returned → submitted`, `approved → submitted`. Any edit of an `approved` record (or of its land, facilities, donors, staff, community profile) sets it back to `submitted`. `→ approved` / `→ returned` → `rejected/forbidden_transition`; anything else → `rejected/invalid_transition`. **Delete** only while the record is `draft` or `returned`; a `submitted` or `approved` record → `rejected/forbidden_transition` (a reviewer deletes it, or returns it first) |
| reviewer in scope             | additionally `draft/submitted/returned → approved`, `submitted/approved → returned`; `reviewed_by`, `reviewed_at` are stamped by the server, `review_note` is stored; may delete in any state                                                                                                                                                                                                                                                                                                                                            |

A record cannot leave `draft` without a location (`check_violation`, constraint
`projects_geom_required_ck`). Adding maintenance entries or photos never changes the state.

**`localities.status`** — collectors insert `proposed` only and may edit or delete their own
row while it is `proposed` (`locality_locked` afterwards); reviewers set `approved` (stamped)
or back to `proposed`, and may change or delete any locality in scope.

**`person_merge_requests`** — reviewers only; both persons must be in the reviewer's scope;
insert as `pending`, `pending → rejected` (stamped). `merged` / `reverted` only through
`merge_persons()` / `revert_person_merge()`. Persons are never merged by `sync_push`. Only a
`pending` request can be deleted (withdrawn); a decided one (`rejected`, `merged`,
`reverted`) is the trace of the decision → `rejected/invalid_transition` — a merged request
holds the undo data `revert_person_merge()` needs.

A collector's client should therefore offer "delete" only for his `draft` / `returned`
projects and his `proposed` localities; other deletes come back `rejected`.

**`notifications`** — only the owner, only `read_at`.

**`donors`** — any writer may insert a donor (it is visible to its creator from then on).
Updating or deleting an existing donor requires that the caller can **see** it (§5.5: global
reader, creator, or reader of a project it is linked to); otherwise `rejected/out_of_scope`
— no conflict is recorded and no stored value is returned. Delete additionally needs the
creator or a reviewer (`not_owner`).

**`project_donors`** — `donor_id` (on insert, and when an update changes it) must point to a
donor that exists (`parent_missing`), is not deleted and is visible to the caller
(`donor_not_available`). A donor created in the same batch is visible to its creator, so
"new donor + link" works in one push (donor first).

### 4.4 Restricted tables (`staff_compensation`, `community_sensitive`)

Any writer with the parent project in scope may insert/update. Results never contain
stored values (`server_values` is omitted for everybody); conflicts are stored with both
values but are visible (pull, `resolve_conflict`) only to users with restricted access to
the project's country.

**Blind writes.** A caller **without** restricted access to the project's country
(field collector, branch supervisor; country manager / hq_admin are restricted readers
only at `aal2`) writes blind: the answer must not depend on what is stored (brief §3: no
salary, no restricted data of others; acceptance criterion 5). For such a caller:

- **Constant answer.** Every accepted upsert or delete returns exactly
  `{ "op_id": "…", "status": "applied", "version": null }` (plus `ignored_fields` when the
  payload had unknown names) — no `row_id`, `conflict_ids`, `conflict_fields`, no `merged`.
  Whether the values were written, were already equal, or were stored as open
  `sync_conflicts` for a country manager (a value another device entered differently) is
  not disclosed; `duplicate` replays return the same constant.
- **Addressed by the natural key, never by the row id.** An upsert must name its parent
  (`project_id` / `project_staff_id`; otherwise `parent_required`, also when the op's id
  exists) and is applied to the live row of its natural key, or inserted. The op's id only
  becomes the id of a newly inserted row (a new id is generated when it is already taken).
  So a partial update by id is refused, and an op naming another row's id never touches
  that row.
- **Validated as an insert.** Before an existing row is touched the payload is checked as
  the insert of a new row would be (NOT NULL columns, check constraints, types, foreign
  keys, `created_at`); a redirected insert under a deleted parent is `parent_deleted`. A
  rejection therefore never tells whether a row exists or which values it has, and an
  invalid value never becomes a conflict.

Device rule (brief §3): a device without restricted capability keeps such a row only in
`restricted_local` until the op returns any non-rejected status, then deletes it. Because
the result carries no `row_id`, a queued edit of such a row (made while its insert was in
flight) must be sent as the **complete** row (natural key and all fields), never as a
diff; the simplest way is to coalesce edits into the pending insert. Because of the natural
keys a collector can re-enter the data later with a new row id; if another device wrote
different values meanwhile, a country manager decides the open conflict.

### 4.5 Op-level error codes

`invalid_op`, `missing_table`, `missing_id`, `invalid_kind`, `invalid_fields`,
`invalid_base_version`, `unknown_table`, `table_not_writable`, `operation_not_allowed`,
`out_of_scope`, `not_owner`, `reviewer_required`, `parent_required`, `parent_missing`,
`parent_deleted`, `row_deleted`, `id_taken`, `op_id_taken`, `immutable_field`,
`invalid_coordinates`, `branch_country_mismatch`, `locality_country_mismatch`, `invalid_record_state`,
`forbidden_transition`, `invalid_transition`, `invalid_status`, `locality_locked`,
`person_not_available`, `donor_not_available`; from table triggers: `photo_limit_exceeded`,
`photo_project_immutable`, `invalid_option_value`, …; database constraints:
`unique_violation`, `fk_violation`, `not_null_violation`, `check_violation`
(with `constraint`), `invalid_value` (type/format), `internal_error`.

---

## 5. `sync_pull(p_cursor jsonb default null, p_limit int default 500)` → jsonb

```jsonc
// first call: p_cursor = null. p_limit is clamped to 1..1000.
{ "changes": [ { "table": "projects",
                 "rows": [ { "id": "…", "version": 3, "deleted_at": null, "lon": 39.75, "lat": -5.05, … } ],
                 "gone": ["<id>", …] } ],          // optional, see 5.3
  "cursor": { … },                                 // opaque; send it back unchanged
  "done": false,                                   // false: call again immediately with the new cursor
  "reset": false,                                  // true: the cursor was discarded, see 5.2
  "scope_epoch": "…", "server_time": "…" }
```

- A row is the full table row (all columns, snake_case, ISO timestamps) **without**
  `sync_xid` and geometry; point tables carry `lon`/`lat`.
- `changes` lists tables in registry order (parents before children); a table appears only
  when it has rows (or `gone` ids) on that page. The total number of rows per call is
  ≤ `p_limit`.
- Tombstones are rows with `deleted_at` set. They are sent in incremental rounds only; a
  first round (null cursor / reset) contains live rows only.
- Loop: call with the stored cursor until `done` is `true`; store the returned cursor after
  each page has been written to IndexedDB (same transaction). A page may be requested again
  with the same cursor (the result is the same rows or fewer).
- When `done` is `true`, keep the cursor for the next cycle (2 minutes later, on
  reconnect, or "sync now").

### 5.1 What a round guarantees

Every row carries `sync_xid`, the id of the transaction that last wrote it. A round returns
the rows with `lo ≤ sync_xid < hi`, where `hi` = `pg_snapshot_xmin` at the start of the
round = the oldest transaction still running. Rows written by a transaction that is still
open (or that committed after an older one that is still open) are **not skipped**: they
lie at or above `hi` and are delivered by the next round. Rows changed while a round is
being paged leave the window and arrive in the next round; nothing enters the window, so
paging is stable. Consequence: a long-running write transaction delays (never loses)
everybody's incremental changes — keep server-side transactions short.

Paging order is an implementation detail of the opaque cursor: `(sync_xid, id)` in
incremental rounds; in a first round child tables of a scoped user are paged by
`(parent id, id)`; `donors` of a caller who is not a global reader are paged by `id`.

### 5.2 `scope_epoch` and `reset`

`scope_epoch` = hash(sync epoch, user id, effective roles). It changes when roles are
granted/removed, on an AAL change, when another user signs in on the device and when an
operator rotates the sync epoch. The client stores the last `scope_epoch`; when the value
in `my_context()` or in a pull response differs, or when a response has `reset: true`
(cursor issued for another epoch or another database cluster), the client **discards all
synced tables** (keeping `outbox`, `photo_blobs`, `drafts`, `restricted_local`), stores the
new epoch and applies the response as the first page of a fresh pull.

### 5.3 `gone`

When a project or person leaves the caller's scope (re-assigned to another branch/country),
the next incremental round lists its id under `gone` of that table. The client deletes the
row and — for projects — all its children locally (pending outbox ops for them will come
back `rejected/out_of_scope`). Users of the new scope receive the project together with
all its children in the same round (children are re-stamped server-side; persons keep their
own scope and move only when their `country_id`/`branch_id` is changed).

### 5.4 Who gets what

`viewer`: no `persons`, `project_staff`, restricted or review tables. `field_collector` /
`branch_supervisor`: never the restricted tables. `country_manager` / `hq_admin` (aal2):
restricted tables of their countries; every page containing restricted rows writes one
`restricted_access_log` row per table (`context = 'sync_pull'`; conflicts about restricted
rows: `'sync_pull:sync_conflicts'`). Without any effective role only the caller's own
notifications and the donors he created are returned (the same rows RLS shows him).

Errors: `PT401`, `PT403 session_revoked`, `PT422 invalid_cursor`, `PT429` (600 calls / minute
/ user).

### 5.5 Donors

Donors have no country or branch. `sync_pull` sends **exactly the donors the RLS policy
`donors_select` shows** (pgTAP compares the two sets for every role):

| Caller                                            | Donors received                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| global reader (`hq_admin` at aal2, global viewer) | all                                                                                        |
| everybody else                                    | donors he created + donors linked by a `project_donors` row to a project in his read scope |
| no effective role                                 | donors he created                                                                          |

"Linked" means any `project_donors` row, live or soft-deleted, to any project in scope, live
or soft-deleted — the policy does not look at `deleted_at`, and neither does sync. A Kenyan
collector therefore never receives a donor that is linked only to Tanzanian projects.

**How a donor that becomes visible later arrives.** A donor can become visible without
being written itself: somebody links an existing donor to one of the caller's projects, or a
project that carries links is moved into the caller's scope. The donor's own `sync_xid` is
old, so the window test on the donor alone would never deliver it. The server does **not**
re-stamp donors on link writes (that would take a row lock on popular donors for every link
and bump their `version` / `updated_by` without a data change). Instead the link rows are
the change signal. An incremental round returns

- (a) the visible donors whose own `sync_xid` is in the window, and
- (b) the donors of the `project_donors` rows in the caller's scope whose `sync_xid` is in
  the window (new or edited link; link re-stamped because its project changed scope, §5.3).

Every way a link can appear in a caller's scope writes (stamps) the link row, so (b) covers
every way a donor can become visible; a change of roles changes `scope_epoch` and restarts
the pull. `donors` precede `project_donors` in the registry, so the donor arrives in the
same round as, and before, the link that needs it. A first round is driven by the caller's
projects and own donors.

Consequences for the client:

- a donor row may arrive although its `version` did not change (b); apply it as any other
  row (idempotent upsert);
- there is no `gone` list for donors: a donor that is no longer linked to a project in scope
  (link re-pointed, project moved away) stays on the device until the next full resync and
  no longer receives updates; edits of such a donor come back `rejected/out_of_scope`.

---

## 6. `resolve_conflict(p_conflict_id uuid, p_choice text)` → jsonb

`p_choice`: `"server"` (keep the current value) or `"client"` (write `client_value` as a
new row version; it then reaches every device through pull).
Returns `{ "id", "state": "resolved_server" | "resolved_client", "table", "row_id", "field", "version", "server_time" }`
and stamps `state`, `resolved_by`, `resolved_at` on the conflict (which syncs to reviewers).

Allowed for a reviewer of the row the conflict is about; conflicts on restricted tables
additionally need restricted access to the project's country (and the read is logged);
conflicts on rows without country/branch (donors) need a global reviewer.
Errors: `PT404 conflict_not_found`, `PT403 out_of_scope`, `PT409 conflict_already_resolved`,
`PT409 row_deleted` (choice `client` on a deleted row — close it with `server`),
`PT409 row_missing`, `PT422 invalid_choice`, `PT429` (120 / minute).

A location conflict has `field = "geom"` with `server_value` / `client_value` =
`{"lon": …, "lat": …}`.

---

## 7. Client obligations (summary)

1. Generate row ids (UUIDv7) and one `op_id` per queued operation on the device; never
   change an `op_id` when retrying.
2. **Order**: within the outbox keep creation order; a batch must contain a parent before
   its children (project → children; person → `project_staff` → `staff_compensation`;
   donor → `project_donors`). Push batches of ≤ 50 sequentially; do not send the next batch
   before the previous one answered.
3. **Coalescing**: consecutive pending upserts of the same row may be merged into one op
   (union of fields, keep the **oldest** `base_version`, keep the first `op_id` only if it
   was never sent — otherwise use a new op). An insert followed by a delete that was never
   sent cancels out. Never coalesce across a `record_state` transition you need the server
   to validate separately.
4. `base_version` = the `version` the local row had when the edit was made (0 for rows
   created on the device and not yet acknowledged). After `applied`/`merged` store the
   returned `version` (if `row_id` is present, drop the local row instead).
5. Send only changed fields on update; send `lon` and `lat` together. On insert send
   `created_at` = the time the row was created on the device (UTC, ISO 8601 with `Z`); never
   send it on update.
6. Handle each status as in §4.1; `rejected` ops go to `failed_ops` and never block the
   queue.
7. Push before pull in every cycle (so that the pull returns the merged rows), then page
   `sync_pull` until `done`.
8. Do not overwrite a local row that has pending outbox ops with a pulled row; re-apply the
   pending fields on top of the pulled row instead.
9. On a project tombstone or `gone`, delete the project's children locally.
10. Restricted rows on a collector's device: purge after the server acknowledged the op
    (§4.4). Every upsert of such a row carries the complete row (natural key + all
    fields): blind results carry no `row_id` / `version` to re-point queued edits to.
11. On `scope_epoch` change or `reset: true`: wipe synced tables and pull from `null`
    (§5.2). On `PT403 session_revoked` or `register_device().revoked`: wipe everything and
    sign out.
12. Send `x-device-id` on every request; call `register_device` after sign-in and
    `report_device_status` after each cycle (pending counters for the sync-status board).

---

## 8. Operations

| Function (run as the database owner / service role)                                     | When                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `private.sync_refresh()`                                                                | after any change of `private.sync_tables`                                                                                                                                                                                                              |
| `private.sync_prune(p_ledger_keep default '180 days', p_moves_keep default '180 days')` | daily cron: trims `sync_applied_ops` and the scope-move log. The ledger must be kept longer than a device can stay offline with an unacknowledged batch                                                                                                |
| `private.sync_rotate_epoch()`                                                           | force every client to resync from scratch                                                                                                                                                                                                              |
| `private.sync_rebase()`                                                                 | **after restoring a logical dump (`pg_dump`) into a new cluster**: `sync_xid` values of the old cluster are "in the future" for the new one and would never be pulled. Re-stamps all rows and rotates the epoch. Not needed after PITR or `pg_upgrade` |

Measured on the development machine with 100k projects / 500k persons / 500k staff /
1M photos (single caller, 500 rows per page): idle or small incremental pull ≈ 2 ms;
first-sync pages ≈ 20–45 ms on average (p95 ≤ 100 ms) for branch, country and global
scopes; `sync_push` ≈ 3–5 ms per operation (50 ops ≈ 0.2 s).
Donor rule, measured with 40k projects / 6k donors / 80k links: a first-sync page of 500
donors ≈ 20 ms for a branch with 2k projects, ≈ 30–55 ms for a scope of 20k projects
(the candidate list is rebuilt per page from the caller's links), ≈ 5 ms for a global
reader; an incremental round with a new link and a changed donor ≈ 4–8 ms.

Known limits: (1) conflict detection needs `audit_log` rows of the row since `base_version`
— do not prune the audit log younger than the longest offline period; (2) a person keeps
its own scope when its project moves to another branch; (3) localities/admin areas that
change country are not reported as `gone`; (4) donors that leave the caller's visibility
are not reported as `gone` (§5.5); (5) `created_at` sent by a device whose clock is in the
past is stored as sent (only the future is clamped).

### People columns of public tables (owner_name)

`project_land` is a public child (every reader of the project receives it), but
`owner_name` is people data: `sync_pull` builds its select list with
`private.sync_wire_list(table, alias, ctx)`, which returns `owner_name = null` for callers
without people scope on the row (viewers, and readers whose people scope does not cover the
project). Writes (`sync_push`, `resolve_conflict`) keep the full projection because they merge
against the stored value. Clients must treat a null `owner_name` from a viewer pull as
"not visible", never as "cleared".

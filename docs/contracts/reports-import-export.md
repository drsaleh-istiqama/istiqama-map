# Contract — dashboards, export, import, scheduled jobs, photo retention

Migrations `supabase/migrations/20261003005[0-8]00_*.sql`, tests `supabase/tests/5*_*.test.sql`.
Spec: `docs/BRIEF.md` §5 (materialized views), §9 (dashboard, export, PDF), §10 (import),
§11 (90-day photo retention). Names in this file are binding for the web app and the Edge Functions.

All RPCs are `SECURITY DEFINER` with their own authorisation, pinned `search_path`, no `anon`
access. Errors use the project codes: `PT401` no user, `PT403` forbidden, `PT404` not found /
not yours, `PT409` wrong state, `PT422` validation, `PT429` rate limit.

**Session gate.** Every RPC called with a user JWT (all rows below except the service-role ones)
starts with `private.require_session()`: no JWT user → `PT401`; a revoked session
(`profiles.sessions_revoked_at`), a deactivated / deleted account or a revoked device
(`x-device-id`) → `PT403` with message `session_revoked` — the same error as `sync_pull` /
`sync_push`, so the client signs out. The check runs before any rate limit, read or write; it
also covers the owner-only RPCs (`import_preview`, `import_set_action`, `import_commit`,
`import_rollback`, `export_rows`, `export_cancel`) whose owner check uses no scope helper. A
revoked session in the middle of an export makes `export_rows` fail (the job ends `failed`), it
never returns an empty "done" page.
Functions that write (rate limit, access log, jobs) are `VOLATILE` → call them with **POST**
(`supabase.rpc()` default). `export_columns`, `import_template`, `import_preview` are `STABLE`.

| RPC | Caller | Volatile |
|---|---|---|
| `dashboard(p_scope_type text, p_scope_id uuid default null)` → jsonb | any role with read scope | yes |
| `report_project(p_id uuid)` → jsonb | read scope of the project | yes |
| `report_donor(p_id uuid)` → jsonb | any role; the donor must be visible to the caller | yes |
| `report_country(p_id uuid)` → jsonb | read scope of the country | yes |
| `export_request(p_format text, p_lang text default 'ar', p_filters jsonb default '{}')` → jsonb | any role | yes |
| `export_columns(p_lang text default 'ar')` → jsonb | any role | no |
| `export_rows(p_job_id uuid, p_after jsonb default null, p_limit int default 1000)` → jsonb | job owner | yes |
| `export_cancel(p_job_id uuid)` → jsonb | job owner | yes |
| `export_finish(p_job_id uuid, p_state text, p_storage_path text default null, p_row_count int default null, p_error text default null, p_file_name text default null, p_bytes bigint default null)` → jsonb | **service role** | yes |
| `import_template(p_lang text default 'ar')` → jsonb | any signed-in user | no |
| `import_stage(p_meta jsonb, p_rows jsonb)` → jsonb | writers | yes |
| `import_preview(p_batch_id uuid, p_after int default 0, p_limit int default 100, p_only text default null)` → jsonb | batch owner, hq_admin | no |
| `import_set_action(p_batch_id uuid, p_row_no int, p_action text, p_target_id uuid default null)` → jsonb | batch owner | yes |
| `import_commit(p_batch_id uuid)` → jsonb | batch owner | yes |
| `import_rollback(p_batch_id uuid)` → jsonb | batch owner, hq_admin | yes |
| `refresh_reports()` → jsonb | **service role / cron** | yes |
| `photos_to_purge(p_limit int default 500)` → setof record | **service role** | no |
| `mark_photos_purged(p_ids uuid[])` → int | **service role** | yes |

"Service role" = the request carries the service-role key (JWT `role = service_role`) or there is
no JWT at all (pg_cron, migrations). `authenticated` has no `EXECUTE` on these functions.

---

## 1. Materialized views (schema `private`, never exposed)

Refreshed together by `refresh_reports()`; every view has a unique index and is refreshed
`CONCURRENTLY`. A missing country / branch / level-1 area is stored as the nil UUID
(`private.nil_uuid()`) and returned as JSON `null`.

| View | Grain | Measures |
|---|---|---|
| `mv_project_totals` | country, branch, level-1 area, type, status | `project_count`, `capacity_sum`, `draft_count`, `submitted_count`, `approved_count`, `returned_count` |
| `mv_maintenance_open` | country, branch, priority, currency | `open_count`, `cost_sum` (states `open`, `in_progress`) |
| `mv_maintenance_items` | one row per open maintenance entry | project code/names, priority, `priority_rank`, state, date, description, cost |
| `mv_staff_roles` | country, branch, role | `assignment_count`, `person_count` (current assignments: `end_date` null or in the future) |
| `mv_payroll` (restricted) | country, branch, currency | `staff_paid`, `monthly_total`, `usd_per_unit`, `rate_date`, `monthly_total_usd` |
| `mv_needs` | country, branch | `quran_need`, `quran_count`, `quran_need_projects`, `teacher_housing_gaps`, `imam_housing_gaps`, `transport_needed`, `expandable_sites` |
| `mv_completeness` | country, branch | `project_count`, `completeness_sum`, `incomplete_count` (< 100), `below_half_count` (< 50) |
| `mv_entry_activity` | ISO week (UTC, Monday), user, country, branch — last 12 weeks | `created_count`, `updated_count` |

Rules:
- All non-deleted projects are counted whatever their `record_state`; the split by record state is
  in `totals.by_record_state`.
- Payroll = the latest `staff_compensation` row (`effective_from <= today`) of every current
  assignment. Amounts of different currencies are **never added**; the USD figure uses the latest
  `fx_rates` row per currency (`USD` itself = 1). A currency without a rate has
  `monthly_total_usd = null` and is listed in `payroll.missing_rates`.
- Housing gap = the flag is explicitly `false` (v2 rule); `null` = unknown, not a gap.
- Entry activity is derived from `projects.created_at/created_by` and
  `updated_at/updated_by`: `created` = projects created by the user in the week; `updated` =
  projects whose latest change was made by the user in the week, except the ones the same user
  created in that same week. (Only the latest change of a project is visible this way.)

`refresh_reports()` → `{ "skipped": false, "refreshed_at": "…", "duration_ms": 1234, "reports_ms": 250, "clusters_refreshed": true }`
(or `{ "skipped": true, "reason": "already_running" }`). `reports_ms` = the eight views above;
the rest of `duration_ms` is `private.refresh_clusters()`, which is called when that function
exists. A failure of the cluster refresh does not undo the report refresh: the result then has
`"clusters_refreshed": false, "clusters_error": "<message>"`. Scheduling: `pg_cron` job `istiqama-refresh-reports` (`*/15 * * * *`)
is created only when the extension is available and can be enabled; otherwise the caller is the
gateway timer (local) with the service key. Other cron jobs created the same way:
`istiqama-rate-limit-cleanup` (hourly), `istiqama-expire-exports` (daily, `private.expire_export_jobs()`:
`done` → `expired` after 7 days, stuck `queued`/`running` → `failed` after 1 day).

---

## 2. `dashboard(p_scope_type, p_scope_id)`

`p_scope_type`: `global` (`p_scope_id` ignored) | `country` (countries.id) | `branch` (branches.id).

Access: `global` needs a global role; `country` a global role or a role on that country;
`branch` a global role, a role on the branch's country, or a role on that branch. Otherwise `PT403`.
- `payroll` is present only when the caller has restricted access to the scope's country
  (`country_manager` of it or `hq_admin`, both at AAL2); each call that returns it writes one
  `restricted_access_log` row (`table_name = staff_compensation`, empty id list,
  `context = 'dashboard.payroll:<type>[:<id>]'`).
- `entry_activity.collectors` (user names) is omitted for viewers.
- Rate limit: 120 calls / minute / user.

```jsonc
{
  "scope": { "type": "country", "id": "…", "iso2": "TZ", "name_ar": "…", "name_en": "…", "name_sw": "…", "default_currency": "TZS" },
  //        branch: { type, id, code, name_ar, name_en, name_sw, country_id }   global: { type: "global", id: null }
  "last_refreshed_at": "2026-10-03T14:15:00+00:00",     // when the materialized views were refreshed
  "generated_at": "…",
  "totals": {
    "projects": 3, "capacity": 300, "areas_covered": 2,
    "by_type": { "mosque": 1, "school": 1, "combined": 1 },
    "by_status": { "active": 3, "maintenance": 0, "building": 0, "inactive": 0 },
    "capacity_by_type": { "mosque": 100, "school": 100, "combined": 100 },
    "by_record_state": { "draft": 1, "submitted": 0, "approved": 2, "returned": 0 },
    "by_type_status": [ { "type": "mosque", "status": "active", "projects": 1, "capacity": 100 } ],
    "by_area": [ { "area_id": "…|null", "country_id": "…", "code": "…", "name_ar": "…", "name_en": "…", "name_sw": "…",
                   "projects": 2, "capacity": 200, "mosque": 1, "school": 1, "combined": 0, "maintenance": 0 } ],   // level-1 areas
    "by_country": [ { "country_id", "iso2", "name_*", "projects", "capacity", "mosque", "school", "combined", "maintenance" } ],   // global only
    "by_branch":  [ { "branch_id": "…|null", "code", "country_id", "name_*", "projects", "capacity", "mosque", "school", "combined", "maintenance" } ]  // global + country
  },
  "maintenance": {
    "open_total": 2,
    "by_priority": { "urgent": 0, "high": 2, "medium": 0, "low": 0 },
    "estimated_cost": [ { "currency": "USD", "amount": 3000.00, "amount_usd": 3000.00 } ],   // per currency, amount_usd null without a rate
    "items": [ { "id", "project_id", "project_code", "project_name_ar", "project_name_latin", "priority", "state",
                 "reported_on", "description", "estimated_cost", "currency" } ]               // 20 most urgent, oldest first
  },
  "staff": { "assignments": 3, "by_role": { "imam": 2, "teacher": 1, "agent": 0, "administrator": 0, "manager": 0, "other": 0 } },
  "payroll": {                                           // ONLY with restricted access
    "staff_paid": 3,
    "by_currency": [ { "currency": "TZS", "staff_paid": 2, "monthly_total": 500000.00, "usd_per_unit": 0.0004,
                       "rate_date": "2026-10-03", "monthly_total_usd": 200.00 } ],
    "monthly_total_usd": 300.00,                         // sum of the currencies that have a rate
    "missing_rates": []                                  // currencies without an fx rate
  },
  "needs": { "quran_need": 120, "quran_count": 80, "quran_need_projects": 2, "teacher_housing_gaps": 0,
             "imam_housing_gaps": 1, "housing_gaps": 1, "transport_needed": 2, "expandable_sites": 2 },
  "completeness": { "projects": 2, "average": 87.5, "incomplete": 1, "complete": 1, "below_half": 0 },   // average null when empty
  "entry_activity": {
    "weeks": [ "2026-07-13", "…12 Mondays, oldest first…" ],
    "totals": [ { "week_start": "2026-07-13", "created": 0, "updated": 0 } ],                // 12 entries, same order
    "collector_count": 1,
    "collectors": [ { "user_id": "…", "full_name": "…", "created": 2, "updated": 0,          // NOT for viewers; top 50
                      "weeks": [ { "week_start": "2026-09-28", "created": 2, "updated": 0 } ] } ]   // only weeks with activity
  }
}
```

In `by_area` / `by_country` / `by_branch`, `maintenance` = projects whose **status** is
`maintenance` (the open maintenance entries are in the `maintenance` section).

---

## 3. Print / PDF data

### `report_project(p_id)`
`PT404` when the project does not exist, is deleted, or is outside the caller's read scope.

```jsonc
{
  "generated_at": "…",
  "capabilities": { "people": true, "restricted": false },
  "project": { /* every column of projects except geom/search_norm/sync_xid/deleted_at/import_batch_id */ "lon": 39.75, "lat": -5.05 },
  "country": { "id", "iso2", "name_ar", "name_en", "name_sw" },
  "admin_areas": [ { "id", "level", "code", "name_ar", "name_en", "name_sw" } ],     // level 1 first
  "locality": { "id", "name_ar", "name_latin", "status" } | null,
  "branch": { "id", "code", "name_ar", "name_en", "name_sw" } | null,
  "land": { /* project_land row; owner_name only for callers who may see people of the project */ } | null,
  "facilities": { /* project_facilities row */ } | null,
  "community": { /* community_profiles row */,
                 "lists": { "daawa_activities": { "options": [ { "id", "code", "name_ar", "name_en", "name_sw" } ], "other": "…|null" }, /* …7 lists… */ } } | null,
  "photos": [ { "id", "storage_path_thumb", "storage_path_full", "is_cover", "category", "caption", "taken_at", "width", "height" } ],  // uploaded only, cover first
  "donors": [ { "id", "donor_id", "name_ar", "name_latin", "amount", "currency", "year" } ],
  "maintenance": [ { "id", "reported_on", "description", "priority", "state", "estimated_cost", "currency", "resolved_on" } ],   // newest first
  "staff_count": 2,                                    // current assignments, for everybody
  "staff": [ { "project_staff_id", "person_id", "person_visible": true, "name_ar", "name_latin", "role", "start_date", "end_date", "phone",
               "gender", "birth_year", "education_level", "graduated_from",
               "monthly_amount", "currency", "effective_from" } ],     // key ABSENT for viewers; the 3 salary keys only with restricted access
  "entered_by": { "id", "full_name" },                 // absent for viewers
  "sensitive": { /* community_sensitive row */ } | null      // key ABSENT without restricted access
}
```
Photos are paths in bucket `photos`; lists must show the thumbnail and sign the full path on demand.
Restricted reads are logged (`context = 'report_project:<id>'`).

`staff` follows two rules, exactly like RLS / `sync_pull`: the assignments are listed when the
**project** is in the caller's people scope (`project_staff_select`), and the person columns
(`name_ar`, `name_latin`, `phone`, `gender`, `birth_year`, `education_level`, `graduated_from`) are
filled only when the **person** is in the caller's people scope (`persons_select`). Persons keep
their own country / branch when a project moves (sync.md §5.3, known limit 2), so after a move the
new branch sees the assignment of a person it cannot see: that entry has `person_visible: false`
and `null` in every person column (role, dates, `person_id` and — with restricted access — the
salary of the assignment stay). Render it as "hidden person". `staff_count` counts all assignments.

### `report_donor(p_id)`
`PT404` when the donor does not exist, is deleted, **or is not visible to the caller** — the rule of
the RLS policy `donors_select`, `sync_pull` and `sync_push` (sync.md §5.5): global readers see every
donor, everybody else the donors he created and the donors linked by a `project_donors` row to a
project in his read scope. A hidden donor and an unknown id give the same error (brief §14.5: a
Kenyan user never receives a donor known only in Tanzania, not even its name). `PT403` caller
without any role. Only the donor's projects inside the caller's read scope are counted and listed
(max 500, ordered by first contribution year, then code); a visible donor without such a project
(e.g. one the caller created) returns `projects_total: 0`.

```jsonc
{
  "generated_at": "…",
  "donor": { "id", "name_ar", "name_latin", "notes" },
  "summary": { "projects": 1, "capacity": 100, "by_type": {…}, "by_status": {…},
               "contributions": [ { "currency": "USD", "amount": 5000.00 } ] },      // per currency
  "projects": [ { "id", "code", "name_ar", "name_latin", "type", "status", "record_state", "capacity", "build_year", "lon", "lat",
                  "country": { "id", "iso2", "name_*" }, "admin_area": { "id", "level", "name_*" } | null,
                  "locality": { "id", "name_ar", "name_latin" } | null,
                  "contributions": [ { "amount", "currency", "year" } ],
                  "open_maintenance": 1,
                  "photos": [ { "id", "storage_path_thumb", "storage_path_full", "is_cover", "category", "caption", "taken_at" } ] } ],
  "projects_total": 1, "truncated": false
}
```

### `report_country(p_id)`
Same access rule as `dashboard('country', p_id)` (`PT403` otherwise). Returns the complete
`dashboard('country', …)` document **plus**:

```jsonc
"branches": [ { "branch_id": "…|null", "code", "name_ar", "name_en", "name_sw",
                "projects", "capacity", "approved",
                "by_type": { "mosque", "school", "combined" }, "by_status": { "active", "maintenance", "building", "inactive" },
                "open_maintenance", "urgent_maintenance", "staff", "quran_need", "housing_gaps", "transport_needed",
                "expandable_sites", "completeness_average", "incomplete",
                "payroll": { "by_currency": [ { "currency", "staff_paid", "monthly_total", "monthly_total_usd" } ], "monthly_total_usd" } } ]   // payroll only with restricted access
```
Every branch of the country is listed (also empty ones); projects without a branch form a row with
`branch_id: null`.

---

## 4. Export

Flow driven by the `export` Edge Function:

1. Client: `export_request(format, lang, filters)` → the `export_jobs` row
   (`{ id, user_id, format, lang, filters, state: "queued", … }`). `format`: `csv` | `xlsx`;
   `lang`: `ar` | `sw` | `en`. Limits: 20 requests / hour, 3 active jobs per user (`PT429`).
   The client then invokes the Edge Function with `{ job_id }` and its own JWT.
2. Function, **with the caller's JWT**: `export_columns(lang)` once, then `export_rows(job_id, after, limit)`
   until `done`. Start with `p_after = null`, pass back the `next` value. Max page 2,000.
3. Function builds the file: header row = `columns[].header` in order; cell = `row[key]`;
   for `kind = "enum" | "boolean"` translate through `enums[column.enum][String(value)]`;
   `null` → empty cell. CSV: UTF-8 **with BOM**, CRLF, and the v2 formula-injection guard
   (prefix `'` when a text cell starts with `=`, `+`, `-`, `@`, tab or CR). XLSX: same cells,
   sheet direction from `dir`.
4. Function uploads to bucket `exports` at `{user_id}/{job_id}.{csv|xlsx}` and calls, **with the
   service key**, `export_finish(job_id, 'done', storage_path, row_count, null, file_name, bytes)`
   (or `'failed'` with `p_error`). That inserts the notification:
   - `kind = 'export.ready'`, payload `{ job_id, format, lang, bucket: "exports", storage_path, file_name, bytes, row_count, expires_at }`
   - `kind = 'export.failed'`, payload `{ job_id, format, lang, error }`
   The client creates a signed URL for `storage_path` (own folder → allowed by the storage policy).
   `export_finish(job, 'running')` may be used to count attempts. `export_cancel(job)` lets the owner stop a job
   (the next `export_rows` call then fails with `PT409`).

`p_filters` (all optional, same keys as `projects_page`): `country_id`, `branch_id`,
`admin_area_id` (descendants included), `locality_id`, `donor_id`, `type`, `status`, `record_state`
(string or array), `q`, `incomplete`, `created_by_me`, `has_open_maintenance`, plus `ids`
(array of project ids).

### `export_columns(p_lang)`
```jsonc
{ "lang": "ar", "dir": "rtl", "list_separator": " | ",
  "capabilities": { "people": true, "restricted": false },
  "columns": [ { "key": "code", "header": "رمز المشروع", "kind": "text" },
               { "key": "type", "header": "النوع", "kind": "enum", "enum": "project_type" },
               { "key": "land_expandable", "header": "قابلية التوسع", "kind": "boolean", "enum": "boolean" } ],
  "enums": { "project_type": { "mosque": "مسجد", "school": "مدرسة قرآن", "combined": "مسجد ومدرسة" },
             "project_status": { "active": "يعمل", "maintenance": "يحتاج صيانة", "building": "قيد الإنشاء", "inactive": "متوقف" },
             "boolean": { "true": "نعم", "false": "لا" }, "…": {} } }
```
`kind`: `text` | `integer` | `number` | `date` (`YYYY-MM-DD`) | `datetime` (ISO 8601) | `boolean` | `enum` | `list`
(`list` = text already joined with ` | `). Enum keys: `project_type`, `project_status`, `record_state`,
`location_source`, `land_ownership`, `student_transport`, `students_origin`, `maintenance_priority`,
`maintenance_state`, `staff_role`, `guest_financial_capacity`, `boolean`.
Sw/en examples: `mosque` → `Msikiti` / `Mosque`; `active` → `Inafanya kazi` / `Active`.

Column keys in order (the list returned to a caller contains only the groups it may see):

- **all**: `code`, `name_ar`, `name_latin`, `type`, `status`, `record_state`, `capacity`, `country`, `country_iso2`,
  `area_level1`, `area_level2`, `area_level3`, `admin_area_code`, `locality`, `branch`, `lat`, `lon`, `gps_accuracy_m`,
  `location_source`, `builder`, `build_year`, `build_date`, `completeness`, `review_note`,
  `land_ownership`, `land_owner_name`, `land_area_m2`, `land_utilization_pct`, `land_expandable`, `land_notes`,
  `teacher_housing`, `imam_housing`, `guest_housing`, `library`, `quran_count`, `quran_need`, `hall`, `hall_capacity`,
  `student_transport`, `students_origin`,
  `community_branch_name`, `population`, `muslim_pct`, `daawa_activities`, `social_features`, `livelihoods`,
  `religious_issues`, `religious_challenges`, `social_challenges`, `proposed_activities` (option names in the job
  language followed by the free "other" text),
  `donors`, `maintenance_open`, `maintenance_total`, `maintenance_last_reported`, `maintenance_open_details`,
  `maintenance_open_cost`, `photo_count`, `staff_count`
- **people** (not for viewers): `manager_name`, `manager_phone`, `staff_list`, `entered_by`
- **restricted** (country_manager / hq_admin): `monthly_payroll` (per currency, e.g. `TZS 250000 | USD 100`),
  `monthly_payroll_usd`, `ibadi_families`, `omani_families`, `omani_student_pct`, `ibadi_student_pct`,
  `omani_teacher_pct`, `ibadi_teacher_pct`, `guest_financial_capacity`
- **all** (last): `external_id`, `id`, `created_at`, `updated_at`

### `export_rows(p_job_id, p_after, p_limit)`
```jsonc
{ "job_id": "…", "count": 1000, "done": false, "next": { "id": "<last project id>" },
  "rows": [ { "code": "TZ-PN-000001", "type": "mosque", "status": "active", "land_expandable": true,
              "country": "تنزانيا", "staff_list": "… (إمام) | … (معلم)", "…": "one key per column" } ] }
```
- Rows are ordered by project id (UUIDv7 = creation order). `next` is `null` on the last page.
- Enum columns carry the **code**, booleans JSON booleans (translate with `export_columns().enums`);
  names of countries / areas / branches / option values, staff roles and maintenance priorities
  inside composite cells are already in the job language.
- People keys exist only when the caller has a non-viewer role somewhere; restricted keys only with
  restricted access somewhere. Inside a mixed scope, rows outside that capability carry `null`.
- Person names and phones also follow the **person's** own scope (`persons_select`, as in
  `report_project`): a current staff member whose person row is outside the caller's people scope
  (persons stay put when a project moves) appears in `staff_list` as `?` with the role, and is never
  used for `manager_name` / `manager_phone` (those come from the first visible manager, or `null`).
- `PT404` unknown job or not the caller's; `PT409` job not `queued`/`running`. The first call moves
  the job to `running`; every call stores `next` in `export_jobs.cursor` (resume point).
- Restricted pages are logged (`context = 'export:<job id>'`, ids of the compensation / sensitive rows read).
- Rate limit 600 calls / minute.

---

## 5. Import

Flow: the `import` Edge Function (or the web app directly for small files) parses CSV / XLSX into
an array of row objects and calls `import_stage` **with the caller's JWT**; everything else is
called by the web app.

### `import_template(p_lang)`
```jsonc
{ "version": 1, "lang": "ar", "dir": "rtl", "max_rows": 5000, "list_separator": "|", "date_format": "YYYY-MM-DD",
  "merge_key": "external_id",
  "columns": [ { "key": "type", "header": "النوع", "headers": { "ar": "النوع", "sw": "Aina", "en": "Type" },
                 "required": true, "kind": "enum", "example": "mosque",
                 "allowed": [ { "code": "mosque", "label": "مسجد" }, … ],      // enum, boolean and list columns
                 "min": 0, "max": 100 } ] }                                     // numeric columns
```
Columns: `external_id`, `name_ar`*, `name_latin`, `type`*, `status`, `capacity`, `lat`*, `lon`*, `gps_accuracy_m`,
`country`* (ISO code or name), `area` (admin-area code or name), `locality` (name), `branch` (code or name),
`builder`, `build_year`, `build_date`, `land_ownership`, `land_owner_name`, `land_area_m2`, `land_utilization_pct`,
`land_expandable`, `land_notes`, `teacher_housing`, `imam_housing`, `guest_housing`, `library`, `quran_count`,
`quran_need`, `hall`, `hall_capacity`, `student_transport`, `students_origin`, `community_branch_name`,
`population`, `muslim_pct`, the seven option lists, `donor`, `donor_amount`, `donor_currency`, `donor_year`,
`maintenance_note`, `maintenance_priority`. (* required for new records.)
Staff, salaries and sensitive community data are deliberately **not importable**.

### `import_stage(p_meta, p_rows)`
`p_rows`: JSON array (1…5,000) of objects `header → cell`. A header may be the column `key` or its
header in **any** of the three languages (normalised comparison); `country_iso2` and
`admin_area_code` are accepted as aliases, so an exported file can be re-imported. Unknown headers
are ignored and listed. Cells may be strings, numbers or booleans. Enumerated values may be the
code or the label in any language; booleans `true/false/yes/no/1/0/نعم/لا/ndiyo/hapana`;
numbers may use Arabic-Indic digits; dates `YYYY-MM-DD` or `DD/MM/YYYY`; list cells are split on
`|`, `،`, `,`, `;` and items that are not official options are kept in the `<list>_other` text.

`p_meta`: `{ "file_name"?, "source_kind"?: "csv"|"xlsx"|"v2_json"|"v2_local", "storage_path"?: "<uid>/…",
"country_id"?, "branch_id"?, "column_map"?: { "<file header>": "<template key>" } }`
(`country_id` / `branch_id` = defaults for rows that do not name them).

Access: `PT403` unless the caller has a writer role; 30 batches / hour.

Validation per row:
- required cells (new records), enumerations, numbers and ranges, dates, coordinates;
- country: from the point (admin boundary containing it), else the `country` cell, else the batch
  default, else the caller's only writable country;
- `area`: fallback when no boundary contains the point; a point outside the given area or country
  is a **warning** (`point_outside_area`, `point_outside_country`) — the point wins;
- `branch`: the cell, else the batch default, else the caller's only branch in that country, else
  the only branch whose `admin_area_ids` cover the area;
- `locality`: matched by name inside the country, otherwise a *proposed* locality is created on commit
  (warning `locality_new`). Only done in a country whose localities the caller may read
  (`localities_select`); a row in any other country is `out_of_scope` anyway and gets neither a
  `locality_id` nor `locality_new`;
- every row must be inside the caller's **write scope** (`out_of_scope`);
- `external_id` already present → the row becomes an **update** of that project (only if the caller
  may update it: reviewers of its scope, or its creator while it is not approved; otherwise
  `no_write_access`); twice in the file → `duplicate_external_id_in_file`. `external_id_deleted`
  only for a deleted record the caller can read; a key held by a record **outside the caller's read
  scope**, live or deleted, always answers `no_write_access` (same text). The merge key is unique
  across all countries (`projects_external_id_key`), so a foreign key cannot be reused: that the
  key is taken stays observable (also through `sync_push` → `unique_violation`), nothing else;
- `donor`: matched by name among the donors **the caller can see** (rule of `donors_select` /
  `sync_push`, sync.md §5.5); a same-named donor known only in another scope is neither returned in
  `parsed.donor.donor_id` nor linked — the commit creates a new donor (created by the importer),
  exactly what `sync_push` lets this user do;
- duplicates (brief §7.3) for new rows: `project_duplicates()` (same type within 150 m, or similar
  name in the same locality / level-3 area) against existing projects, and between rows of the
  file itself (compatible type within 150 m, or the same normalised name in the same locality /
  level-3 area) → state `duplicate`, default action `skip`.

Row `state`: `valid` | `invalid` | `duplicate` (after commit `applied` | `skipped`; after rollback `reverted`).
Row `action`: `create` | `update` | `skip` | `null` (invalid).
Issue object: `{ "field": "<template key>|null", "code": "…", "message": "English text" }` — translate by `code`:
errors `required`, `invalid_value`, `invalid_boolean`, `invalid_number`, `invalid_integer`, `out_of_range`,
`invalid_date`, `incomplete_coordinates`, `country_not_found`, `area_not_found`, `area_ambiguous`, `branch_not_found`,
`out_of_scope`, `no_write_access`, `external_id_deleted`, `duplicate_external_id_in_file`, `too_long`, `commit_failed`;
warnings `possible_duplicate` (+ `candidates`: first 5 results of `project_duplicates`), `duplicate_in_file` (+ `row_no`),
`unknown_option`, `locality_new`, `name_ar_copied_from_latin`, `point_outside_country`, `point_outside_area`,
`area_not_found`, `donor_details_without_name`.

Summary (returned by `import_stage`, and the base of every other import response):
```jsonc
{ "batch_id": "…", "state": "validated", "source_kind": "csv", "file_name": "…", "row_count": 4,
  "counts": { "total": 4, "valid": 1, "invalid": 2, "duplicate": 1, "with_warnings": 2,
              "create": 1, "update": 0, "skip": 1,                       // what a commit would do now
              "applied_created": 0, "applied_updated": 0, "skipped": 0, "reverted": 0 },
  "ignored_columns": [ "unknown column" ],
  "first_errors": [ { "row_no": 2, "errors": [ { "field": "type", "code": "invalid_value", "message": "…" } ] } ],   // first 20 invalid rows
  "committed_at": null, "rolled_back_at": null }
```

### `import_preview(p_batch_id, p_after, p_limit, p_only)`
Summary + `"rows": [ { "row_no", "state", "action", "external_id", "errors", "warnings", "duplicate_of", "target_id", "raw", "parsed" } ]`
+ `"next": <row_no> | null`. Keyset by `row_no` (`p_after` = last row number seen, start with 0), max 500 per page.
`p_only`: `invalid` | `duplicate` | `valid` | `warnings` | `create` | `update` | `skip`.
`parsed` = `{ project: {… resolved ids, lon, lat …}, land?, facilities?, community?, locality_new?, donor?, maintenance?,
given: ["<template keys that had a cell>"], dup_place? }` (`given` / `dup_place` are internal).

### `import_set_action(p_batch_id, p_row_no, p_action, p_target_id)`
Only while the batch is `validated`; invalid rows cannot be changed (`PT422`).
- `skip` — leave the row out;
- `create` — force a duplicate ("different project");
- `update` — merge into `p_target_id` (default: the row's `target_id` or `duplicate_of`) — "it is the same one".
  Needs the right to update the target (`PT403` otherwise); the merge writes only the cells of the
  file (defaults such as status `active` or the default branch are not applied).
Returns the row (`row_no`, `state`, `action`, `errors`, `warnings`, `duplicate_of`, `target_id`).

### `import_commit(p_batch_id)`
All-or-nothing. New projects: `record_state = 'draft'`, `location_source = 'import'`,
`import_batch_id = batch`, created by the caller; child rows (`project_land`, `project_facilities`,
`community_profiles`), donor link and maintenance entry are created when the row has such cells.
The donor of `parsed.donor` is re-checked at commit time: if it is no longer visible to the caller
(rights or project scope changed since the preview) it is not linked; the name is looked up again
among the visible donors, else a new donor is created.
Updates write **only the cells present in the file** (per field), never touch `record_state`, and
store `import_rows.pre_image`:
```jsonc
{ "projects": { "id": "…", "before": { "capacity": 120 }, "after": { "capacity": 150 } },   // changed columns only (lon/lat for the point)
  "project_land": { "id": "…", "before": {…}, "after": {…} } | { "id": "…", "created": true },
  "project_facilities": …, "community_profiles": …,
  "created": { "project_donors": ["…"], "project_maintenance": ["…"] } }
```
Response: summary + `"committed": true`. When a row fails at commit time nothing is written,
the row becomes `invalid` with a `commit_failed` error and the response is
summary + `{ "committed": false, "failed_row": 17, "error": { "code": "<sqlstate>", "message": "…" } }`
(HTTP 200) — fix or skip the row and commit again. 30 commits / hour.

### `import_rollback(p_batch_id)`
Only for a `committed` batch (owner or hq_admin).
- **Rights are re-checked at rollback time, per record**, with the commit's rule
  (`private.import_can_update`): reviewers of the record's scope (hq_admin: every record), or its
  creator inside the caller's *current* write scope while the record is not approved. The rights the
  importer had at commit time do not carry over. A row whose record the caller may no longer change
  (role removed, record moved to another branch, or — for a collector — record approved since) is
  left as it is: the row stays `applied` and is counted in `kept` **and** in `no_access`. The batch
  still becomes `rolled_back` (such rows cannot be rolled back later by somebody else; hq_admin
  should roll back instead of the owner when that matters).
- Created projects that are still **drafts** are soft-deleted together with their children, and their
  `external_id` is released (so the corrected file can be imported again). Created projects that
  have meanwhile been submitted / approved are **kept** and counted in `kept`.
- Updated rows are restored field by field from the pre-image; a field that somebody changed after
  the import is left alone and counted in `conflicting_fields`. Child rows created by the batch are
  soft-deleted. A target project that has been soft-deleted since the import is not touched (row
  stays `applied`, counted in `kept`). Proposed localities and donors created by the batch are
  soft-deleted when nothing else uses them.

Response: summary (`state: "rolled_back"`) + `{ "rolled_back": true, "reverted": n, "kept": n, "no_access": n, "conflicting_fields": n }`
(`kept` = applied rows left in place for any reason; `no_access` = the part of `kept` due to the
caller's current rights — the UI can suggest asking an administrator).

v2 migration: a v2 JSON file may be sent through `import_stage` with `source_kind: "v2_json"` /
`"v2_local"` after mapping each v2 project to template keys; people and salaries of v2 must go
through the normal sync path (person candidates, no automatic merge).

---

## 6. Photo retention (Edge Function `purge-photos`, service key)

```
photos_to_purge(p_limit int default 500)        -- max 5000
  → [ { id, project_id, bucket: "photos", storage_path_full, storage_path_thumb, deleted_at } ]
mark_photos_purged(p_ids uuid[]) → int           -- rows stamped
```
A photo is returned when `purged_at is null` and either the photo itself or its project was
soft-deleted **more than 90 days ago**; oldest first. After removing both objects from storage the
function calls `mark_photos_purged` (eligibility is re-checked; it sets `purged_at` and, for photos of
deleted projects, `deleted_at`). Loop until `photos_to_purge` returns nothing. Rows are never
hard-deleted.

---

## 7. Private helpers other migrations may use

- `private.require_service_role()` — raises `PT403` unless there is no JWT or its role is `service_role`.
- `private.require_session()` — the session gate above (`PT401` no user, `PT403 session_revoked`);
  not executable by API roles, call it from SECURITY DEFINER code.
- `private.nil_uuid()`, `private.enum_label(enum_key, code, lang)`.
- `private.donor_visible(donor_id, created_by, uid, read_all, read_countries, read_branches)` →
  boolean — the `donors_select` rule for a caller whose read triple is passed in (fetch the triple
  once per call, authz.md §3 b); not executable by API roles.
- `private.enum_labels(enum_key, code, sort_order, ar, sw, en)` — single source of the ar / sw / en
  labels of enumerated values (the web locale files should stay in sync with it).
- `private.dashboard_data(scope_type, scope_id, with_payroll, with_names)` — builder without
  authorisation (never grant it).

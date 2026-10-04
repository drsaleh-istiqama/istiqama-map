# Core schema contract (migrations 0001–0009, hardening 0070)

Reference for every other team. It describes the tables **as created** by
`supabase/migrations/20261003000100 … 000900`. Read this instead of the SQL.
§9 covers `20261003007000_integration_hardening.sql` (schema `private` lock-down, retention
jobs, `server_info()`).

- All tables are in schema `public` unless stated otherwise. Text enumerations are `text` + `CHECK`
  (constraint name `<table>_<column>_ck`, sometimes with a shortened column name:
  `persons_phone_ck`, `project_land_area_ck`, `fx_rates_rate_ck`), never enum types.
- RLS is **enabled and forced** on every table (no policies here → default deny until 0010+),
  including every table of schema `private` (§9.1).
- SECURITY DEFINER code must be owned by a role with `BYPASSRLS` (`postgres` on Supabase),
  otherwise the forced RLS also applies to it.
- pgTAP: `supabase/tests/01_core_schema.test.sql` (triggers of this layer),
  `02_reference_data.test.sql`, `03_normalize.test.sql` (generated, §2.1).

## 1. Standard columns

| Column                     | Type                                            | Notes                                                                                                                                   |
| -------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                       | `uuid` PK, default `private.uuid_v7()`          | a client-supplied id is kept                                                                                                            |
| `created_at`               | `timestamptz not null default now()`            | a supplied value is kept (offline entry time) unless it is more than 5 min in the future                                                |
| `updated_at`               | `timestamptz not null default now()`            | always `now()`                                                                                                                          |
| `created_by`, `updated_by` | `uuid` → `auth.users(id)` (no cascade)          | `auth.uid()` when there is a JWT user; explicit values are kept only when `auth.uid()` is null. `created_by` is immutable for JWT users |
| `version`                  | `integer not null default 1`                    | 1 on insert, `old.version + 1` on **every** update                                                                                      |
| `deleted_at`               | `timestamptz`                                   | soft delete; hard `DELETE` is blocked (§6)                                                                                              |
| `sync_xid`                 | `bigint not null default private.current_xid()` | syncable tables only; set on every insert/update                                                                                        |

**Syncable tables (have `sync_xid` and index `(sync_xid, id)`)**, in pull order:
`countries, admin_areas, branches, option_values, fx_rates, localities, donors, projects,
project_land, project_facilities, project_maintenance, project_photos, project_donors, persons,
project_staff, community_profiles, staff_compensation*, community_sensitive*,
person_merge_requests, sync_conflicts, notifications, map_packs` (* restricted).

Standard columns without `sync_xid`: `profiles, user_roles, devices, export_jobs,
import_batches, import_rows, app_settings`.
No standard columns: `audit_log, sync_applied_ops, restricted_access_log`, `private.*` tables.

## 2. Helper functions (schema `private`, all with pinned `search_path`)

| Function                                                                                 | Returns                                           | Notes                                                                                                     |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `private.current_xid()`                                                                  | `bigint`                                          | `pg_current_xact_id()`; top-level xid even inside sub-transactions. STABLE                                |
| `private.safe_xid()`                                                                     | `bigint`                                          | `pg_snapshot_xmin(pg_current_snapshot())`. STABLE                                                         |
| `private.device_id()`                                                                    | `text`                                            | header `x-device-id` (from `request.headers`), else setting `app.device_id`, else NULL; max 128 chars     |
| `private.f_unaccent(text)`                                                               | `text`                                            | IMMUTABLE wrapper of `extensions.unaccent('extensions.unaccent', $1)`                                     |
| `private.norm(text)`                                                                     | `text`                                            | IMMUTABLE STRICT, see §2.1                                                                                |
| `private.uuid_v7()`                                                                      | `uuid`                                            | VOLATILE                                                                                                  |
| `private.mask_phone(text)`                                                               | `text`                                            | first 4 chars + `•` × (len−7) + last 3; shorter than 8 chars → all `•`. `+255712345678` → `+255••••••678` |
| `private.geom_audit(geometry)`                                                           | `text`                                            | point → EWKT; other → `SRID=4326;MULTIPOLYGON npoints=N md5=…`                                            |
| `private.deepest_admin_area(geometry)`                                                   | `table(id uuid, country_id uuid, level smallint)` | deepest live `admin_areas` row whose `geom` contains the point (`ST_Contains`); 0 rows when none          |
| `private.next_project_code(country_id uuid, admin_area_id uuid)`                         | `text`                                            | consumes the per-country counter; owner only                                                              |
| `private.project_completeness(p public.projects, p_skip_children boolean default false)` | `smallint`                                        | §5; STABLE                                                                                                |
| `private.harden_private_schema()`                                                        | `integer`                                         | §9.1; owner only                                                                                          |
| `private.schema_version()`                                                               | `text`                                            | §9.3; 14-digit prefix of the newest migration, **bump it in every later migration**                       |

### 2.1 `private.norm` — canonical algorithm (mirror it exactly in `normalize.ts`)

Code points are written as `U+XXXX`; in a JS regex they become `\uXXXX` escapes.

0. Unicode **NFC** (`normalize(p, NFC)` / `s.normalize('NFC')`).
1. Remove the characters `U+064B–U+065F`, `U+0670`, `U+06D6–U+06ED` (tashkeel), `U+0640`
   (tatweel) and the invisible format characters `U+200B–U+200F`, `U+202A–U+202E`,
   `U+2066–U+2069`, `U+FEFF`.
2. Strip Latin diacritics: PostgreSQL `unaccent` rules, then remove any remaining combining
   mark `U+0300–U+036F`.
   TS twin: decompose **Latin letters only**, e.g. replace every character in
   `U+00C0–U+024F` and `U+1E00–U+1EFF` by its NFD form without `U+0300–U+036F`, then remove any
   stray `U+0300–U+036F`. Do **not** NFD-normalise the whole string: NFD also splits the Arabic
   letters `ؤ` and `ئ` (waw/yeh with hamza), which this algorithm keeps as they are.
   `unaccent` additionally rewrites a few non-decomposable letters and symbols (`ß→ss`, `æ→ae`,
   `œ→oe`, `ø→o`, `đ→d`, `ł→l`, `ı→i`, `’→'`, `«→<<`); mirror the letter rules if you want and
   keep such characters out of the shared fixture.
3. Lower-case (after step 2 only ASCII letters need it, so the result does not depend on the
   database locale).
4. `أ إ آ → ا`, `ى → ي`, `ة → ه` (U+0623 U+0625 U+0622 → U+0627; U+0649 → U+064A; U+0629 → U+0647).
   Nothing else is folded (`ؤ`, `ئ`, `ء` stay).
5. Replace every run of white space — `U+0009–U+000D`, `U+0020`, `U+0085`, `U+00A0`, `U+1680`,
   `U+2000–U+200A`, `U+2028`, `U+2029`, `U+202F`, `U+205F`, `U+3000` — with one space, then trim.

`norm(NULL)` is NULL, `norm('')` is `''`. Examples:
`"  مَسْجِدُ   النُّور "` → `"مسجد النور"`; `"أحمد إبراهيم آل موسى فاطمة"` → `"احمد ابراهيم ال موسي فاطمه"`;
`"مؤسسة الخير"` → `"مؤسسه الخير"`; `"  Msikiti   wa  ÉCOLE São  Ñandú "` → `"msikiti wa ecole sao nandu"`.

**Shared fixture.** `supabase/tests/fixtures/normalize.json` is an array of
`{ "name", "input", "expected" }` (60 cases; pure ASCII, every other character is a `\uXXXX`
escape). `expected` was produced by `private.norm()` itself, so the file is the truth for both
implementations:

- SQL: `supabase/tests/03_normalize.test.sql` is **generated** from it (one `is()` per case plus
  NULL, function properties and idempotence) — never edit it by hand.
- TypeScript: the unit test of `apps/web/src/lib/normalize.ts` must loop over the same file
  (`expect(norm(c.input)).toBe(c.expected)`, test title `c.name`). Both a plain implementation
  of the steps above and the current `norm()` of the web app pass all 60 cases.

```bash
npx tsx scripts/gen-normalize-test.ts                      # JSON -> 03_normalize.test.sql
npx tsx scripts/gen-normalize-test.ts --check              # CI guard: canonical JSON, SQL not stale
npx tsx scripts/gen-normalize-test.ts --update --db imap_x # recompute "expected" in a database
```

To add a case, append `{ "name": "…", "input": "…", "expected": "" }` and run `--update`.
Keep out of the fixture what is not guaranteed to be the same everywhere:

- characters that `unaccent` rewrites although they have no canonical decomposition. Measured on
  PostgreSQL 17: `ß→ss`, `æ→ae`, `œ→oe`, `Ø ø→o`, `Ð ð→d`, `Þ þ→th`, `đ→d`, `ł→l`, `ı→i`,
  `Ɓ ɓ→b`, `’→'`, `—→-`, `«→<<`, `×→*`, `÷→/`, soft hyphen `U+00AD→-`. These rules come from the
  `unaccent.rules` file of the server and may differ between PostgreSQL major versions (the brief
  allows 15+), so a twin may mirror them (the web app does, for PostgreSQL 17) but the shared
  fixture does not depend on them;
- letters whose lower-casing depends on the database locale (Cyrillic, Greek, … — anything that
  is not ASCII after step 2).

Covered on purpose because they are easy to get wrong in the twin: NFC **before** the removal of
marks (`و` + `U+0654` composes to `ؤ` and is kept; `ا` + `U+0654` composes to `أ` and folds to
`ا`), no NFKC (the ligature `U+FEFB` stays), Farsi `ی`/`ک` are not folded, Arabic-Indic digits
and Arabic punctuation are untouched, `U+200B` is removed rather than turned into a space,
characters outside the BMP survive.

Normalised columns hold **both scripts in one string** (`name_ar name_latin …`). Match a query
with _word_ similarity (`norm(q) <% col`, `word_similarity`, `strict_word_similarity`) or `LIKE`,
not with whole-string `similarity()`, otherwise the other script dilutes the score.

> **Database locale.** pg_trgm only extracts trigrams from Arabic text when the database
> `LC_CTYPE` is UTF-8 aware (Supabase: yes). A database created with `LC_CTYPE = 'C'` silently
> matches nothing in Arabic; create local databases with e.g.
> `create database x encoding 'UTF8' lc_collate 'C' lc_ctype 'en-US' template template0`.
> `private.norm` itself gives the same result under any locale.

## 3. Tables

`std` = standard columns; `S` = plus `sync_xid`. FK columns are `uuid` and reference the named
table's `id` with `NO ACTION`.

### Geography / organisation

**`countries`** (S) — `iso2 char(2) not null unique` (`^[A-Z]{2}$`), `iso3 char(3)` (unique when
not null), `name_ar text not null`, `name_en text not null`, `name_sw text`,
`default_currency char(3)`, `active boolean not null default true`.

**`admin_areas`** (S) — `country_id` → countries (not null), `parent_id` → admin_areas,
`level smallint not null` (1..3), `code text not null`, `short_code text` (`^[A-Z0-9]{2,3}$`),
`name_ar`, `name_en`, `name_sw` (at least one), `geom geometry(MultiPolygon,4326)`,
`geom_simple geometry(MultiPolygon,4326)`.
Unique `(country_id, level, code)` (plain constraint → usable in `ON CONFLICT`).
Indexes: GiST `geom`, `(parent_id)`.
Trigger: parent must be one level above and in the same country (`PT422 admin_area_parent_mismatch`);
level 1 has no parent. `geom_simple` is derived from `geom`
(`ST_SimplifyPreserveTopology`, tolerance 0.005° / 0.002° / 0.0005° for level 1 / 2 / 3) whenever
it is not supplied, and again when `geom` changes without a new `geom_simple`.

**`localities`** (S) — `country_id` → countries (not null), `admin_area_id` → admin_areas,
`name_ar`, `name_latin` (at least one), `name_norm text not null` (trigger:
`norm(name_ar ‖ ' ' ‖ name_latin)`), `geom geometry(Point,4326)`,
`status text not null default 'proposed'` (`proposed|approved`), `approved_by` → auth.users,
`approved_at timestamptz`.
Indexes: GIN trgm `name_norm`, GiST `geom`, `(admin_area_id)`, `(country_id, status)`.
Trigger: same location rule as projects (§4.1); `approved_at/approved_by` stamped when `status`
becomes `approved`. Renaming a locality refreshes `projects.search_norm` of its projects.

**`branches`** (S) — `country_id` → countries (not null), `code text not null`,
`name_ar text not null`, `name_en`, `name_sw`, `admin_area_ids uuid[] not null default '{}'`,
`active boolean not null default true`. Unique `(country_id, code)`.

### Projects

**`projects`** (S)

| Column                       | Type                               | Notes                                                                                                                                |
| ---------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `code`                       | `text`                             | server-generated, unique when not null, immutable (§4.2)                                                                             |
| `external_id`                | `text`                             | import key, unique when not null                                                                                                     |
| `name_ar`                    | `text not null`                    | non-blank                                                                                                                            |
| `name_latin`                 | `text`                             |                                                                                                                                      |
| `type`                       | `text not null`                    | `mosque                                                                                                                              | school      | combined` |
| `status`                     | `text not null default 'active'`   | `active                                                                                                                              | maintenance | building  | inactive` |
| `capacity`                   | `integer`                          | ≥ 0                                                                                                                                  |
| `geom`                       | `geometry(Point,4326)`             | valid lon/lat; **required unless `record_state = 'draft'`** (`projects_geom_required_ck`)                                            |
| `gps_accuracy_m`             | `real`                             | ≥ 0                                                                                                                                  |
| `location_source`            | `text`                             | `gps                                                                                                                                 | map         | import`   |
| `country_id`                 | `uuid not null` → countries        | from `geom` (§4.1)                                                                                                                   |
| `admin_area_id`              | `uuid` → admin_areas               | from `geom` (§4.1)                                                                                                                   |
| `locality_id`                | `uuid` → localities                |                                                                                                                                      |
| `branch_id`                  | `uuid` → branches                  | not derived; set by the writer                                                                                                       |
| `builder`                    | `text`                             |                                                                                                                                      |
| `build_year`                 | `smallint`                         | 1800..2200; filled from `build_date` when missing                                                                                    |
| `build_date`                 | `date`                             | optional                                                                                                                             |
| `record_state`               | `text not null default 'draft'`    | `draft                                                                                                                               | submitted   | approved  | returned` |
| `review_note`                | `text`                             | reviewer field (sync_push ignores it from non-reviewers)                                                                             |
| `migration_note`             | `text`                             | ≤ 2000 chars; client-writable flag of the v2 migration (OWNER_DECISIONS item أ), cleared by a reviewer once checked (migration 0073) |
| `reviewed_by`, `reviewed_at` | `uuid` → auth.users, `timestamptz` | stamped by trigger when `record_state` changes to `approved`/`returned`                                                              |
| `completeness`               | `smallint not null default 0`      | 0..100, always overwritten by trigger (§5)                                                                                           |
| `search_norm`                | `text not null default ''`         | always overwritten by trigger (§4.3)                                                                                                 |
| `import_batch_id`            | `uuid` → import_batches            |                                                                                                                                      |

Indexes: GiST `geom`; GIN trgm on `name_ar`, `name_latin`, `search_norm`;
`(country_id, status, type)`; `(branch_id)`; `(admin_area_id)`; `(locality_id)`; `(created_by)`;
`(import_batch_id)`; review queue `(branch_id, country_id, updated_at) where record_state =
'submitted' and deleted_at is null`; sync cursors `(sync_xid, id)`, `(country_id, sync_xid, id)`,
`(branch_id, sync_xid, id)`.

**`project_land`** (S, 1:1) — `project_id` → projects (not null), `ownership text`
(`association|waqf|person|government|other`), `owner_name text`, `area_m2 numeric(14,2)` ≥ 0,
`utilization_pct numeric(5,2)` 0..100, `expandable boolean`, `notes text`.
`owner_name` is **people data** whatever `ownership` says: with `ownership = 'person'` it is a
private individual's name, and a `viewer` sees no names of persons (brief §3). The row is a
public child (every reader of the project gets it), but `owner_name` must not reach a caller
without people scope on the project: no column privilege for direct SELECT, `null` on the wire
of `sync_pull`, key absent from `report_project`, export column class `people`. This layer does
not enforce it; the RLS/grants, sync and report/export layers do (authz.md §5, sync.md §5.4,
reports-import-export.md).

**`project_facilities`** (S, 1:1) — `project_id`, `teacher_housing`, `imam_housing`,
`guest_housing`, `library`, `hall` (`boolean`, nullable = unknown), `quran_count`, `quran_need`,
`hall_capacity` (`integer` ≥ 0), `student_transport text` (`available|needed|not_needed`),
`students_origin text` (`nearby|mixed|distant`).

**`project_maintenance`** (S, 1:n) — `project_id`, `reported_on date not null default
current_date`, `description text not null`, `priority text not null default 'medium'`
(`low|medium|high|urgent`), `estimated_cost numeric(14,2)` ≥ 0, `currency char(3)`,
`state text not null default 'open'` (`open|in_progress|done|cancelled`), `resolved_on date`.

**`project_photos`** (S, 1:n) — `project_id`, `storage_path_full text not null`,
`storage_path_thumb text not null`, `taken_at timestamptz`, `width`, `height`, `bytes`
(`integer`), `is_cover boolean not null default false`, `category text not null default
'unspecified'` (`unspecified|mosque_front|mosque_inside|school_front|school_inside|land|
facilities|maintenance|other`), `caption text`, `upload_state text not null default 'pending'`
(`pending|uploaded`), `purged_at timestamptz`. Rules in §4.4.

**`donors`** (S) — `name_ar`, `name_latin` (at least one), `name_norm text not null` (trigger),
`notes text`. GIN trgm on `name_norm`.

**`project_donors`** (S) — `project_id`, `donor_id` → donors (both not null),
`amount numeric(14,2)` ≥ 0, `currency char(3)`, `year smallint`.
Unique live `(project_id, donor_id, coalesce(year, 0))`.

1:1 children (`project_land`, `project_facilities`, `community_profiles`, `community_sensitive`)
have a **partial unique index `(project_id) where deleted_at is null`**: a second live row for the
same project fails with 23505 — update the existing row (or soft-delete it first).
Every child also has a plain index on `project_id`.

### People

**`persons`** (S) — `name_ar`, `name_latin` (at least one), `name_normalized text not null`
(trigger, GIN trgm), `phone_e164 text` (`^\+[1-9][0-9]{6,14}$`, indexed), `gender text`
(`male|female`), `birth_year smallint` (1900..2100, filled from `birth_date`), `birth_date date`,
`home_admin_area_id` → admin_areas, `home_area_text text`, `education_level text`,
`graduated_from text`, `country_id` → countries, `branch_id` → branches (scope),
`merged_into_id` → persons.
Sync cursors `(sync_xid, id)`, `(country_id, sync_xid, id)`, `(branch_id, sync_xid, id)`.

**`person_merge_requests`** (S) — `source_person_id`, `target_person_id` → persons (not null,
different), `state text not null default 'pending'` (`pending|merged|rejected|reverted`),
`reason text`, `decided_by` → auth.users, `decided_at timestamptz`, `undo jsonb`.

**`project_staff`** (S) — `project_id`, `person_id` (not null), `role text not null`
(`imam|teacher|agent|administrator|manager|other`), `start_date date`, `end_date date`
(≥ `start_date`). Indexes `(project_id)`, `(person_id)`.

**`staff_compensation`** (S, RESTRICTED) — `project_staff_id` → project_staff (not null),
`monthly_amount numeric(14,2) not null` ≥ 0, `currency char(3) not null`
(`^[A-Z]{3}$`, constraint `staff_compensation_currency_format_ck`, and a **managed** code —
`private.currency_is_managed`, triggers `staff_compensation_currency_tg` (update of a live row)
and `staff_compensation_currency_ins_tg` (every insert, soft-deleted too, so that the blind-write
probe row is checked — migration 0075), migration 0072: one of
the brief's `TZS|KES|UGX|RWF|BIF|MZN|OMR|USD`, **or** some country's `default_currency`, **or**
a currency with a live `fx_rates` row — so a country added from the admin console pays
salaries in its own currency without a migration, brief §0. An unmanaged code fails with
SQLSTATE 23514 and constraint name `staff_compensation_currency_ck`, exactly as the former
CHECK did. Only inserts and currency changes of live rows are checked: a row whose currency
later leaves the list stays editable and deletable. Clients should offer the union of
`countries.default_currency` and live `fx_rates.currency` (both synced) plus `USD`),
`effective_from date not null default current_date`.
Unique live `(project_staff_id, effective_from)`.

**`fx_rates`** (S) — `currency char(3) not null`, `usd_per_unit numeric(20,10) not null` > 0,
`effective_date date not null default current_date`. Unique `(currency, effective_date)`.

### Community

**`option_values`** (S) — `list_key text not null` (`daawa_activities|social_features|livelihoods|
religious_issues|religious_challenges|social_challenges|proposed_activities`), `code text not
null`, `name_ar text not null`, `name_en`, `name_sw`, `sort_order integer not null default 0`,
`active boolean not null default true`. Unique `(list_key, code)`.

**`community_profiles`** (S, 1:1) — `project_id`, `branch_name text`, `population integer` ≥ 0,
`muslim_pct numeric(5,2)` 0..100, and for each list key `K` above: `K uuid[] not null default
'{}'` + `K_other text`. Trigger: every id must exist in `option_values` with `list_key = K`
(inactive/soft-deleted options stay valid) else `PT422 invalid_option_value`.

**`community_sensitive`** (S, RESTRICTED, 1:1) — `project_id`, `ibadi_families`,
`omani_families` (`integer` ≥ 0), `omani_student_pct`, `ibadi_student_pct`, `omani_teacher_pct`,
`ibadi_teacher_pct` (`numeric(5,2)` 0..100), `guest_financial_capacity text`
(`good|limited|none`).

### Governance / operations

**`profiles`** (std; `id` = `auth.users.id`, no default) — `full_name text`, `phone text`,
`preferred_language text not null default 'ar'` (`ar|sw|en`), `active boolean not null default
true`, `sessions_revoked_at timestamptz`. No trigger creates profiles automatically.

**`user_roles`** (std) — `user_id` → auth.users (not null), `role text not null`
(`field_collector|branch_supervisor|country_manager|hq_admin|viewer`), `scope_type text not null`
(`global|country|branch`), `scope_id uuid` (NULL iff global; must be a `countries.id` /
`branches.id`, else `PT422 invalid_scope`). `hq_admin` must be `global`.
Unique live `(user_id, role, scope_type, scope_id)` with NULLs not distinct.

**`devices`** (std) — `user_id` → auth.users (not null), `device_id text not null` (≤ 128),
`label`, `user_agent`, `last_seen_at`, `last_push_at`, `last_pull_at` (`timestamptz`),
`pending_ops integer not null default 0`, `pending_photos integer not null default 0`,
`app_version text`, `revoked_at timestamptz`. Unique `(user_id, device_id)`.

**`audit_log`** (append-only) — `id bigint identity` PK, `created_at timestamptz`,
`table_name text`, `row_id uuid`, `op text` (`INSERT|UPDATE|DELETE`), `old_data jsonb`,
`new_data jsonb`, `changed_fields text[]`, `row_version integer`, `user_id uuid`,
`device_id text`. Index `(table_name, row_id, row_version)`, BRIN `created_at`. See §7.

**`sync_conflicts`** (S) — `table_name text not null`, `row_id uuid not null`, `project_id` →
projects, `field text not null`, `base_version integer`, `server_value jsonb`,
`client_value jsonb`, `client_user_id` → auth.users, `client_device_id text`,
`client_op_id uuid`, `state text not null default 'open'`
(`open|resolved_server|resolved_client`), `resolved_by` → auth.users, `resolved_at timestamptz`.

**`sync_applied_ops`** — `op_id uuid` PK, `user_id` → auth.users (not null), `device_id text`,
`result jsonb not null`, `applied_at timestamptz not null default now()`.

**`restricted_access_log`** (append-only) — `id bigint identity` PK, `accessed_at timestamptz
not null default now()`, `user_id uuid`, `device_id text`, `table_name text not null`
(`staff_compensation|community_sensitive`), `row_ids uuid[] not null default '{}'`,
`row_count integer not null default 0`, `context text`. GIN on `row_ids`.

**`export_jobs`** (std) — `user_id` → auth.users (not null), `format text not null`
(`csv|xlsx`), `lang text not null default 'ar'` (`ar|sw|en`), `filters jsonb not null default
'{}'`, `state text not null default 'queued'` (`queued|running|done|failed|cancelled|expired`),
`storage_path text`, `file_name text`, `bytes bigint`, `row_count integer`, `"cursor" jsonb`
(quote it), `stats jsonb not null default '{}'`, `error jsonb`, `attempts integer not null
default 0`, `started_at`, `finished_at`, `expires_at` (`timestamptz`).

**`notifications`** (S) — `user_id` → auth.users (recipient, not null), `kind text not null`
(`^[a-z][a-z0-9_.]*$`, e.g. `export.ready`), `payload jsonb not null default '{}'`,
`read_at timestamptz`. The client renders the text from `kind` + `payload`.
Indexes `(user_id, created_at desc)`, `(user_id, sync_xid, id)`.

**`import_batches`** (std) — `user_id` → auth.users (not null), `source_kind text not null
default 'csv'` (`csv|xlsx|v2_json|v2_local`), `file_name`, `storage_path`, `country_id` →
countries, `branch_id` → branches, `state text not null default 'staged'`
(`staged|validated|committing|committed|rolling_back|rolled_back|failed`), `meta jsonb not null
default '{}'`, `stats jsonb not null default '{}'`, `errors jsonb not null default '[]'`,
`row_count integer not null default 0`, `committed_at`, `committed_by`, `rolled_back_at`,
`rolled_back_by`.

**`import_rows`** (std, not audited) — `batch_id` → import_batches (not null),
`row_no integer not null` (≥ 1, unique per batch), `external_id text`, `raw jsonb not null
default '{}'`, `parsed jsonb`, `state text not null default 'staged'`
(`staged|valid|invalid|duplicate|applied|skipped|failed|reverted`), `action text`
(`create|update|skip`), `errors jsonb not null default '[]'`, `warnings jsonb not null default
'[]'`, `duplicate_of` → projects, `target_table text not null default 'projects'`,
`target_id uuid`, `pre_image jsonb` (rows as they were before the commit; NULL when created),
`applied_at timestamptz`.

**`map_packs`** (S) — `code text not null unique`, `name_ar text not null`, `name_en`,
`name_sw`, `country_id` → countries, `admin_area_id` → admin_areas, `storage_path text not
null` (bucket `tiles`), `bytes bigint not null default 0`, `min_zoom`, `max_zoom` (`smallint`
0..22), `min_lon`, `min_lat`, `max_lon`, `max_lat` (`double precision`, all or none),
`tiles_version text`, `sha256 text`, `active boolean not null default true`.

**`app_settings`** (std) — `key text not null unique` (`^[a-z][a-z0-9_.]*$`), `value jsonb not
null default 'null'`, `description text`, `is_public boolean not null default false`.

**`private.rate_limit_buckets`** (unlogged) — `user_id uuid`, `bucket_key text`,
`window_start timestamptz`, `hits integer not null default 0`, `expires_at timestamptz not
null`; PK `(user_id, bucket_key, window_start)`; index `(expires_at)`.

**`private.project_code_counters`** — `country_id uuid` PK → countries, `last_value bigint not
null default 0`, `updated_at timestamptz`.

## 4. Derived data on `projects` and `project_photos`

All derived columns are (re)computed by BEFORE triggers; values sent by a client are ignored.

### 4.1 Location → `country_id` / `admin_area_id` (decision D5)

On insert, and on update when `geom`, `admin_area_id` or `country_id` changed (and `geom` is not
null): the deepest live `admin_areas` polygon containing the point (`ST_Contains`, level 3 > 2 >

1. sets **both** `admin_area_id` and `country_id`. When no polygon contains the point the
   writer's values are kept, and a non-null `admin_area_id` then decides `country_id`.
   `country_id` is `NOT NULL`: a row whose country can be neither derived nor supplied fails (23502).
   `localities` follow the same rule.

### 4.2 `code`

Generated when `code` is null and `country_id` is known (normally on insert):
`<countries.iso2>-<short_code of the level-1 ancestor of admin_area_id, or XX>-<n>` where `n` is
the per-country counter left-padded to 6 digits (`TZ-PN-000123`, `KE-XX-000007`). The counter row
is locked until the transaction ends, so concurrent inserts for one country queue; numbers of
rolled-back transactions are reused (no gaps from failed ops). `INSERT … ON CONFLICT DO UPDATE`
on an existing project still consumes a number (the BEFORE INSERT trigger runs first), so prefer
a plain `UPDATE` for existing rows. Once set the code never changes.
A caller with a JWT user can never supply a code (it is discarded); server-side code without a
JWT user may supply one on insert.

### 4.3 `search_norm`

`norm(concat_ws(' ', name_ar, name_latin, code, locality.name_ar, locality.name_latin))`.

### 4.4 `project_photos` rules

- Max **10 live** photos per project → `PT422 photo_limit_exceeded` (the parent project row is
  locked `FOR NO KEY UPDATE` while counting, so concurrent uploads cannot exceed the limit).
- At most one live cover (partial unique index). Inserting/updating a live row with
  `is_cover = true` clears the previous cover (that row gets a new `version`/`sync_xid`).
  A soft-deleted photo always has `is_cover = false`. No cover is promoted automatically.
- `project_id` is immutable → `PT422 photo_project_immutable`.
- Paths: `storage_path_full` must match
  `^projects/[A-Z]{2}/<project_id>/<id>_full\.(webp|jpg|jpeg)$` (same with `_thumb`) —
  CHECK constraints `project_photos_path_full_ck` / `_thumb_ck`. When NULL on insert the trigger
  fills `projects/{iso2 of the project's country}/{project_id}/{id}_{full|thumb}.webp`.

## 5. Completeness formula (`projects.completeness`, 0..100)

Sum of the weights whose condition holds. "live" = `deleted_at is null`.

| Key          | Weight | Condition                                                   |
| ------------ | -----: | ----------------------------------------------------------- |
| `name_ar`    |     10 | `name_ar` not blank after trim                              |
| `name_latin` |      5 | `name_latin` not blank after trim                           |
| `location`   |     15 | `geom` (lon/lat) present                                    |
| `admin_area` |      5 | `admin_area_id` not null                                    |
| `capacity`   |      5 | `capacity > 0`                                              |
| `build_year` |      5 | `build_year` not null                                       |
| `photos`     |     15 | at least one live `project_photos` row (any `upload_state`) |
| `land`       |     10 | a live `project_land` row exists                            |
| `facilities` |     10 | a live `project_facilities` row exists                      |
| `staff`      |     10 | at least one live `project_staff` row                       |
| `community`  |     10 | a live `community_profiles` row exists                      |

Restricted tables are not part of the score. It is recomputed on every insert/update of the
project and, through statement-level triggers on the five child tables, whenever a child row is
inserted, soft-deleted, restored or hard-deleted. The project row is only written (new `version`,
`sync_xid`, audit row with `changed_fields = {completeness}`) when the score actually changes.

## 6. Hard delete, truncate, append-only

- Every public table has `t00_no_hard_delete` / `t00_no_truncate` (statement level): `DELETE` and
  `TRUNCATE` raise **`PT403 hard_delete_forbidden`** when `current_user` is `anon`,
  `authenticated`, `service_role` or `authenticator`, **or** when the request JWT role is `anon` /
  `authenticated` (so SECURITY DEFINER code acting for an end user — `sync_push`, import
  rollback, merges — cannot hard-delete either; soft-delete instead).
  Allowed: sessions without an end-user JWT running as the owner (migrations, cron, SECURITY
  DEFINER maintenance functions called with the service-role key, pgTAP before `tests.login_as`).
- `audit_log` and `restricted_access_log` additionally reject every `UPDATE`, `DELETE`, `TRUNCATE`
  from anyone (`PT403 append_only_table`); retention needs `alter table … disable trigger
t01_append_only` by the owner.
- Tables in `private` carry no such triggers.

## 7. Triggers and the audit log

| Trigger                                       | Timing                              | Tables                                                                                                               |
| --------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `t00_no_hard_delete`, `t00_no_truncate`       | BEFORE statement                    | all public tables                                                                                                    |
| `t01_append_only`, `t01_append_only_truncate` | BEFORE statement                    | `audit_log`, `restricted_access_log`                                                                                 |
| `t10_std`                                     | BEFORE INSERT/UPDATE row            | all tables with standard columns                                                                                     |
| `t20_derive` / `t20_validate` / `t20_rules`   | BEFORE INSERT/UPDATE row            | `admin_areas`, `localities`, `persons`, `donors`, `projects` / `user_roles`, `community_profiles` / `project_photos` |
| `t80_projects_search`                         | AFTER UPDATE row (names changed)    | `localities`                                                                                                         |
| `t80_completeness_ins/_upd/_del`              | AFTER statement (transition tables) | `project_photos`, `project_land`, `project_facilities`, `project_staff`, `community_profiles`                        |
| `t90_audit`                                   | AFTER INSERT/UPDATE/DELETE row      | all tables with standard columns except `import_rows`                                                                |

`audit_log` rows:

```jsonc
{ "table_name": "projects", "row_id": "<uuid>", "op": "INSERT" | "UPDATE" | "DELETE",
  "old_data": { /* whole row before; null for INSERT */ },
  "new_data": { /* whole row after;  null for DELETE */ },
  "changed_fields": ["name_ar", "search_norm"],   // UPDATE only; null for INSERT/DELETE
  "row_version": 4,                               // version after the change (before, for DELETE)
  "user_id": "<auth.uid() or the row's updated_by>", "device_id": "<private.device_id()>",
  "created_at": "…" }
```

- `changed_fields` never contains `updated_at`, `updated_by`, `version`, `sync_xid`; it can
  contain derived columns (`completeness`, `search_norm`, `name_norm`, `name_normalized`).
- An UPDATE that changes nothing else writes **no** audit row (but still bumps `version`).
  For `devices` the heartbeat columns (`last_seen_at`, `last_push_at`, `last_pull_at`,
  `pending_ops`, `pending_photos`, `app_version`, `user_agent`) are ignored as well.
- Geometry in `old_data`/`new_data`: `geom` of projects/localities is EWKT
  (`SRID=4326;POINT(39.7 -5)`); `geom`/`geom_simple` of admin_areas is a digest string.

Bulk loaders (load-test seed) that must skip auditing can run, as the table owner,
`alter table … disable trigger t90_audit` and re-enable it afterwards. Do **not** use
`session_replication_role = replica`: it would also skip `t10_std` and the derived columns.
Measured cost with every trigger on (PostgreSQL 17, laptop): ≈ 0.3 ms per inserted project,
≈ 0.15 ms per person, ≈ 0.2–0.4 ms per photo; a project update ≈ 0.3 ms (it rewrites all index
entries because `sync_xid` changes on every write).

Trigger functions that look rows up are declared with `set enable_seqscan = off`, so the plans
PL/pgSQL caches while a table is still empty (first rows of a bulk load) stay index scans.

## 8. Error codes raised by this layer

| SQLSTATE          | MESSAGE                          | When                                                                                                                                                                                        |
| ----------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PT403`           | `hard_delete_forbidden`          | DELETE/TRUNCATE by or for an API user                                                                                                                                                       |
| `PT403`           | `append_only_table`              | UPDATE/DELETE/TRUNCATE on a log table                                                                                                                                                       |
| `PT422`           | `photo_limit_exceeded`           | 11th live photo                                                                                                                                                                             |
| `PT422`           | `photo_project_immutable`        | `project_photos.project_id` changed                                                                                                                                                         |
| `PT422`           | `invalid_option_value`           | community option id not in the right list                                                                                                                                                   |
| `PT422`           | `invalid_scope`                  | `user_roles.scope_id` is not a country/branch                                                                                                                                               |
| `PT422`           | `admin_area_parent_mismatch`     | wrong parent level/country                                                                                                                                                                  |
| `23514`           | constraint `<table>_<column>_ck` | enumerations, ranges, paths, `projects_geom_required_ck`                                                                                                                                    |
| `23505`           | index/constraint name            | `projects_code_key`, `projects_external_id_key`, `<table>_project_live_key`, `project_photos_cover_key`, `project_donors_live_key`, `staff_compensation_live_key`, `user_roles_live_key`, … |
| `23502` / `23503` | —                                | missing required value / unknown reference                                                                                                                                                  |

BEFORE triggers run before the CHECK constraints: a level-1 `admin_areas` row with a parent fails
with `PT422 admin_area_parent_mismatch` (not with `admin_areas_parent_ck`). When several CHECKs
fail at once PostgreSQL reports the first one by constraint name.

## 9. Integration hardening (migration 0070)

### 9.1 Schema `private` is closed twice

Every table of schema `private` has RLS **enabled and forced** and **no policy**; `public`,
`anon` and `authenticated` hold no privilege on any table, view, materialized view or sequence
of the schema. The tables are reachable only by SECURITY DEFINER code, whose owner bypasses RLS
(`postgres` has `BYPASSRLS` on Supabase; the superuser locally). A privilege granted by mistake
therefore still shows no row.

```sql
private.harden_private_schema() returns integer   -- owner only, idempotent
```

walks `pg_class`, enables + forces RLS on every table of the schema, revokes everything from
`public, anon, authenticated` on every relation and returns the number of RLS switches it had
to turn on (0 = nothing to do). It refuses to force RLS on a table whose owner has neither
`SUPERUSER` nor `BYPASSRLS` (the SECURITY DEFINER functions would silently read empty tables).

**Adding a table to schema `private`:** either write `enable` + `force row level security` and
the `revoke` yourself, or end the migration with `select private.harden_private_schema();`.
pgTAP file 16 fails while a table of the schema is not hardened or the schema has a policy.
Materialized views cannot have RLS; they rely on the missing privileges.

### 9.2 Scheduled jobs (pg_cron)

| Job                                | Schedule (UTC)   | Command                                                                                | Migration |
| ---------------------------------- | ---------------- | -------------------------------------------------------------------------------------- | --------- |
| `istiqama-refresh-reports`         | every 15 min     | `select public.refresh_reports()`                                                      | 0058      |
| `istiqama-rate-limit-cleanup`      | hourly, minute 7 | `select private.rate_limit_cleanup()`                                                  | 0058      |
| `istiqama-expire-exports`          | daily 02:23      | `select private.expire_export_jobs()`                                                  | 0058      |
| `istiqama-sync-prune`              | daily 02:41      | `select private.sync_prune()` — ledger `sync_applied_ops` and scope-move log, 180 days | 0070      |
| `istiqama-sync-rejections-cleanup` | daily 02:53      | `select private.sync_rejections_cleanup()` — rejected-operation log, 30 days           | 0070      |

All are scheduled only when `pg_cron` can be enabled; otherwise the migrations print a notice
and do nothing. The jobs run as the role that applied the migration, without an end-user JWT
(required by the hard-delete guard, §6). The local gateway timers only cover
`refresh_reports()` and the photo purge: on a stack without `pg_cron` the retention functions
have to be called by an external scheduler over a database connection (schema `private` is not
exposed through the REST API; EXECUTE is granted to the owner and `service_role` only). The
90-day photo purge needs object storage and stays in the `purge-photos` Edge Function.

### 9.3 `public.server_info()` → jsonb

For the diagnostics / "about" screen. `STABLE`, `SECURITY DEFINER`, EXECUTE for `authenticated`
and `service_role` (not `anon`); no further authorisation, no rate limit, never raises.

```jsonc
{
  "app_environment": "staging", // app_settings 'app.environment' when it is a non-empty JSON
  // string, else "production" (reference-data.md §5)
  "schema_version": "20261003007000", // 14-digit prefix of the newest migration, as text
  "server_time": "2026-10-03T15:43:38.093651+00:00", // clock_timestamp()
  "postgis_version": "3.6.2",
} // postgis_lib_version()
```

`schema_version` is the greater of `private.schema_version()` (a constant, **to be bumped by
every later migration** with `create or replace function private.schema_version() …`) and the
newest 14-digit `version` in `supabase_migrations.schema_migrations`. That table exists wherever
the Supabase CLI applied the migrations (hosted, self-hosted, CI); the Docker-less local stack
does not record migrations, so there the constant alone is reported.

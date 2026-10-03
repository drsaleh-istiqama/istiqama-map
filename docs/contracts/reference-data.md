# Reference data, staging seed and boundary importer — contract

Owner files: `supabase/migrations/2026100300{6000,6100,6200,6300}_reference_*.sql`,
`supabase/seed.staging.sql`, `scripts/import-boundaries/**`.

| Layer                       | Runs in                                    | Content                                                                  |
| --------------------------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| Migrations 0060–0063        | **every** environment, production included | countries, option lists, FX placeholders, default settings               |
| `scripts/import-boundaries` | every environment, run by an operator      | `admin_areas` ADM1–3, the v2 towns as `localities`, `boundaries.sources` |
| `supabase/seed.staging.sql` | **staging / local only**                   | branches, test users, demo projects (brief §7.8)                         |

All of them are idempotent and never overwrite a row that already exists (administrators
edit reference data from the admin screens; a re-run must not undo that).

## 1. Deterministic ids

```sql
private.ref_uuid(p_key text) returns uuid   -- IMMUTABLE STRICT; migration 0060
```

`md5('istiqama-map:' || key)` laid out as an RFC 9562 **version-3** UUID (version nibble `3`,
variant nibble `8..b`), so strict UUID validators accept it. TypeScript twin:
`refUuid(key)` in `scripts/import-boundaries/ref-uuid.ts` (verified equal to the SQL
function). EXECUTE is revoked from `public`, `anon`, `authenticated`; it is meant for
migrations, the seed and server-side scripts.

| Row          | Key                                              | Example                                                                  |
| ------------ | ------------------------------------------------ | ------------------------------------------------------------------------ |
| country      | `country:<ISO2>`                                 | `country:TZ` → `e2a6484f-39a5-3135-816a-03ad934d99fd`                    |
| option value | `option:<list_key>:<code>`                       | `option:livelihoods:fishing`                                             |
| FX rate      | `fx:<CUR>:<YYYY-MM-DD>`                          | `fx:TZS:2025-01-01`                                                      |
| setting      | `setting:<key>`                                  | `setting:duplicates.radius_m`                                            |
| admin area   | `admin_area:<ISO3>:<level>:<code>`               | `admin_area:TZA:1:36957248B13188202009922`                               |
| v2 locality  | `locality:v2:<ISO2>:<region key>:<locality key>` | `locality:v2:TZ:north-pemba:wete`                                        |
| staging seed | `seed:<kind>:<key>`                              | `seed:branch:PEMBA`, `seed:user:hq.admin@example.org`, `seed:project:01` |

Never look reference rows up by a hard-coded UUID in application code: use the natural key
(`countries.iso2`, `option_values (list_key, code)`, `app_settings.key`). The ids are
deterministic so that data can move between environments, not to be typed into code.

## 2. Countries (migration 0060)

| iso2 | iso3 | name_ar | name_en    | name_sw  | default_currency |
| ---- | ---- | ------- | ---------- | -------- | ---------------- |
| TZ   | TZA  | تنزانيا | Tanzania   | Tanzania | TZS              |
| KE   | KEN  | كينيا   | Kenya      | Kenya    | KES              |
| UG   | UGA  | أوغندا  | Uganda     | Uganda   | UGX              |
| RW   | RWA  | رواندا  | Rwanda     | Rwanda   | RWF              |
| BI   | BDI  | بوروندي | Burundi    | Burundi  | BIF              |
| MZ   | MOZ  | موزمبيق | Mozambique | Msumbiji | MZN              |
| OM   | OMN  | عُمان   | Oman       | Omani    | OMR              |

All `active = true`. Arabic names are exactly the v2 spellings (the v2 migration can match
on them). Tanzania includes Zanzibar and Pemba. The final list is owner decision #3.

## 3. Option lists (migration 0061)

Seven lists, 8 options each in v2 order (`sort_order` 10…80) plus `other` (`sort_order` 990) — 63 rows. `name_ar` equals the v2 label of `reference/v2/src/quick-options.js`
character for character (checked by script), so v2 free-text selections map to option ids by
comparing `private.norm(text)` with `private.norm(name_ar)` inside the list.

| `list_key` (= `community_profiles` column) | v2 key                | codes                                                                                                                                                                                                        |
| ------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `daawa_activities`                         | `daawaActivities`     | `quran_memorization_circles`, `islamic_lessons`, `sermons_lectures`, `daawa_visits`, `youth_activities`, `women_activities`, `training_courses`, `community_aid`, `other`                                    |
| `social_features`                          | `socialFeatures`      | `strong_community_cooperation`, `youth_participation`, `women_participation`, `orphan_care`, `needy_family_support`, `community_volunteering`, `community_councils`, `weak_community_participation`, `other` |
| `livelihoods`                              | `livelihoods`         | `agriculture`, `fishing`, `trade`, `herding`, `government_jobs`, `crafts_trades`, `daily_labour`, `tourism`, `other`                                                                                         |
| `religious_issues`                         | `religiousIssues`     | `weak_islamic_education`, `imam_shortage`, `teacher_shortage`, `weak_quran_memorization`, `low_prayer_attendance`, `wrong_beliefs_practices`, `need_youth_programs`, `need_women_programs`, `other`          |
| `religious_challenges`                     | `religiousChallenges` | `lack_qualified_staff`, `weak_training`, `few_teaching_materials`, `remote_settlements`, `low_attendance`, `multiple_languages`, `sectarian_sensitivities`, `weak_funding`, `other`                          |
| `social_challenges`                        | `socialChallenges`    | `poverty`, `unemployment`, `school_dropout`, `early_marriage`, `drugs`, `poor_transport`, `scattered_population`, `family_problems`, `other`                                                                 |
| `proposed_activities`                      | `proposedActivities`  | `quran_circles`, `teacher_training`, `imam_training`, `public_lectures`, `youth_programs`, `women_programs`, `daawa_caravan`, `social_aid`, `other`                                                          |

Rules for consumers:

- `code` is stable and never shown to users; show `name_<lang>` with fallback
  `name_ar` (always present).
- The option `other` of a list switches on the free-text column
  `community_profiles.<list_key>_other`. A v2 value that matches no label goes there, and
  `other` is added to the array.
- Options are soft-deleted or deactivated (`active = false`), never renamed in meaning;
  profiles keep referencing them (the validation trigger accepts inactive options).
- The form labels of the seven lists themselves are UI strings (locale files), not data.

## 4. Exchange rates (migration 0062) — placeholders

One row per currency dated **2025-01-01**: `USD 1`, `OMR 2.6008` (official peg) and
indicative values for `TZS 0.00038`, `KES 0.0077`, `UGX 0.00027`, `RWF 0.0007`,
`BIF 0.00034`, `MZN 0.0156` (`usd_per_unit` = USD value of one unit).

They are **not official rates**. `app_settings['fx.placeholder'].placeholder = true` marks
them; dashboards and payroll reports should show an "approximate USD figures" notice while
it is true. Finance enters real rates as new rows with a later `effective_date` (reports
take the latest row on or before today) and then sets the flag to false. This is a
question for the owner (official rates and who maintains them) that belongs in
`docs/OWNER_DECISIONS.md`.

## 5. Application settings (migration 0063)

`app_settings.value` is JSON. Public settings (`is_public = true`) are readable by every
signed-in user; the web app should load them once after sign-in, cache them for offline use
and fall back to the same defaults.

| Key                                                                      | Default                                                                                 | Public | Brief |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------ | ----- |
| `duplicates.radius_m`                                                    | `150`                                                                                   | yes    | §7.3  |
| `duplicates.name_similarity`                                             | `0.6`                                                                                   | yes    | §7.3  |
| `persons.name_similarity`                                                | `0.6`                                                                                   | yes    | §2.4  |
| `gps.accuracy_warn_m`                                                    | `30`                                                                                    | yes    | §7.1  |
| `security.pin_lock_minutes`                                              | `15`                                                                                    | yes    | §3    |
| `photos.max_per_project`                                                 | `10`                                                                                    | yes    | §6    |
| `photos.full_max_px` / `photos.thumb_max_px` / `photos.quality`          | `1600` / `400` / `0.8`                                                                  | yes    | §6    |
| `photos.retention_days`                                                  | `90`                                                                                    | no     | §11   |
| `sync.push_batch_size` / `sync.pull_page_size` / `sync.interval_seconds` | `50` / `500` / `120`                                                                    | yes    | §4    |
| `form.autosave_seconds`                                                  | `5`                                                                                     | yes    | §7.4  |
| `list.page_size`                                                         | `50`                                                                                    | yes    | §5    |
| `search.debounce_ms`                                                     | `250`                                                                                   | yes    | §5    |
| `map.local_points_min_zoom`                                              | `14`                                                                                    | yes    | §5    |
| `reports.refresh_minutes`                                                | `15`                                                                                    | no     | §5    |
| `fx.placeholder`                                                         | `{"placeholder": true, "effective_date": "2025-01-01", "currencies": […], "note": "…"}` | yes    | §2.4  |
| `boundaries.sources`                                                     | written by the importer (§7)                                                            | yes    | –     |
| `app.environment`                                                        | `"staging"`, written by the staging seed only                                           | yes    | §7.8  |

**Caveat:** the server functions currently compile the same numbers in as constants
(`project_duplicates` 150 m / 0.6, `person_candidates` 0.6, the photo-limit trigger 10,
photo retention 90 days, report refresh 15 min). Editing one of those settings changes the
client behaviour only, until the owning function reads the setting.

`app.environment`: the web app shows its "demo data" badge only when the value is
`"staging"` (brief §12, permanent badge). Production either has no such row or sets it to
`"production"`, which makes `seed.staging.sql` abort.

## 6. Staging seed (`supabase/seed.staging.sql`)

Never runs in production (safety latch on `app.environment = "production"`; also refuses to
run with an end-user JWT). Runs as the database owner, in any order relative to the
boundary importer.

### 6.1 Test users

Password of every account: **`Passw0rd!dev`** (bcrypt via `extensions.crypt`). E-mails are
confirmed. `auth.users.id = private.ref_uuid('seed:user:<email>')`.

| E-mail                          | Role                | Scope          | Language | Phone (OTP)     |
| ------------------------------- | ------------------- | -------------- | -------- | --------------- |
| `hq.admin@example.org`          | `hq_admin`          | global         | ar       | –               |
| `manager.tz@example.org`        | `country_manager`   | country TZ     | en       | –               |
| `supervisor.pemba@example.org`  | `branch_supervisor` | branch PEMBA   | sw       | –               |
| `collector.pemba@example.org`   | `field_collector`   | branch PEMBA   | sw       | `+255700000001` |
| `collector2.pemba@example.org`  | `field_collector`   | branch PEMBA   | ar       | –               |
| `collector.mombasa@example.org` | `field_collector`   | branch MOMBASA | sw       | `+254700000001` |
| `viewer@example.org`            | `viewer`            | global         | en       | –               |

- `hq_admin` and `country_manager` only take effect at **aal2**: these two accounts must
  enrol a TOTP factor on first sign-in (no factor is seeded).
- `auth.users.phone` is stored GoTrue-style without `+` (`255700000001`); the two numbers
  are the `[auth.sms.test_otp]` numbers of `supabase/config.toml` (code `123456`).
  `profiles.phone` holds the E.164 form.
- Columns used on insert: `id, aud, role, email, encrypted_password, email_confirmed_at,
raw_app_meta_data, raw_user_meta_data, created_at, updated_at`. `instance_id`, the token
  columns (set to `''`, GoTrue cannot scan NULL), `phone`/`phone_confirmed_at` and
  `auth.identities` rows are written only when those columns/tables exist.
- Profile names are generic ("مدير تنزانيا (تجريبي)"); no real person is named.

### 6.2 Branches

`id = private.ref_uuid('seed:branch:<CODE>')`.

| Code       | Country | name_ar     | Level-1 areas in `admin_area_ids`                             |
| ---------- | ------- | ----------- | ------------------------------------------------------------- |
| `PEMBA`    | TZ      | فرع بيمبا   | North Pemba, South Pemba                                      |
| `ZANZIBAR` | TZ      | فرع زنجبار  | Zanzibar Urban/West, Zanzibar North, Zanzibar South & Central |
| `TANGA`    | TZ      | فرع تانغا   | Tanga                                                         |
| `MOMBASA`  | KE      | فرع مومباسا | Mombasa, Kwale, Kilifi                                        |
| `KAMPALA`  | UG      | فرع كمبالا  | Central Region                                                |

Only the areas that exist are stored (with fallback squares: the first one of ZANZIBAR and
MOMBASA).

### 6.3 Fallback admin areas

Created **only for a country without imported boundaries**: level-1 squares with
`code` `FALLBACK-TZ-06` (North Pemba, `PN`), `FALLBACK-TZ-10` (South Pemba, `PS`),
`FALLBACK-TZ-15` (Zanzibar Urban/West, `ZW`), `FALLBACK-TZ-25` (Tanga, `TG`),
`FALLBACK-KE-28` (Mombasa, `MB`), `FALLBACK-UG-C` (Central Region, `CE`). Names and short
codes equal those of the real areas, so project codes are the same either way. The importer
retires them and re-points branches, persons, projects and localities (§7).

### 6.4 Demo data

- 33 projects, `id = private.ref_uuid('seed:project:NN')` (`01`…`33`). `01`–`05` are the v2
  `SAMPLE_PROJECTS` (same names, coordinates, capacity, status, builder "الاستقامة", build
  year, manager names, donor "متبرع كريم", maintenance note of مسجد الهدى), re-mapped to the
  official regions: North Pemba (`TZ-PN-…`), South Pemba (`TZ-PS-…`), Zanzibar Urban/West
  (`TZ-ZW-…`). The rest: Pemba ×12, Zanzibar ×4, Tanga ×5, Mombasa ×4, Kampala ×3.
- States: 25 approved, 5 submitted, 1 returned (with `review_note`), 2 drafts (one without
  a location). Statuses: active ×22, maintenance ×5, building ×4, inactive ×2.
  `created_at` is spread over the last ten weeks (weekly-activity chart).
- 15 `project_land`, 21 `project_facilities`, 8 `project_maintenance` (open, in progress,
  done; one urgent), 23 `persons`, 26 `project_staff` (one teacher in two projects, one
  person with two roles), 23 `staff_compensation` (TZS, KES, UGX), 10
  `community_profiles` (two use `other` + free text), 6 `community_sensitive`, 4 `donors`,
  9 `project_donors`, 12 `localities` (11 approved v2 towns with the importer's ids + 1
  proposed village "Tumbe").
- No `project_photos` (there are no binary objects to point at), devices, conflicts or
  notifications.

## 7. Boundary importer (`scripts/import-boundaries`)

```bash
npm run boundaries:import                       # all active countries, ADM1-3, online
npm run boundaries:import -- --offline --cache-dir .local/downloads/geoboundaries
npm run boundaries:import -- --country TZA --levels 1,2
npm run boundaries:import -- --help
```

Full manual, licences and data caveats: `scripts/import-boundaries/README.md`. Summary of
what other code can rely on:

- `admin_areas.code` = geoBoundaries `shapeID`; `id` = `ref_uuid('admin_area:<ISO3>:<level>:<code>')`;
  `name_en` from the source; `name_ar`/`name_sw` for all level-1 areas of the seven
  countries (from `names.json`), usually null on levels 2–3 → the UI must fall back to
  `name_en`.
- `short_code` (level 1): letters from `names.json` — e.g. `PN`, `PS`, `ZN`, `ZS`, `ZW`,
  `TG`, `DS` (Tanzania), `MB`, `KW`, `KF`, `LM`, `NB` (Kenya), `CE`/`EA`/`NO`/`WE` (Uganda),
  ISO codes for Burundi and Oman. Unique per country, never changed once set.
- `parent_id` is resolved spatially; level 1 has none.
- Importing a level **replaces** that `(country, level)` set: rows missing from the file are
  soft-deleted and references are moved to the replacement. Clients receive the tombstones
  through `sync_pull`.
- After the import, located projects/localities without an area get one (`--relocate
missing`); `--relocate all` re-derives all of them.
- 97 approved `localities` from the v2 location tree (27 TZ, 8 UG, 7 KE, 39 OM, 7 RW, 3 BI,
  6 MZ); two of them (Wingwi, Wambaa) have no coordinates.
- Volumes with gbOpen: 9,776 areas (TZ 3,844 · KE 1,789 · BI 2,752 · MZ 580 · RW 451 · UG
  292 · OM 68); about 15 s on the local stack. A repeated run writes nothing.

## 8. Notes for other teams

- **pgTAP**: run the suite on a database without imported boundaries. The reference
  migrations and the staging seed (fallback squares) do not disturb the fixtures; real
  boundaries do (their wards are deeper than the fixture squares around Pemba, Tanga and
  Mombasa).
- **Local workflow**: `npm run db:reset` (migrations + seed) → `npm run boundaries:import`
  (optional, needs the network once or a filled cache). The demo data ends up on the real
  shapes with the same project codes.
- **Web**: `option_values`, `countries`, `fx_rates` arrive through `sync_pull`;
  `app_settings` is read through PostgREST (`is_public` rows only for non-HQ users).

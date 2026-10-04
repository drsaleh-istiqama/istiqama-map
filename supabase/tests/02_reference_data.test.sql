-- =============================================================================
-- 02  Reference data shipped by migrations 0060-0063
--     (contract: docs/contracts/reference-data.md)
--
--   1. private.ref_uuid()   deterministic version-3 style ids
--   2. countries            7 rows with iso2 / iso3 / currency / three languages
--   3. option_values        7 lists x 9 options = 63, three languages, stable codes
--   4. fx_rates             placeholder rows dated 2025-01-01 + the fx.placeholder flag
--   5. app_settings         defaults of the brief
--
-- Read-only. Meant for a freshly migrated database, with or without
-- supabase/seed.staging.sql (the seed adds the setting app.environment and no
-- reference rows) and with or without imported boundaries (the importer adds
-- the setting boundaries.sources).
-- =============================================================================
begin;
set local search_path = public, extensions, tests;

select plan(41);

-- =============================================================================
-- 1. private.ref_uuid
-- =============================================================================
select is(private.ref_uuid('country:TZ'), 'e2a6484f-39a5-3135-816a-03ad934d99fd'::uuid,
  'ref_uuid: the documented test vector (country:TZ)');
select is(private.ref_uuid('option:livelihoods:fishing'), private.ref_uuid('option:livelihoods:fishing'),
  'ref_uuid: the same key gives the same id');
select isnt(private.ref_uuid('country:TZ'), private.ref_uuid('country:tz'),
  'ref_uuid: keys are case sensitive');
select is_empty(
  $$ select k from unnest(array['country:TZ', 'option:livelihoods:fishing', 'fx:TZS:2025-01-01',
                                'setting:duplicates.radius_m', 'a', '', 'admin_area:TZA:1:x']) as k
     where private.ref_uuid(k)::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' $$,
  'ref_uuid: version nibble 3 and RFC variant nibble for any key');
select is(private.ref_uuid(null), null, 'ref_uuid: NULL in, NULL out');
select is(
  (select p.provolatile::text || '/' || p.proisstrict::text
          || '/' || (exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%'))::text
   from pg_proc p where p.oid = 'private.ref_uuid(text)'::regprocedure),
  'i/true/true',
  'ref_uuid: IMMUTABLE, STRICT, pinned search_path');
select is(
  array[has_function_privilege('anon', 'private.ref_uuid(text)', 'EXECUTE'),
        has_function_privilege('authenticated', 'private.ref_uuid(text)', 'EXECUTE'),
        has_function_privilege('service_role', 'private.ref_uuid(text)', 'EXECUTE')],
  array[false, false, true],
  'ref_uuid: executable by the service role only (not by anon / authenticated)');

-- =============================================================================
-- 2. Countries
-- =============================================================================
select results_eq(
  $$ select iso2::text, iso3::text, default_currency::text, name_en, name_sw, active
     from public.countries where deleted_at is null order by iso2 $$,
  $$ values ('BI', 'BDI', 'BIF', 'Burundi',    'Burundi',  true),
            ('KE', 'KEN', 'KES', 'Kenya',      'Kenya',    true),
            ('MZ', 'MOZ', 'MZN', 'Mozambique', 'Msumbiji', true),
            ('OM', 'OMN', 'OMR', 'Oman',       'Omani',    true),
            ('RW', 'RWA', 'RWF', 'Rwanda',     'Rwanda',   true),
            ('TZ', 'TZA', 'TZS', 'Tanzania',   'Tanzania', true),
            ('UG', 'UGA', 'UGX', 'Uganda',     'Uganda',   true) $$,
  'countries: exactly the seven countries of v2 with iso2, iso3, default currency, English and Swahili names, all active');

-- Arabic names exactly as in v2 (the v2 migration matches on them); Oman carries its damma.
select results_eq(
  $$ select iso2::text, name_ar from public.countries where deleted_at is null order by iso2 $$,
  $$ values ('BI', U&'\0628\0648\0631\0648\0646\062F\064A'),
            ('KE', U&'\0643\064A\0646\064A\0627'),
            ('MZ', U&'\0645\0648\0632\0645\0628\064A\0642'),
            ('OM', U&'\0639\064F\0645\0627\0646'),
            ('RW', U&'\0631\0648\0627\0646\062F\0627'),
            ('TZ', U&'\062A\0646\0632\0627\0646\064A\0627'),
            ('UG', U&'\0623\0648\063A\0646\062F\0627') $$,
  'countries: Arabic names with the v2 spellings');

select is_empty(
  $$ select iso2 from public.countries
     where coalesce(btrim(name_ar), '') = '' or coalesce(btrim(name_en), '') = '' or coalesce(btrim(name_sw), '') = '' $$,
  'countries: all three languages are filled in');
select is_empty(
  $$ select iso2 from public.countries where id is distinct from private.ref_uuid('country:' || iso2) $$,
  'countries: id = ref_uuid(''country:<ISO2>'')');
select is_empty(
  $$ select iso2 from public.countries where iso2 !~ '^[A-Z]{2}$' or iso3 !~ '^[A-Z]{3}$' or default_currency !~ '^[A-Z]{3}$' $$,
  'countries: iso2, iso3 and currency codes are upper-case ISO codes');
select is_empty(
  $$ select c.iso2 from public.countries c
     where not exists (select 1 from public.fx_rates f
                       where f.currency = c.default_currency and f.deleted_at is null and f.effective_date <= current_date) $$,
  'countries: the default currency of every country has an exchange rate in force');
select is(
  (select count(*)::int from public.audit_log a
   where a.table_name = 'countries' and a.op = 'INSERT'
     and a.row_id in (select id from public.countries)),
  7, 'countries: the reference rows went through the audit trigger');

-- =============================================================================
-- 3. Option lists
-- =============================================================================
select is((select count(*)::int from public.option_values where deleted_at is null), 63,
  'option_values: 63 rows');
select results_eq(
  $$ select list_key, array_agg(code order by sort_order), array_agg(sort_order order by sort_order)
     from public.option_values where deleted_at is null group by list_key order by list_key $$,
  $$ values
       ('daawa_activities',
        array['quran_memorization_circles', 'islamic_lessons', 'sermons_lectures', 'daawa_visits',
              'youth_activities', 'women_activities', 'training_courses', 'community_aid', 'other'],
        array[10, 20, 30, 40, 50, 60, 70, 80, 990]),
       ('livelihoods',
        array['agriculture', 'fishing', 'trade', 'herding', 'government_jobs', 'crafts_trades',
              'daily_labour', 'tourism', 'other'],
        array[10, 20, 30, 40, 50, 60, 70, 80, 990]),
       ('proposed_activities',
        array['quran_circles', 'teacher_training', 'imam_training', 'public_lectures', 'youth_programs',
              'women_programs', 'daawa_caravan', 'social_aid', 'other'],
        array[10, 20, 30, 40, 50, 60, 70, 80, 990]),
       ('religious_challenges',
        array['lack_qualified_staff', 'weak_training', 'few_teaching_materials', 'remote_settlements',
              'low_attendance', 'multiple_languages', 'sectarian_sensitivities', 'weak_funding', 'other'],
        array[10, 20, 30, 40, 50, 60, 70, 80, 990]),
       ('religious_issues',
        array['weak_islamic_education', 'imam_shortage', 'teacher_shortage', 'weak_quran_memorization',
              'low_prayer_attendance', 'wrong_beliefs_practices', 'need_youth_programs',
              'need_women_programs', 'other'],
        array[10, 20, 30, 40, 50, 60, 70, 80, 990]),
       ('social_challenges',
        array['poverty', 'unemployment', 'school_dropout', 'early_marriage', 'drugs', 'poor_transport',
              'scattered_population', 'family_problems', 'other'],
        array[10, 20, 30, 40, 50, 60, 70, 80, 990]),
       ('social_features',
        array['strong_community_cooperation', 'youth_participation', 'women_participation', 'orphan_care',
              'needy_family_support', 'community_volunteering', 'community_councils',
              'weak_community_participation', 'other'],
        array[10, 20, 30, 40, 50, 60, 70, 80, 990]) $$,
  'option_values: seven lists, nine stable codes each in v2 order (10..80), "other" last (990)');

select is_empty(
  $$ select list_key, code from public.option_values
     where coalesce(btrim(name_ar), '') = '' or coalesce(btrim(name_en), '') = '' or coalesce(btrim(name_sw), '') = '' $$,
  'option_values: Arabic, English and Swahili labels are all non-empty');
select is_empty(
  $$ select list_key, lang, label
     from (select list_key, 'ar' as lang, name_ar as label from public.option_values
           union all select list_key, 'en', name_en from public.option_values
           union all select list_key, 'sw', name_sw from public.option_values) x
     group by list_key, lang, label having count(*) > 1 $$,
  'option_values: no label is used twice inside a list (per language)');
select is_empty(
  $$ select list_key, code from public.option_values
     where id is distinct from private.ref_uuid('option:' || list_key || ':' || code) $$,
  'option_values: id = ref_uuid(''option:<list_key>:<code>'')');
select is_empty(
  $$ select list_key, code from public.option_values where code !~ '^[a-z][a-z0-9_]*$' $$,
  'option_values: codes are snake_case identifiers');
select is_empty(
  $$ select list_key, code from public.option_values where not active $$,
  'option_values: every shipped option is active');
select is_empty(
  $$ select k.list_key
     from (select distinct list_key from public.option_values) k
     where (select count(*) from information_schema.columns c
            where c.table_schema = 'public' and c.table_name = 'community_profiles'
              and ((c.column_name = k.list_key and c.data_type = 'ARRAY')
                   or (c.column_name = k.list_key || '_other' and c.data_type = 'text'))) <> 2 $$,
  'option_values: every list key is a uuid[] column of community_profiles with its <key>_other text column');
select is(
  (select count(*)::int from public.option_values
   where code = 'other' and sort_order = 990
     and private.norm(name_en) = 'other'),
  7, 'option_values: every list has the option "other" that switches on the free-text column');

-- The validation trigger of community_profiles accepts every shipped option in its own list.
select tests.fixture();
select lives_ok(
  $$ insert into public.community_profiles
       (project_id, daawa_activities, social_features, livelihoods, religious_issues,
        religious_challenges, social_challenges, proposed_activities)
     select tests.id('p_pemba_1'),
            array(select id from public.option_values where list_key = 'daawa_activities' and deleted_at is null),
            array(select id from public.option_values where list_key = 'social_features' and deleted_at is null),
            array(select id from public.option_values where list_key = 'livelihoods' and deleted_at is null),
            array(select id from public.option_values where list_key = 'religious_issues' and deleted_at is null),
            array(select id from public.option_values where list_key = 'religious_challenges' and deleted_at is null),
            array(select id from public.option_values where list_key = 'social_challenges' and deleted_at is null),
            array(select id from public.option_values where list_key = 'proposed_activities' and deleted_at is null) $$,
  'option_values: a community profile can reference all 63 options');

-- =============================================================================
-- 4. Exchange-rate placeholders
-- =============================================================================
select results_eq(
  $$ select currency::text, usd_per_unit, effective_date
     from public.fx_rates where deleted_at is null order by currency $$,
  $$ values ('BIF', 0.00034::numeric(20,10), date '2025-01-01'),
            ('KES', 0.0077::numeric(20,10),  date '2025-01-01'),
            ('MZN', 0.0156::numeric(20,10),  date '2025-01-01'),
            ('OMR', 2.6008::numeric(20,10),  date '2025-01-01'),
            ('RWF', 0.0007::numeric(20,10),  date '2025-01-01'),
            ('TZS', 0.00038::numeric(20,10), date '2025-01-01'),
            ('UGX', 0.00027::numeric(20,10), date '2025-01-01'),
            ('USD', 1::numeric(20,10),       date '2025-01-01') $$,
  'fx_rates: one placeholder row per currency dated 2025-01-01 (USD = 1, OMR = official peg)');
select is_empty(
  $$ select currency from public.fx_rates
     where id is distinct from private.ref_uuid('fx:' || currency || ':' || to_char(effective_date, 'YYYY-MM-DD')) $$,
  'fx_rates: id = ref_uuid(''fx:<CUR>:<YYYY-MM-DD>'')');
select set_eq(
  $$ select currency::text from public.fx_rates where deleted_at is null $$,
  array['TZS', 'KES', 'UGX', 'RWF', 'BIF', 'MZN', 'OMR', 'USD'],
  'fx_rates: every currency allowed for staff_compensation has a rate');
select lives_ok(
  $$ insert into public.staff_compensation (project_staff_id, monthly_amount, currency, effective_from)
     select tests.id('staff:p_pemba_2'), 1, f.currency, date '2001-01-01' + row_number() over (order by f.currency)::int
     from public.fx_rates f where f.deleted_at is null $$,
  'fx_rates: each of these currencies passes the staff_compensation currency check');

select is(
  (select array[jsonb_typeof(value -> 'placeholder'), value ->> 'placeholder', value ->> 'effective_date', is_public::text]
   from public.app_settings where key = 'fx.placeholder' and deleted_at is null),
  array['boolean', 'true', '2025-01-01', 'true'],
  'fx flag: app_settings fx.placeholder is {"placeholder": true, "effective_date": "2025-01-01"} and public');
select set_eq(
  $$ select jsonb_array_elements_text(value -> 'currencies')
     from public.app_settings where key = 'fx.placeholder' and deleted_at is null $$,
  array['TZS', 'KES', 'UGX', 'RWF', 'BIF', 'MZN'],
  'fx flag: lists the six indicative currencies (not USD, not the pegged OMR)');
select is_empty(
  $$ select cur
     from public.app_settings s
     cross join lateral jsonb_array_elements_text(s.value -> 'currencies') as cur
     where s.key = 'fx.placeholder'
       and not exists (select 1 from public.fx_rates f
                       where f.currency = cur and f.effective_date = (s.value ->> 'effective_date')::date
                         and f.deleted_at is null) $$,
  'fx flag: every flagged currency has its placeholder row on the flagged date');
select ok(
  (select nullif(btrim(value ->> 'note'), '') is not null from public.app_settings where key = 'fx.placeholder'),
  'fx flag: carries a note for the administrators');

-- =============================================================================
-- 5. Application settings
-- =============================================================================
select results_eq(
  $$ select key, value, is_public
     from public.app_settings
     where deleted_at is null and key not in ('fx.placeholder', 'app.environment', 'boundaries.sources')
       and key not like 'test.%'
     order by key $$,
  $$ values ('duplicates.name_similarity', '0.6'::jsonb,  true),
            ('duplicates.radius_m',        '150'::jsonb,  true),
            ('form.autosave_seconds',      '5'::jsonb,    true),
            ('gps.accuracy_warn_m',        '30'::jsonb,   true),
            ('list.page_size',             '50'::jsonb,   true),
            ('map.local_points_min_zoom',  '14'::jsonb,   true),
            ('persons.name_similarity',    '0.6'::jsonb,  true),
            ('photos.full_max_px',         '1600'::jsonb, true),
            ('photos.max_per_project',     '10'::jsonb,   true),
            ('photos.quality',             '0.8'::jsonb,  true),
            ('photos.retention_days',      '90'::jsonb,   false),
            ('photos.thumb_max_px',        '400'::jsonb,  true),
            ('reports.refresh_minutes',    '15'::jsonb,   false),
            ('search.debounce_ms',         '250'::jsonb,  true),
            ('security.pin_lock_minutes',  '15'::jsonb,   true),
            ('sync.interval_seconds',      '120'::jsonb,  true),
            ('sync.pull_page_size',        '500'::jsonb,  true),
            ('sync.push_batch_size',       '50'::jsonb,   true) $$,
  'app_settings: the 18 scalar defaults of the brief with their public flag (only retention and report refresh are private)');
select is_empty(
  $$ select key from public.app_settings
     where key not in ('app.environment', 'boundaries.sources') and key not like 'test.%'
       and id is distinct from private.ref_uuid('setting:' || key) $$,
  'app_settings: id = ref_uuid(''setting:<key>'')');
select is_empty(
  $$ select key from public.app_settings
     where key not in ('fx.placeholder', 'app.environment', 'boundaries.sources') and key not like 'test.%'
       and jsonb_typeof(value) <> 'number' $$,
  'app_settings: the scalar defaults are JSON numbers');
select is_empty(
  $$ select key from public.app_settings
     where key not in ('app.environment', 'boundaries.sources') and key not like 'test.%'
       and coalesce(btrim(description), '') = '' $$,
  'app_settings: every default has a description');
select is(
  (select coalesce(max(s.value #>> '{}'), 'absent')
   from public.app_settings s where s.key = 'app.environment' and s.deleted_at is null) in ('absent', 'staging'),
  true,
  'app_settings: app.environment is absent (migrations only) or "staging" (staging seed), never set by a migration');

-- Settings that mirror a constant compiled into the server (reference-data.md section 5, caveat).
select is((select (value #>> '{}')::int from public.app_settings where key = 'photos.max_per_project'), 10,
  'app_settings: photos.max_per_project equals the limit enforced by the photo trigger (file 01)');
select is(
  (select (value #>> '{}')::int from public.app_settings where key = 'sync.pull_page_size'),
  substring(pg_get_function_arguments('public.sync_pull(jsonb, integer)'::regprocedure)
            from 'p_limit integer DEFAULT ([0-9]+)')::int,
  'app_settings: sync.pull_page_size equals the default p_limit of sync_pull()');

-- Reference rows are visible to a signed-in user according to their policies.
select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select is(
  array[(select count(*)::int from public.countries),
        (select count(*)::int from public.option_values),
        (select count(*)::int from public.fx_rates)],
  array[7, 63, 8],
  'a field collector reads all countries, option values and exchange rates');
select is_empty(
  $$ select key from public.app_settings where not is_public $$,
  'a field collector sees public settings only');
select tests.logout();

select * from finish();
rollback;

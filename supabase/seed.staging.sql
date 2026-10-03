-- =============================================================================
--  !!!  STAGING / LOCAL DEVELOPMENT ONLY  —  NEVER RUN THIS FILE IN PRODUCTION  !!!
--
--  Demo branches, test accounts with a PUBLICLY DOCUMENTED password and invented
--  projects. Production starts empty (brief section 7.8): it receives the
--  migrations only (reference data lives in migrations 0060-0063).
--
--  Loaded by:   npm run db:reset            (local stack, after the migrations)
--               supabase db reset / start   (CI and Docker developers, config.toml [db.seed])
--
--  Contents (contract: docs/contracts/reference-data.md, section 6):
--    1. safety latch + app_settings 'app.environment' = "staging"
--    2. fallback square admin areas  (only for countries WITHOUT imported boundaries)
--    3. branches                     PEMBA, ZANZIBAR, TANGA (TZ), MOMBASA (KE), KAMPALA (UG)
--    4. test users                   auth.users + profiles + user_roles, password "Passw0rd!dev"
--    5. localities                   the v2 towns the demo projects use + one proposed village
--    6. donors, 33 demo projects (the five v2 samples first) with land, facilities,
--       maintenance, staff, compensation, community profiles, sensitive data, donors
--
--  Idempotent: every id is private.ref_uuid('seed:…'); rows that exist are left
--  alone, so the file can be run any number of times.
--  Must run as the database owner (postgres), without an end-user JWT.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Safety latch
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from public.app_settings s
    where s.key = 'app.environment' and s.value = to_jsonb('production'::text) and s.deleted_at is null
  ) then
    raise exception 'supabase/seed.staging.sql must never run in production (app_settings app.environment = "production")';
  end if;
  if nullif(current_setting('request.jwt.claims', true), '') is not null then
    raise exception 'supabase/seed.staging.sql must run as the database owner, not through the API';
  end if;
end
$$;

-- The web app shows its "demo data" badge only while this says "staging".
insert into public.app_settings (id, key, value, description, is_public)
values (
  private.ref_uuid('setting:app.environment'), 'app.environment', to_jsonb('staging'::text),
  'Environment marker: "staging" is written by supabase/seed.staging.sql (demo data present); production sets "production", which also blocks the staging seed.',
  true)
on conflict do nothing;

-- Session helpers (temporary: they disappear with the connection).
create or replace function pg_temp.sid(p_key text) returns uuid
language sql immutable
as $$ select private.ref_uuid('seed:' || p_key) $$;

create or replace function pg_temp.pt(p_lon double precision, p_lat double precision) returns extensions.geometry
language sql immutable
as $$ select extensions.st_setsrid(extensions.st_makepoint(p_lon, p_lat), 4326) $$;

-- Level-1 area of a country by its English or Swahili name (imported boundary or fallback
-- square: both use the geoBoundaries names). Used as the fallback area of demo rows; the
-- triggers replace it by the deepest boundary that really contains the point.
create or replace function pg_temp.area_named(p_iso2 text, p_name text) returns uuid
language sql stable
as $$
  select a.id
  from public.admin_areas a
  join public.countries c on c.id = a.country_id
  where c.iso2 = p_iso2
    and a.level = 1
    and a.deleted_at is null
    and lower(p_name) in (lower(a.name_en), lower(a.name_sw))
  order by a.id
  limit 1
$$;

-- Ids of option_values rows: pg_temp.opts('livelihoods', 'fishing', 'trade').
create or replace function pg_temp.opts(p_list text, variadic p_codes text[]) returns uuid[]
language sql immutable
as $$ select coalesce(array_agg(private.ref_uuid('option:' || p_list || ':' || c)), '{}'::uuid[]) from unnest(p_codes) as c $$;

-- -----------------------------------------------------------------------------
-- 2. Fallback admin areas: plain squares around the regions the demo data uses.
--    Inserted ONLY for a country that has no imported boundaries. The boundary
--    importer (npm run boundaries:import) retires them — it replaces every
--    level it loads — and moves branches, projects and localities over to the
--    real shapes of the same name. code prefix: FALLBACK-.
-- -----------------------------------------------------------------------------
insert into public.admin_areas (id, country_id, level, code, short_code, name_ar, name_en, name_sw, geom)
select pg_temp.sid('area:' || v.code), c.id, 1, v.code, v.short_code, v.name_ar, v.name_en, v.name_sw,
       extensions.st_multi(extensions.st_makeenvelope(v.x1, v.y1, v.x2, v.y2, 4326))
from (values
  ('TZ', 'FALLBACK-TZ-06', 'PN', 'بيمبا الشمالية',          'North Pemba',         'Kaskazini Pemba', 39.55, -5.15, 39.90, -4.80),
  ('TZ', 'FALLBACK-TZ-10', 'PS', 'بيمبا الجنوبية',          'South Pemba',         'Kusini Pemba',    39.55, -5.50, 39.90, -5.15),
  ('TZ', 'FALLBACK-TZ-15', 'ZW', 'زنجبار الحضرية والغربية', 'Zanzibar Urban/West', 'Mjini Magharibi', 39.15, -6.30, 39.33, -6.05),
  ('TZ', 'FALLBACK-TZ-25', 'TG', 'تانغا',                   'Tanga',               'Tanga',           38.20, -5.60, 39.30, -4.60),
  ('KE', 'FALLBACK-KE-28', 'MB', 'مومباسا',                 'Mombasa',             'Mombasa',         39.50, -4.20, 39.80, -3.90),
  ('UG', 'FALLBACK-UG-C',  'CE', 'المنطقة الوسطى',          'Central Region',      'Mkoa wa Kati',    32.30,  0.10, 32.90,  0.60)
) as v (iso2, code, short_code, name_ar, name_en, name_sw, x1, y1, x2, y2)
join public.countries c on c.iso2 = v.iso2
where not exists (
  select 1 from public.admin_areas a
  where a.country_id = c.id and a.deleted_at is null and a.code not like 'FALLBACK-%')
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 3. Branches. admin_area_ids = the level-1 areas with the listed names that
--    exist (with fallback squares only the first region of ZANZIBAR and MOMBASA
--    exists; with imported boundaries all of them do).
-- -----------------------------------------------------------------------------
insert into public.branches (id, country_id, code, name_ar, name_en, name_sw, admin_area_ids, active)
select pg_temp.sid('branch:' || v.code), c.id, v.code, v.name_ar, v.name_en, v.name_sw,
       coalesce((
         select array_agg(x.area_id order by x.ord)
         from (
           select pg_temp.area_named(v.iso2, r.name) as area_id, r.ord
           from unnest(v.regions) with ordinality as r (name, ord)
         ) x
         where x.area_id is not null), '{}'::uuid[]),
       true
from (values
  ('TZ', 'PEMBA',    'فرع بيمبا',   'Pemba branch',    'Tawi la Pemba',
   array['North Pemba', 'South Pemba']),
  ('TZ', 'ZANZIBAR', 'فرع زنجبار',  'Zanzibar branch', 'Tawi la Unguja',
   array['Zanzibar Urban/West', 'Zanzibar North', 'Zanzibar South & Central']),
  ('TZ', 'TANGA',    'فرع تانغا',   'Tanga branch',    'Tawi la Tanga',
   array['Tanga']),
  ('KE', 'MOMBASA',  'فرع مومباسا', 'Mombasa branch',  'Tawi la Mombasa',
   array['Mombasa', 'Kwale', 'Kilifi']),
  ('UG', 'KAMPALA',  'فرع كمبالا',  'Kampala branch',  'Tawi la Kampala',
   array['Central Region'])
) as v (iso2, code, name_ar, name_en, name_sw, regions)
join public.countries c on c.iso2 = v.iso2
where not exists (
  select 1 from public.branches b
  where b.id = pg_temp.sid('branch:' || v.code) or (b.country_id = c.id and b.code = v.code));

-- -----------------------------------------------------------------------------
-- 4. Test users — one per role (brief section 3).
--
--      e-mail                          role               scope           language
--      hq.admin@example.org            hq_admin           global          ar     (needs MFA: aal2)
--      manager.tz@example.org          country_manager    Tanzania        en     (needs MFA: aal2)
--      supervisor.pemba@example.org    branch_supervisor  branch PEMBA    sw
--      collector.pemba@example.org     field_collector    branch PEMBA    sw     phone +255700000001
--      collector2.pemba@example.org    field_collector    branch PEMBA    ar
--      collector.mombasa@example.org   field_collector    branch MOMBASA  sw     phone +254700000001
--      viewer@example.org              viewer             global          en
--
--    Development password for all of them: Passw0rd!dev   (documented on purpose:
--    these accounts exist only where this file was run). The two phone numbers
--    are the test_otp numbers of supabase/config.toml (code 123456).
--
--    Only auth.users columns that exist on real Supabase are used. Columns that
--    a slim local shim may lack are filled through guarded dynamic SQL.
-- -----------------------------------------------------------------------------
do $$
declare
  u       record;
  v_ids   uuid[] := '{}';
  v_col   text;
begin
  for u in
    select * from (values
      ('hq.admin@example.org',          null::text),
      ('manager.tz@example.org',        null),
      ('supervisor.pemba@example.org',  null),
      ('collector.pemba@example.org',   '255700000001'),
      ('collector2.pemba@example.org',  null),
      ('collector.mombasa@example.org', '254700000001'),
      ('viewer@example.org',            null)
    ) as t (email, phone)
  loop
    if not exists (select 1 from auth.users x where lower(x.email) = u.email) then
      insert into auth.users
        (id, aud, role, email, encrypted_password, email_confirmed_at,
         raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      values
        (private.ref_uuid('seed:user:' || u.email), 'authenticated', 'authenticated', u.email,
         extensions.crypt('Passw0rd!dev', extensions.gen_salt('bf')), now(),
         jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')),
         jsonb_build_object('seed', true), now(), now());
      v_ids := v_ids || private.ref_uuid('seed:user:' || u.email);
    end if;
  end loop;

  if cardinality(v_ids) = 0 then
    return;
  end if;

  -- GoTrue filters users by instance_id (all zeros on a single-tenant project).
  if exists (select 1 from information_schema.columns
             where table_schema = 'auth' and table_name = 'users' and column_name = 'instance_id') then
    execute 'update auth.users set instance_id = ''00000000-0000-0000-0000-000000000000''
              where id = any ($1) and instance_id is null' using v_ids;
  end if;

  -- GoTrue scans these columns into Go strings: NULL breaks sign-in for the user.
  foreach v_col in array array[
    'confirmation_token', 'recovery_token', 'email_change_token_new', 'email_change',
    'email_change_token_current', 'phone_change', 'phone_change_token', 'reauthentication_token']
  loop
    if exists (select 1 from information_schema.columns
               where table_schema = 'auth' and table_name = 'users' and column_name = v_col) then
      execute format('update auth.users set %1$I = '''' where id = any ($1) and %1$I is null', v_col)
        using v_ids;
    end if;
  end loop;

  -- Phone sign-in (OTP) for the two field collectors. GoTrue stores phones without "+".
  if exists (select 1 from information_schema.columns
             where table_schema = 'auth' and table_name = 'users' and column_name = 'phone_confirmed_at') then
    execute $q$
      update auth.users x
         set phone = v.phone, phone_confirmed_at = now()
        from (values ('collector.pemba@example.org', '255700000001'),
                     ('collector.mombasa@example.org', '254700000001')) as v (email, phone)
       where x.email = v.email
         and x.id = any ($1)
         and not exists (select 1 from auth.users y where y.phone = v.phone)
    $q$ using v_ids;
  end if;

  -- E-mail identities (real Supabase; skipped when the table or its modern shape is missing).
  if exists (select 1 from information_schema.columns
             where table_schema = 'auth' and table_name = 'identities' and column_name = 'provider_id') then
    begin
      execute $q$
        insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
        select x.id::text, x.id,
               jsonb_build_object('sub', x.id::text, 'email', x.email, 'email_verified', true, 'phone_verified', false),
               'email', now(), now(), now()
          from auth.users x
         where x.id = any ($1)
           and not exists (select 1 from auth.identities i where i.user_id = x.id and i.provider = 'email')
      $q$ using v_ids;
    exception when others then
      raise notice 'seed: auth.identities rows were not created (%)', sqlerrm;
    end;
  end if;
end
$$;

-- Id of a seed user (an account that already existed under the same e-mail is reused).
create or replace function pg_temp.uid(p_email text) returns uuid
language sql stable
as $$
  select coalesce(
    (select x.id from auth.users x where lower(x.email) = p_email order by x.created_at limit 1),
    private.ref_uuid('seed:user:' || p_email))
$$;

insert into public.profiles (id, full_name, phone, preferred_language, active)
select pg_temp.uid(v.email), v.full_name, v.phone, v.lang, true
from (values
  ('hq.admin@example.org',          'مسؤول الإدارة العليا (تجريبي)', null,            'ar'),
  ('manager.tz@example.org',        'مدير تنزانيا (تجريبي)',         null,            'en'),
  ('supervisor.pemba@example.org',  'مشرف فرع بيمبا (تجريبي)',       null,            'sw'),
  ('collector.pemba@example.org',   'مُدخل بيمبا 1 (تجريبي)',        '+255700000001', 'sw'),
  ('collector2.pemba@example.org',  'مُدخل بيمبا 2 (تجريبي)',        null,            'ar'),
  ('collector.mombasa@example.org', 'مُدخل مومباسا (تجريبي)',        '+254700000001', 'sw'),
  ('viewer@example.org',            'مستخدم اطلاع (تجريبي)',         null,            'en')
) as v (email, full_name, phone, lang)
on conflict (id) do nothing;

insert into public.user_roles (id, user_id, role, scope_type, scope_id)
select pg_temp.sid('role:' || v.email || ':' || v.role), pg_temp.uid(v.email), v.role, v.scope_type, s.scope_id
from (values
  ('hq.admin@example.org',          'hq_admin',          'global',  null),
  ('manager.tz@example.org',        'country_manager',   'country', 'TZ'),
  ('supervisor.pemba@example.org',  'branch_supervisor', 'branch',  'PEMBA'),
  ('collector.pemba@example.org',   'field_collector',   'branch',  'PEMBA'),
  ('collector2.pemba@example.org',  'field_collector',   'branch',  'PEMBA'),
  ('collector.mombasa@example.org', 'field_collector',   'branch',  'MOMBASA'),
  ('viewer@example.org',            'viewer',            'global',  null)
) as v (email, role, scope_type, scope_key)
cross join lateral (
  select case v.scope_type
           when 'country' then (select c.id from public.countries c where c.iso2 = v.scope_key)
           when 'branch'  then pg_temp.sid('branch:' || v.scope_key)
         end as scope_id
) s
where not exists (
  select 1 from public.user_roles r
  where r.user_id = pg_temp.uid(v.email)
    and r.role = v.role
    and r.scope_type = v.scope_type
    and r.scope_id is not distinct from s.scope_id
    and r.deleted_at is null)
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 5. Localities. The approved ones are towns of the v2 location tree with the
--    SAME ids as scripts/import-boundaries/localities.v2.json, so the importer
--    never duplicates them. Plus one proposed village for the approval queue.
-- -----------------------------------------------------------------------------
insert into public.localities (id, created_by, country_id, admin_area_id, name_ar, name_latin, geom, status)
select private.ref_uuid(v.ref_key),
       case when v.status = 'proposed' then pg_temp.uid('collector.pemba@example.org') end,
       c.id, pg_temp.area_named(v.iso2, v.region), v.name_ar, v.name_latin, pg_temp.pt(v.lon, v.lat), v.status
from (values
  ('locality:v2:TZ:north-pemba:wete',                  'TZ', 'North Pemba',         'ويتي',         'Wete',          39.728, -5.057, 'approved'),
  ('locality:v2:TZ:north-pemba:micheweni',             'TZ', 'North Pemba',         'ميشيوني',      'Micheweni',     39.833, -4.967, 'approved'),
  ('locality:v2:TZ:north-pemba:konde',                 'TZ', 'North Pemba',         'كوندي',        'Konde',         39.75,  -4.95,  'approved'),
  ('locality:v2:TZ:south-pemba:chake-chake',           'TZ', 'South Pemba',         'تشاكي تشاكي',  'Chake Chake',   39.767, -5.246, 'approved'),
  ('locality:v2:TZ:south-pemba:mkoani',                'TZ', 'South Pemba',         'مكواني',       'Mkoani',        39.648, -5.357, 'approved'),
  ('locality:v2:TZ:zanzibar-urban-west:zanzibar-city', 'TZ', 'Zanzibar Urban/West', 'مدينة زنجبار', 'Zanzibar City', 39.203, -6.166, 'approved'),
  ('locality:v2:TZ:tanga:tanga',                       'TZ', 'Tanga',               'تانغا',        'Tanga',         39.099, -5.069, 'approved'),
  ('locality:v2:TZ:tanga:muheza',                      'TZ', 'Tanga',               'موهيزا',       'Muheza',        38.783, -5.167, 'approved'),
  ('locality:v2:TZ:tanga:korogwe',                     'TZ', 'Tanga',               'كوروجوي',      'Korogwe',       38.483, -5.156, 'approved'),
  ('locality:v2:KE:mombasa:mombasa',                   'KE', 'Mombasa',             'مومباسا',      'Mombasa',       39.668, -4.044, 'approved'),
  ('locality:v2:UG:kampala:kampala',                   'UG', 'Central Region',      'كمبالا',       'Kampala',       32.583,  0.348, 'approved'),
  ('seed:locality:tumbe',                              'TZ', 'North Pemba',         'تومبي',        'Tumbe',         39.79,  -4.95,  'proposed')
) as v (ref_key, iso2, region, name_ar, name_latin, lon, lat, status)
join public.countries c on c.iso2 = v.iso2
where not exists (select 1 from public.localities l where l.id = private.ref_uuid(v.ref_key));

-- -----------------------------------------------------------------------------
-- 6. Donors
-- -----------------------------------------------------------------------------
insert into public.donors (id, created_by, name_ar, name_latin, notes)
values
  (pg_temp.sid('donor:1'), pg_temp.uid('hq.admin@example.org'), 'متبرع كريم',          'Generous donor',       'من بيانات v2 التجريبية'),
  (pg_temp.sid('donor:2'), pg_temp.uid('hq.admin@example.org'), 'فاعل خير',            'Anonymous benefactor', null),
  (pg_temp.sid('donor:3'), pg_temp.uid('hq.admin@example.org'), 'وقف الخير',           'Waqf Al-Khair',        null),
  (pg_temp.sid('donor:4'), pg_temp.uid('hq.admin@example.org'), 'مؤسسة البر الخيرية',  'Al-Birr Charity',      null)
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 7. Demo projects. Rows 1-5 are the five SAMPLE_PROJECTS of v2
--    (reference/v2/src/app.js) re-mapped to the official regions: v2 said
--    "Pemba" / "Zanzibar", here the point decides (North Pemba, South Pemba,
--    Zanzibar Urban/West). Codes (TZ-PN-000001 …) are generated by the trigger.
--
--    INSERT … WHERE NOT EXISTS (not ON CONFLICT): the BEFORE INSERT trigger
--    consumes a project-code number even for a row that would then conflict.
-- -----------------------------------------------------------------------------
create temporary table if not exists _seed_projects (
  n           integer primary key,
  name_ar     text not null,
  name_latin  text,
  type        text not null,
  status      text not null,
  capacity    integer,
  lon         double precision,
  lat         double precision,
  accuracy    real,
  source      text,
  iso2        text not null,
  branch      text not null,
  region      text,              -- level-1 area (English name), filled below
  loc_key     text,              -- private.ref_uuid() key of the locality
  build_year  smallint,
  state       text not null,
  creator     text not null,
  reviewer    text,
  review_note text,
  days_ago    integer not null
);
truncate _seed_projects;

insert into _seed_projects
  (n, name_ar, name_latin, type, status, capacity, lon, lat, accuracy, source, iso2, branch, loc_key,
   build_year, state, creator, reviewer, review_note, days_ago)
values
  -- v2 samples ------------------------------------------------------------------------------
  ( 1, 'مسجد النور',            'Masjid An-Nur',              'mosque',   'active',      350, 39.729, -5.055,  6, 'gps', 'TZ', 'PEMBA',    'locality:v2:TZ:north-pemba:wete',                  2019, 'approved',  'collector.pemba@example.org',   'supervisor.pemba@example.org', null, 68),
  ( 2, 'مدرسة الفلاح للقرآن',   'Madrasat Al-Falah',          'school',   'active',      120, 39.714, -5.066,  9, 'gps', 'TZ', 'PEMBA',    'locality:v2:TZ:north-pemba:wete',                  2021, 'approved',  'collector.pemba@example.org',   'supervisor.pemba@example.org', null, 66),
  ( 3, 'مسجد ومدرسة الرحمة',    'Masjid na Madrasa Ar-Rahma', 'combined', 'active',      280, 39.648, -5.357, 12, 'gps', 'TZ', 'PEMBA',    'locality:v2:TZ:south-pemba:mkoani',                2020, 'approved',  'collector2.pemba@example.org',  'supervisor.pemba@example.org', null, 61),
  ( 4, 'مسجد الهدى',            'Masjid Al-Huda',             'mosque',   'maintenance', 420, 39.199, -6.165, 15, 'map', 'TZ', 'ZANZIBAR', 'locality:v2:TZ:zanzibar-urban-west:zanzibar-city', 2017, 'approved',  'manager.tz@example.org',        'manager.tz@example.org',       null, 59),
  ( 5, 'مدرسة البيان',          'Madrasat Al-Bayan',          'school',   'building',     85, 39.66,  -5.37,   8, 'gps', 'TZ', 'PEMBA',    'locality:v2:TZ:south-pemba:mkoani',                2023, 'approved',  'collector2.pemba@example.org',  'supervisor.pemba@example.org', null, 55),
  -- Pemba -----------------------------------------------------------------------------------
  ( 6, 'مسجد التقوى',           'Masjid At-Taqwa',            'mosque',   'active',      200, 39.742, -5.048,  5, 'gps', 'TZ', 'PEMBA',    'locality:v2:TZ:north-pemba:wete',                  2015, 'approved',  'collector.pemba@example.org',   'supervisor.pemba@example.org', null, 50),
  ( 7, 'مدرسة النجاح القرآنية', 'Madrasat An-Najah',          'school',   'active',       90, 39.829, -4.968, 11, 'gps', 'TZ', 'PEMBA',    'locality:v2:TZ:north-pemba:micheweni',             2018, 'approved',  'collector2.pemba@example.org',  'supervisor.pemba@example.org', null, 47),
  ( 8, 'مسجد الإيمان',          'Masjid Al-Iman',             'mosque',   'maintenance', 150, 39.752, -4.953,  7, 'gps', 'TZ', 'PEMBA',    'locality:v2:TZ:north-pemba:konde',                 2010, 'approved',  'collector.pemba@example.org',   'supervisor.pemba@example.org', null, 44),
  ( 9, 'مسجد ومدرسة الفرقان',   'Masjid na Madrasa Al-Furqan','combined', 'active',      320, 39.80,  -4.99,  22, 'gps', 'TZ', 'PEMBA',    'seed:locality:tumbe',                              2016, 'submitted', 'collector2.pemba@example.org',  null,                           null, 12),
  (10, 'مدرسة دار الأرقم',      'Madrasat Dar Al-Arqam',      'school',   'building',     60, 39.70,  -5.02,  35, 'gps', 'TZ', 'PEMBA',    null,                                               2024, 'draft',     'collector.pemba@example.org',   null,                           null,  3),
  (11, 'مسجد السلام',           'Masjid As-Salam',            'mosque',   'inactive',     80, 39.77,  -5.10,  10, 'map', 'TZ', 'PEMBA',    null,                                               1998, 'approved',  'collector2.pemba@example.org',  'supervisor.pemba@example.org', null, 40),
  (12, 'مسجد قباء',             'Masjid Quba',                'mosque',   'active',      180, 39.735, -5.075, 48, 'gps', 'TZ', 'PEMBA',    'locality:v2:TZ:north-pemba:wete',                  2012, 'returned',  'collector.pemba@example.org',   'supervisor.pemba@example.org', 'دقة الموقع ضعيفة (48 م). يرجى إعادة التقاط الإحداثيات من أمام المسجد.', 9),
  (13, 'مسجد الفتح',            'Masjid Al-Fath',             'mosque',   'active',      400, 39.767, -5.243,  6, 'gps', 'TZ', 'PEMBA',    'locality:v2:TZ:south-pemba:chake-chake',           2008, 'approved',  'collector.pemba@example.org',   'supervisor.pemba@example.org', null, 37),
  (14, 'مدرسة الهداية',         'Madrasat Al-Hidaya',         'school',   'active',      140, 39.772, -5.252,  9, 'gps', 'TZ', 'PEMBA',    'locality:v2:TZ:south-pemba:chake-chake',           2019, 'approved',  'collector2.pemba@example.org',  'supervisor.pemba@example.org', null, 33),
  (15, 'مسجد ومدرسة التوحيد',   'Masjid na Madrasa At-Tawhid','combined', 'maintenance', 260, 39.70,  -5.30,  14, 'gps', 'TZ', 'PEMBA',    null,                                               2014, 'approved',  'collector.pemba@example.org',   'supervisor.pemba@example.org', null, 30),
  (16, 'مسجد الصفا',            'Masjid As-Safa',             'mosque',   'active',      120, 39.66,  -5.34,  18, 'gps', 'TZ', 'PEMBA',    'locality:v2:TZ:south-pemba:mkoani',                2021, 'submitted', 'collector2.pemba@example.org',  null,                           null,  6),
  (17, 'مدرسة ابن عباس',        null,                         'school',   'active',       75, null,   null,   null, null, 'TZ', 'PEMBA',    null,                                               null, 'draft',     'collector2.pemba@example.org',  null,                           null,  1),
  -- Zanzibar (Unguja) -----------------------------------------------------------------------
  (18, 'مسجد الرحمن',           'Masjid Ar-Rahman',           'mosque',   'active',      500, 39.215, -6.160,  8, 'gps', 'TZ', 'ZANZIBAR', 'locality:v2:TZ:zanzibar-urban-west:zanzibar-city', 2005, 'approved',  'manager.tz@example.org',        'manager.tz@example.org',       null, 52),
  (19, 'مدرسة الإحسان',         'Madrasat Al-Ihsan',          'school',   'active',      160, 39.225, -6.185, 10, 'gps', 'TZ', 'ZANZIBAR', null,                                               2017, 'approved',  'manager.tz@example.org',        'manager.tz@example.org',       null, 45),
  (20, 'مسجد ومدرسة البركة',    'Masjid na Madrasa Al-Baraka','combined', 'building',    220, 39.25,  -6.21,  13, 'map', 'TZ', 'ZANZIBAR', null,                                               2025, 'submitted', 'manager.tz@example.org',        null,                           null,  8),
  (21, 'مسجد بلال',             'Masjid Bilal',               'mosque',   'active',      130, 39.245, -6.12,   7, 'gps', 'TZ', 'ZANZIBAR', null,                                               2011, 'approved',  'manager.tz@example.org',        'manager.tz@example.org',       null, 28),
  -- Tanga -----------------------------------------------------------------------------------
  (22, 'مسجد الاستقامة',        'Masjid Al-Istiqama',         'mosque',   'active',      450, 39.095, -5.075,  5, 'gps', 'TZ', 'TANGA',    'locality:v2:TZ:tanga:tanga',                       2009, 'approved',  'manager.tz@example.org',        'manager.tz@example.org',       null, 58),
  (23, 'مدرسة النور القرآنية',  'Madrasat An-Nur',            'school',   'active',      110, 39.08,  -5.09,   9, 'gps', 'TZ', 'TANGA',    'locality:v2:TZ:tanga:tanga',                       2020, 'approved',  'manager.tz@example.org',        'manager.tz@example.org',       null, 41),
  (24, 'مسجد ومدرسة الهجرة',    'Masjid na Madrasa Al-Hijra', 'combined', 'maintenance', 300, 38.785, -5.170, 12, 'gps', 'TZ', 'TANGA',    'locality:v2:TZ:tanga:muheza',                      2013, 'approved',  'manager.tz@example.org',        'manager.tz@example.org',       null, 26),
  (25, 'مسجد عمر بن الخطاب',    'Masjid Umar bin Al-Khattab', 'mosque',   'active',      210, 38.49,  -5.15,  16, 'map', 'TZ', 'TANGA',    'locality:v2:TZ:tanga:korogwe',                     2018, 'approved',  'manager.tz@example.org',        'manager.tz@example.org',       null, 19),
  (26, 'مدرسة الصديق',          'Madrasat As-Siddiq',         'school',   'inactive',     50, 38.90,  -5.05,  20, 'map', 'TZ', 'TANGA',    null,                                               2003, 'approved',  'manager.tz@example.org',        'manager.tz@example.org',       null, 15),
  -- Mombasa ---------------------------------------------------------------------------------
  (27, 'مسجد مصعب بن عمير',     'Masjid Mus''ab bin Umair',   'mosque',   'active',      380, 39.665, -4.055,  6, 'gps', 'KE', 'MOMBASA',  'locality:v2:KE:mombasa:mombasa',                   2007, 'approved',  'collector.mombasa@example.org', 'hq.admin@example.org',         null, 36),
  (28, 'مدرسة الأنصار',         'Madrasat Al-Ansar',          'school',   'active',      130, 39.69,  -4.02,   9, 'gps', 'KE', 'MOMBASA',  'locality:v2:KE:mombasa:mombasa',                   2019, 'approved',  'collector.mombasa@example.org', 'hq.admin@example.org',         null, 24),
  (29, 'مسجد ومدرسة الخير',     'Masjid na Madrasa Al-Khair', 'combined', 'building',    240, 39.63,  -4.00,  11, 'gps', 'KE', 'MOMBASA',  null,                                               2025, 'submitted', 'collector.mombasa@example.org', null,                           null,  5),
  (30, 'مسجد الرضوان',          'Masjid Ar-Ridwan',           'mosque',   'maintenance', 170, 39.70,  -3.98,  14, 'gps', 'KE', 'MOMBASA',  null,                                               2001, 'approved',  'collector.mombasa@example.org', 'hq.admin@example.org',         null, 17),
  -- Kampala ---------------------------------------------------------------------------------
  (31, 'مسجد التوبة',           'Masjid At-Tawba',            'mosque',   'active',      600, 32.575,  0.33,   7, 'gps', 'UG', 'KAMPALA',  'locality:v2:UG:kampala:kampala',                   2004, 'approved',  'hq.admin@example.org',          'hq.admin@example.org',         null, 22),
  (32, 'مدرسة الفجر',           'Madrasat Al-Fajr',           'school',   'active',      200, 32.60,   0.36,  10, 'map', 'UG', 'KAMPALA',  'locality:v2:UG:kampala:kampala',                   2016, 'approved',  'hq.admin@example.org',          'hq.admin@example.org',         null, 20),
  (33, 'مسجد ومدرسة الأمانة',   'Masjid na Madrasa Al-Amana', 'combined', 'active',      270, 32.55,   0.31,  12, 'map', 'UG', 'KAMPALA',  null,                                               2022, 'submitted', 'hq.admin@example.org',          null,                           null,  4);

-- The region a located demo project belongs to (Pemba is split at 5.15° S). It is only the
-- fallback: the projects trigger takes the deepest boundary that contains the point.
update _seed_projects
   set region = case
         when lon is null then null
         when branch = 'PEMBA' and lat > -5.15 then 'North Pemba'
         when branch = 'PEMBA' then 'South Pemba'
         when branch = 'ZANZIBAR' then 'Zanzibar Urban/West'
         when branch = 'TANGA' then 'Tanga'
         when branch = 'MOMBASA' then 'Mombasa'
         when branch = 'KAMPALA' then 'Central Region'
       end;

insert into public.projects
  (id, created_by, created_at, name_ar, name_latin, type, status, capacity, geom, gps_accuracy_m,
   location_source, country_id, admin_area_id, locality_id, branch_id, builder, build_year,
   record_state, review_note, reviewed_by)
select pg_temp.sid('project:' || lpad(p.n::text, 2, '0')),
       pg_temp.uid(p.creator),
       now() - make_interval(days => p.days_ago),
       p.name_ar, p.name_latin, p.type, p.status, p.capacity,
       case when p.lon is not null then pg_temp.pt(p.lon, p.lat) end,
       p.accuracy, p.source, c.id,
       pg_temp.area_named(p.iso2, p.region),
       case when p.loc_key is not null then private.ref_uuid(p.loc_key) end,
       pg_temp.sid('branch:' || p.branch),
       'الاستقامة', p.build_year, p.state, p.review_note,
       case when p.reviewer is not null then pg_temp.uid(p.reviewer) end
from _seed_projects p
join public.countries c on c.iso2 = p.iso2
where not exists (
  select 1 from public.projects x where x.id = pg_temp.sid('project:' || lpad(p.n::text, 2, '0')))
order by p.n;

-- Land ------------------------------------------------------------------------
insert into public.project_land
  (id, created_by, project_id, ownership, owner_name, area_m2, utilization_pct, expandable, notes)
select pg_temp.sid('land:' || lpad(v.n::text, 2, '0')), pr.created_by, pr.id,
       v.ownership, v.owner_name, v.area_m2, v.utilization_pct, v.expandable, v.notes
from (values
  ( 1, 'waqf',        'وقف المسجد',          1800, 55, true,  'أرض مسوّرة مع مساحة خلفية غير مستغلة'),
  ( 2, 'association', 'جمعية الاستقامة',      900, 80, false, null),
  ( 3, 'waqf',        'وقف أهالي القرية',    2400, 45, true,  null),
  ( 4, 'government',  null,                  1500, 90, false, 'الأرض مخصصة من البلدية'),
  ( 5, 'association', 'جمعية الاستقامة',     1200, 30, true,  'المبنى قيد الإنشاء'),
  ( 6, 'waqf',        'وقف المسجد',          1000, 70, false, null),
  ( 8, 'person',      'أحد أهالي القرية',     750, 85, false, 'يلزم توثيق التنازل عن الأرض'),
  (13, 'waqf',        'وقف المسجد',          3200, 60, true,  null),
  (15, 'association', 'جمعية الاستقامة',     2100, 50, true,  null),
  (18, 'waqf',        'وقف المسجد',          2600, 95, false, null),
  (22, 'association', 'جمعية الاستقامة',     4000, 40, true,  'تصلح لإضافة سكن للمعلمين'),
  (24, 'waqf',        'وقف أهالي القرية',    1700, 65, true,  null),
  (27, 'waqf',        'وقف المسجد',          2200, 85, false, null),
  (30, 'person',      'ورثة المتبرع بالأرض',  600, 90, false, null),
  (31, 'association', 'جمعية الاستقامة',     5000, 35, true,  null)
) as v (n, ownership, owner_name, area_m2, utilization_pct, expandable, notes)
join public.projects pr on pr.id = pg_temp.sid('project:' || lpad(v.n::text, 2, '0'))
on conflict do nothing;

-- Facilities --------------------------------------------------------------------
insert into public.project_facilities
  (id, created_by, project_id, teacher_housing, imam_housing, guest_housing, library, hall,
   quran_count, quran_need, hall_capacity, student_transport, students_origin)
select pg_temp.sid('facilities:' || lpad(v.n::text, 2, '0')), pr.created_by, pr.id,
       v.teacher_housing, v.imam_housing, v.guest_housing, v.library, v.hall,
       v.quran_count, v.quran_need, v.hall_capacity, v.student_transport, v.students_origin
from (values
  ( 1, null,  true,  false, true,  false, 120,  30, null, null,         null),
  ( 2, false, null,  false, true,  true,   60,  80,  100, 'needed',     'mixed'),
  ( 3, true,  true,  true,  true,  true,  150,  40,  180, 'not_needed', 'nearby'),
  ( 4, null,  false, false, false, false,  90, 100, null, null,         null),
  ( 5, false, null,  false, false, false,   0, 120, null, 'needed',     'distant'),
  ( 6, null,  true,  false, false, false,  70,  20, null, null,         null),
  ( 7, false, null,  false, true,  false,  40,  60, null, 'needed',     'mixed'),
  ( 8, null,  false, false, false, false,  35,  50, null, null,         null),
  (13, null,  true,  true,  true,  true,  200,   0,  250, null,         null),
  (14, true,  null,  false, true,  true,  110,  30,  120, 'available',  'nearby'),
  (15, false, true,  false, true,  false,  95,  70, null, 'needed',     'mixed'),
  (18, null,  true,  true,  true,  true,  260,   0,  300, null,         null),
  (19, true,  null,  false, true,  true,  130,  25,  140, 'available',  'nearby'),
  (22, null,  true,  false, true,  true,  180,  40,  200, null,         null),
  (23, false, null,  false, false, false,  50,  90, null, 'needed',     'distant'),
  (24, false, false, false, true,  false,  85, 110, null, 'needed',     'mixed'),
  (27, null,  true,  true,  true,  true,  210,  20,  220, null,         null),
  (28, true,  null,  false, true,  false,  75,  45, null, 'not_needed', 'nearby'),
  (30, null,  false, false, false, false,  40,  60, null, null,         null),
  (31, null,  true,  true,  true,  true,  300,  50,  350, null,         null),
  (32, false, null,  false, true,  true,  100,  80,  150, 'needed',     'mixed')
) as v (n, teacher_housing, imam_housing, guest_housing, library, hall,
        quran_count, quran_need, hall_capacity, student_transport, students_origin)
join public.projects pr on pr.id = pg_temp.sid('project:' || lpad(v.n::text, 2, '0'))
on conflict do nothing;

-- Maintenance log (project 4 carries the v2 sample note) ---------------------------
insert into public.project_maintenance
  (id, created_by, project_id, reported_on, description, priority, estimated_cost, currency, state, resolved_on)
select pg_temp.sid('maintenance:' || v.k), pr.created_by, pr.id,
       current_date - v.days_ago, v.description, v.priority, v.cost, v.currency, v.state,
       case when v.state = 'done' then current_date - (v.days_ago - 10) end
from (values
  ('04-1',  4, 49, 'مثال تجريبي: يحتاج إلى فحص وصيانة السقف.',     'high',   2500000, 'TZS', 'open'),
  ('08-1',  8, 40, 'تسرب مياه في خزان الوضوء ويحتاج إلى استبدال.', 'medium',  800000, 'TZS', 'open'),
  ('13-1', 13, 30, 'طلاء المبنى من الخارج.',                       'low',     600000, 'TZS', 'done'),
  ('15-1', 15, 25, 'تشققات في جدار الفصل الشرقي.',                 'high',   1500000, 'TZS', 'in_progress'),
  ('22-1', 22, 20, 'صيانة مكبرات الصوت.',                          'low',     300000, 'TZS', 'in_progress'),
  ('24-1', 24, 14, 'سقف قاعة الصلاة مهدد بالسقوط.',                'urgent', 4200000, 'TZS', 'open'),
  ('24-2', 24, 14, 'دورات المياه تحتاج إلى إعادة تأهيل.',          'medium',  900000, 'TZS', 'open'),
  ('30-1', 30, 10, 'إصلاح التمديدات الكهربائية والإنارة.',         'medium',   45000, 'KES', 'open')
) as v (k, n, days_ago, description, priority, cost, currency, state)
join public.projects pr on pr.id = pg_temp.sid('project:' || lpad(v.n::text, 2, '0'))
on conflict do nothing;

-- Persons (persons 1-5 are the "manager" names of the v2 samples) -----------------
insert into public.persons
  (id, created_by, name_ar, name_latin, phone_e164, gender, birth_year, home_admin_area_id,
   education_level, graduated_from, country_id, branch_id)
select pg_temp.sid('person:' || lpad(v.k::text, 2, '0')), pr.created_by, v.name_ar, v.name_latin, v.phone,
       'male', v.birth_year, pr.admin_area_id, v.education, v.graduated_from, pr.country_id, pr.branch_id
from (values
  ( 1,  1, 'عبدالله سالم',     'Abdallah Salim',     '+255711000101', 1978, 'جامعي',       'معهد العلوم الشرعية'),
  ( 2,  2, 'محمد علي',         'Mohamed Ali',        '+255711000102', 1985, 'ثانوي',       null),
  ( 3,  3, 'خالد حسن',         'Khalid Hassan',      '+255711000103', 1980, 'جامعي',       'جامعة زنجبار'),
  ( 4,  4, 'سعيد عمر',         'Said Omar',          '+255711000104', 1972, 'دبلوم',       null),
  ( 5,  5, 'يوسف عبدالله',     'Yusuf Abdallah',     '+255711000105', 1990, 'ثانوي',       null),
  ( 6,  1, 'حامد جمعة',        'Hamad Juma',         '+255711000106', 1969, 'تعليم شرعي',  'حلقات المسجد'),
  ( 7,  2, 'سالم خميس',        'Salim Khamis',       null,            1992, 'ثانوي',       null),
  ( 8,  6, 'علي حمد',          'Ali Hamad',          '+255711000108', 1975, 'تعليم شرعي',  null),
  ( 9,  7, 'عثمان مسعود',      'Othman Masoud',      null,            1988, 'دبلوم',       'كلية المعلمين'),
  (10,  8, 'راشد سيف',         'Rashid Seif',        '+255711000110', 1966, 'تعليم شرعي',  null),
  (11, 13, 'ناصر سليمان',      'Nassor Suleiman',    '+255711000111', 1970, 'جامعي',       'معهد العلوم الشرعية'),
  (12, 14, 'مسعود حاجي',       'Masoud Haji',        null,            1994, 'ثانوي',       null),
  (13, 15, 'جمعة عبدالرحمن',   'Juma Abdulrahman',   '+255711000113', 1982, 'دبلوم',       null),
  (14, 18, 'إبراهيم موسى',     'Ibrahim Mussa',      '+255711000114', 1965, 'جامعي',       'جامعة زنجبار'),
  (15, 19, 'حسن مكامي',        'Hassan Makame',      null,            1991, 'جامعي',       'كلية المعلمين'),
  (16, 22, 'عمر شعبان',        'Omar Shaaban',       '+255711000116', 1974, 'تعليم شرعي',  null),
  (17, 23, 'رمضان عيسى',       'Ramadhan Issa',      null,            1989, 'ثانوي',       null),
  (18, 24, 'بكر محمد',         'Bakari Mohamed',     '+255711000118', 1979, 'دبلوم',       null),
  (19, 27, 'عبدالرحمن شيخ',    'Abdulrahman Sheikh', '+254711000119', 1968, 'جامعي',       null),
  (20, 28, 'فيصل أحمد',        'Feisal Ahmed',       null,            1993, 'ثانوي',       null),
  (21, 30, 'حمزة علي',         'Hamza Ali',          '+254711000121', 1984, 'تعليم شرعي',  null),
  (22, 31, 'موسى كاتو',        'Musa Kato',          '+256711000122', 1971, 'جامعي',       null),
  (23, 32, 'إسماعيل سيمبوا',   'Ismail Ssemwogerere','+256711000123', 1987, 'دبلوم',       null)
) as v (k, home_n, name_ar, name_latin, phone, birth_year, education, graduated_from)
join public.projects pr on pr.id = pg_temp.sid('project:' || lpad(v.home_n::text, 2, '0'))
on conflict do nothing;

-- Assignments. Person 7 teaches in two projects; person 1 holds two roles.
create temporary table if not exists _seed_staff (
  k          integer primary key,
  n          integer not null,     -- project
  person_k   integer not null,
  role       text not null,
  start_date date,
  amount     numeric,              -- monthly pay (restricted), null = volunteer / unknown
  currency   text
);
truncate _seed_staff;
insert into _seed_staff (k, n, person_k, role, start_date, amount, currency) values
  ( 1,  1,  1, 'manager',       date '2019-03-01', 350000, 'TZS'),
  ( 2,  2,  2, 'manager',       date '2021-02-01', 300000, 'TZS'),
  ( 3,  3,  3, 'manager',       date '2020-06-01', 380000, 'TZS'),
  ( 4,  4,  4, 'manager',       date '2017-09-01', 320000, 'TZS'),
  ( 5,  5,  5, 'manager',       date '2023-01-15', null,   null),
  ( 6,  1,  6, 'imam',          date '2019-03-01', 420000, 'TZS'),
  ( 7,  2,  7, 'teacher',       date '2021-02-01', 280000, 'TZS'),
  ( 8,  1,  7, 'teacher',       date '2022-01-10', 120000, 'TZS'),
  ( 9,  1,  1, 'agent',         date '2019-03-01', null,   null),
  (10,  6,  8, 'imam',          date '2015-05-01', 400000, 'TZS'),
  (11,  7,  9, 'teacher',       date '2018-08-01', 260000, 'TZS'),
  (12,  8, 10, 'imam',          date '2010-01-01', 380000, 'TZS'),
  (13, 13, 11, 'imam',          date '2008-04-01', 450000, 'TZS'),
  (14, 14, 12, 'teacher',       date '2019-09-01', 270000, 'TZS'),
  (15, 15, 13, 'administrator', date '2014-02-01', 310000, 'TZS'),
  (16, 18, 14, 'imam',          date '2005-01-01', 480000, 'TZS'),
  (17, 19, 15, 'teacher',       date '2017-03-01', 300000, 'TZS'),
  (18, 22, 16, 'imam',          date '2009-07-01', 430000, 'TZS'),
  (19, 23, 17, 'teacher',       date '2020-10-01', 250000, 'TZS'),
  (20, 24, 18, 'manager',       date '2013-11-01', 340000, 'TZS'),
  (21, 27, 19, 'imam',          date '2007-06-01',  24000, 'KES'),
  (22, 28, 20, 'teacher',       date '2019-01-15',  16000, 'KES'),
  (23, 30, 21, 'imam',          date '2012-03-01',  20000, 'KES'),
  (24, 31, 22, 'imam',          date '2004-08-01', 650000, 'UGX'),
  (25, 32, 23, 'teacher',       date '2016-02-01', 420000, 'UGX'),
  (26, 31, 23, 'other',         date '2020-01-01', null,   null);

insert into public.project_staff (id, created_by, project_id, person_id, role, start_date)
select pg_temp.sid('staff:' || lpad(s.k::text, 2, '0')), pr.created_by, pr.id,
       pg_temp.sid('person:' || lpad(s.person_k::text, 2, '0')), s.role, s.start_date
from _seed_staff s
join public.projects pr on pr.id = pg_temp.sid('project:' || lpad(s.n::text, 2, '0'))
where exists (
  select 1 from public.persons pe where pe.id = pg_temp.sid('person:' || lpad(s.person_k::text, 2, '0')))
on conflict do nothing;

-- Compensation (RESTRICTED table) -----------------------------------------------
insert into public.staff_compensation (id, created_by, project_staff_id, monthly_amount, currency, effective_from)
select pg_temp.sid('compensation:' || lpad(s.k::text, 2, '0')), st.created_by, st.id,
       s.amount, s.currency, date '2025-01-01'
from _seed_staff s
join public.project_staff st on st.id = pg_temp.sid('staff:' || lpad(s.k::text, 2, '0'))
where s.amount is not null
on conflict do nothing;

-- Community profiles ---------------------------------------------------------------
insert into public.community_profiles
  (id, created_by, project_id, branch_name, population, muslim_pct,
   daawa_activities, daawa_activities_other, social_features, livelihoods, religious_issues,
   religious_challenges, social_challenges, proposed_activities, proposed_activities_other)
select pg_temp.sid('community:' || lpad(v.n::text, 2, '0')), pr.created_by, pr.id,
       v.branch_name, v.population, v.muslim_pct,
       v.daawa, v.daawa_other, v.social, v.livelihoods, v.issues, v.rel_challenges, v.soc_challenges,
       v.proposed, v.proposed_other
from (values
  ( 1, 'فرع بيمبا',   12000, 99,
    pg_temp.opts('daawa_activities', 'quran_memorization_circles', 'islamic_lessons', 'sermons_lectures'), null,
    pg_temp.opts('social_features', 'strong_community_cooperation', 'orphan_care'),
    pg_temp.opts('livelihoods', 'fishing', 'agriculture', 'trade'),
    pg_temp.opts('religious_issues', 'teacher_shortage', 'need_youth_programs'),
    pg_temp.opts('religious_challenges', 'few_teaching_materials', 'weak_funding'),
    pg_temp.opts('social_challenges', 'poverty', 'unemployment'),
    pg_temp.opts('proposed_activities', 'teacher_training', 'youth_programs'), null),
  ( 2, 'فرع بيمبا',    8500, 99,
    pg_temp.opts('daawa_activities', 'quran_memorization_circles', 'other'), 'مسابقات قرآنية موسمية',
    pg_temp.opts('social_features', 'youth_participation', 'community_volunteering'),
    pg_temp.opts('livelihoods', 'agriculture', 'daily_labour'),
    pg_temp.opts('religious_issues', 'weak_quran_memorization'),
    pg_temp.opts('religious_challenges', 'lack_qualified_staff'),
    pg_temp.opts('social_challenges', 'school_dropout', 'poverty'),
    pg_temp.opts('proposed_activities', 'quran_circles', 'teacher_training'), null),
  ( 3, 'فرع بيمبا',   15000, 98,
    pg_temp.opts('daawa_activities', 'quran_memorization_circles', 'women_activities', 'youth_activities'), null,
    pg_temp.opts('social_features', 'women_participation', 'needy_family_support'),
    pg_temp.opts('livelihoods', 'fishing', 'trade'),
    pg_temp.opts('religious_issues', 'need_women_programs'),
    pg_temp.opts('religious_challenges', 'remote_settlements', 'weak_funding'),
    pg_temp.opts('social_challenges', 'poor_transport', 'early_marriage'),
    pg_temp.opts('proposed_activities', 'women_programs', 'daawa_caravan'), null),
  ( 4, 'فرع زنجبار',  60000, 97,
    pg_temp.opts('daawa_activities', 'sermons_lectures', 'islamic_lessons'), null,
    pg_temp.opts('social_features', 'community_councils', 'weak_community_participation'),
    pg_temp.opts('livelihoods', 'tourism', 'trade', 'government_jobs'),
    pg_temp.opts('religious_issues', 'low_prayer_attendance', 'need_youth_programs'),
    pg_temp.opts('religious_challenges', 'low_attendance', 'multiple_languages'),
    pg_temp.opts('social_challenges', 'drugs', 'unemployment'),
    pg_temp.opts('proposed_activities', 'public_lectures', 'youth_programs', 'other'), 'ملتقى شبابي صيفي'),
  (13, 'فرع بيمبا',   22000, 99,
    pg_temp.opts('daawa_activities', 'quran_memorization_circles', 'sermons_lectures', 'community_aid'), null,
    pg_temp.opts('social_features', 'strong_community_cooperation', 'community_councils'),
    pg_temp.opts('livelihoods', 'trade', 'government_jobs', 'crafts_trades'),
    pg_temp.opts('religious_issues', 'imam_shortage'),
    pg_temp.opts('religious_challenges', 'weak_training'),
    pg_temp.opts('social_challenges', 'unemployment'),
    pg_temp.opts('proposed_activities', 'imam_training', 'social_aid'), null),
  (18, 'فرع زنجبار',  45000, 96,
    pg_temp.opts('daawa_activities', 'islamic_lessons', 'training_courses'), null,
    pg_temp.opts('social_features', 'youth_participation'),
    pg_temp.opts('livelihoods', 'trade', 'tourism'),
    pg_temp.opts('religious_issues', 'wrong_beliefs_practices'),
    pg_temp.opts('religious_challenges', 'sectarian_sensitivities'),
    pg_temp.opts('social_challenges', 'drugs', 'family_problems'),
    pg_temp.opts('proposed_activities', 'public_lectures'), null),
  (22, 'فرع تانغا',   30000, 85,
    pg_temp.opts('daawa_activities', 'quran_memorization_circles', 'daawa_visits'), null,
    pg_temp.opts('social_features', 'orphan_care', 'community_volunteering'),
    pg_temp.opts('livelihoods', 'agriculture', 'trade', 'fishing'),
    pg_temp.opts('religious_issues', 'weak_islamic_education', 'teacher_shortage'),
    pg_temp.opts('religious_challenges', 'lack_qualified_staff', 'weak_funding'),
    pg_temp.opts('social_challenges', 'poverty', 'scattered_population'),
    pg_temp.opts('proposed_activities', 'daawa_caravan', 'teacher_training'), null),
  (24, 'فرع تانغا',    9000, 70,
    pg_temp.opts('daawa_activities', 'quran_memorization_circles'), null,
    pg_temp.opts('social_features', 'weak_community_participation'),
    pg_temp.opts('livelihoods', 'agriculture', 'herding'),
    pg_temp.opts('religious_issues', 'weak_islamic_education', 'imam_shortage'),
    pg_temp.opts('religious_challenges', 'remote_settlements', 'few_teaching_materials'),
    pg_temp.opts('social_challenges', 'poverty', 'poor_transport', 'school_dropout'),
    pg_temp.opts('proposed_activities', 'quran_circles', 'social_aid'), null),
  (27, 'فرع مومباسا', 80000, 60,
    pg_temp.opts('daawa_activities', 'sermons_lectures', 'youth_activities', 'women_activities'), null,
    pg_temp.opts('social_features', 'youth_participation', 'women_participation'),
    pg_temp.opts('livelihoods', 'trade', 'tourism', 'daily_labour'),
    pg_temp.opts('religious_issues', 'need_youth_programs', 'wrong_beliefs_practices'),
    pg_temp.opts('religious_challenges', 'multiple_languages', 'sectarian_sensitivities'),
    pg_temp.opts('social_challenges', 'drugs', 'unemployment'),
    pg_temp.opts('proposed_activities', 'youth_programs', 'public_lectures'), null),
  (31, 'فرع كمبالا', 150000, 25,
    pg_temp.opts('daawa_activities', 'islamic_lessons', 'daawa_visits', 'community_aid'), null,
    pg_temp.opts('social_features', 'needy_family_support', 'community_volunteering'),
    pg_temp.opts('livelihoods', 'trade', 'crafts_trades', 'daily_labour'),
    pg_temp.opts('religious_issues', 'weak_islamic_education', 'teacher_shortage'),
    pg_temp.opts('religious_challenges', 'multiple_languages', 'weak_funding'),
    pg_temp.opts('social_challenges', 'poverty', 'unemployment'),
    pg_temp.opts('proposed_activities', 'teacher_training', 'social_aid'), null)
) as v (n, branch_name, population, muslim_pct, daawa, daawa_other, social, livelihoods, issues,
        rel_challenges, soc_challenges, proposed, proposed_other)
join public.projects pr on pr.id = pg_temp.sid('project:' || lpad(v.n::text, 2, '0'))
on conflict do nothing;

-- Sensitive community data (RESTRICTED table) -----------------------------------
insert into public.community_sensitive
  (id, created_by, project_id, ibadi_families, omani_families, omani_student_pct, ibadi_student_pct,
   omani_teacher_pct, ibadi_teacher_pct, guest_financial_capacity)
select pg_temp.sid('sensitive:' || lpad(v.n::text, 2, '0')), pr.created_by, pr.id,
       v.ibadi_families, v.omani_families, v.omani_student_pct, v.ibadi_student_pct,
       v.omani_teacher_pct, v.ibadi_teacher_pct, v.capacity
from (values
  ( 1, 140, 12,  4, 55,  0, 60, 'limited'),
  ( 3,  90,  5,  2, 40,  0, 50, 'limited'),
  ( 4, 220, 35,  8, 30, 10, 45, 'good'),
  (13, 310, 20,  5, 65,  0, 70, 'good'),
  (22,  60,  8,  3, 20,  0, 35, 'limited'),
  (27,  45, 15,  6, 15,  5, 25, 'none')
) as v (n, ibadi_families, omani_families, omani_student_pct, ibadi_student_pct,
        omani_teacher_pct, ibadi_teacher_pct, capacity)
join public.projects pr on pr.id = pg_temp.sid('project:' || lpad(v.n::text, 2, '0'))
on conflict do nothing;

-- Donors of projects (v2: "متبرع كريم" on samples 2 and 5) ---------------------------
insert into public.project_donors (id, created_by, project_id, donor_id, amount, currency, year)
select pg_temp.sid('project_donor:' || v.k), pr.created_by, pr.id, pg_temp.sid('donor:' || v.donor),
       v.amount, v.currency, v.year
from (values
  ('02-1',  2, 1,  null::numeric, null,  2021),
  ('05-1',  5, 1,  null,          null,  2023),
  ('01-2',  1, 2,  25000,         'USD', 2019),
  ('13-3', 13, 3,  12000,         'OMR', 2008),
  ('18-3', 18, 3,  15000,         'OMR', 2005),
  ('22-4', 22, 4,  40000,         'USD', 2009),
  ('27-4', 27, 4,  35000,         'USD', 2007),
  ('31-2', 31, 2,  50000,         'USD', 2004),
  ('31-4', 31, 4,  20000,         'USD', 2012)
) as v (k, n, donor, amount, currency, year)
join public.projects pr on pr.id = pg_temp.sid('project:' || lpad(v.n::text, 2, '0'))
on conflict do nothing;

drop table if exists _seed_staff;
drop table if exists _seed_projects;

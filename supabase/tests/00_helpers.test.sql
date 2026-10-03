-- =============================================================================
-- 00  pgTAP harness (docs/ARCHITECTURE.md Appendix A.4)
--
-- Installs the persistent schema `tests`. This is the only test file that is
-- NOT wrapped in begin/rollback: it must run first on a fresh database and it
-- can be re-run at any time (the schema is dropped and recreated).
--
--   tests.create_user(email, role, scope_type, scope_id) -> uuid
--   tests.login_as(user, aal default 'aal2', device default 'dev-test')
--   tests.login_anon()
--   tests.logout()
--   tests.fixture()            base fixture of Appendix A.4 (idempotent)
--   tests.id(key) -> uuid      ids of fixture objects
--
-- Extras used by the authorisation suite (1x_*.test.sql):
--   tests.set_claim(name, jsonb)   override one JWT claim of the current login
--   tests.fixture_extra()          rows in every remaining scoped table
--   tests.fixture_storage()        storage.objects rows for the bucket policies
--   tests.fixture_projects() / tests.fixture_users() -> uuid[]
--   tests.ids(variadic keys) -> sorted uuid[]     tests.kind_ids(kind) -> uuid[]
--   tests.visible(table, among default null) -> sorted ids visible to the current role
--
-- Fixture keys (tests.id):
--   countries   tz, ke                 (existing rows with iso2 TZ / KE are reused)
--   admin areas tz_pemba_north, tz_tanga, ke_mombasa      (level 1 squares)
--   branches    br_pemba, br_tanga, br_mombasa
--   users       u_hq (hq_admin, global)        u_mgr_tz, u_mgr_ke (country_manager)
--               u_sup_pemba (branch_supervisor, br_pemba)
--               u_col_pemba, u_col_pemba2 (field_collector, br_pemba)
--               u_col_tanga (field_collector, br_tanga)
--               u_col_ke (field_collector, br_mombasa)
--               u_viewer_tz (viewer, country tz)   u_viewer_global (viewer, global)
--   projects    p_pemba_1 (approved), p_pemba_2 (draft)   both by u_col_pemba
--               p_tanga_1 (approved, by u_col_tanga)   p_ke_1 (approved, by u_col_ke)
--   per project '<kind>:<project key>' with kind in
--               person, staff, comp, sens, photo, maint            (tests.fixture)
--               land, fac, community, donor, pdonor, person2, merge, conflict,
--               pconflict                                          (tests.fixture_extra)
--   per area    'loc:<area key>', 'lconflict:<area key>'           (tests.fixture_extra)
--   per user    'notif:<user key>', 'export:<user key>', 'import:<user key>',
--               'importrow:<user key>', 'device:<user key>'        (tests.fixture_extra)
--   misc        donor_unlinked, setting_public, setting_private, map_pack,
--               option_value, fx_rate, applied_op                  (tests.fixture_extra)
-- =============================================================================

create extension if not exists pgtap with schema extensions;

drop schema if exists tests cascade;
create schema tests;
grant usage on schema tests to public;

comment on schema tests is 'pgTAP helpers and fixtures. Test databases only.';

-- -----------------------------------------------------------------------------
-- Deterministic ids
-- -----------------------------------------------------------------------------
create function tests._uuid(p_seed text)
returns uuid
language sql
immutable
as $$
  select md5('istiqama-map-tests:' || p_seed)::uuid;
$$;

create function tests.id(p_key text)
returns uuid
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  c_areas    constant text[] := array['tz_pemba_north', 'tz_tanga', 'ke_mombasa'];
  c_branches constant text[] := array['br_pemba', 'br_tanga', 'br_mombasa'];
  c_users    constant text[] := array[
    'u_hq', 'u_mgr_tz', 'u_mgr_ke', 'u_sup_pemba', 'u_col_pemba', 'u_col_pemba2',
    'u_col_tanga', 'u_col_ke', 'u_viewer_tz', 'u_viewer_global'];
  c_projects constant text[] := array['p_pemba_1', 'p_pemba_2', 'p_tanga_1', 'p_ke_1'];
  c_misc     constant text[] := array[
    'donor_unlinked', 'setting_public', 'setting_private', 'map_pack', 'option_value',
    'fx_rate', 'applied_op'];
  c_project_kinds constant text[] := array[
    'person', 'staff', 'comp', 'sens', 'photo', 'maint',
    'land', 'fac', 'community', 'donor', 'pdonor', 'person2', 'merge', 'conflict', 'pconflict'];
  c_area_kinds constant text[] := array['loc', 'lconflict'];
  c_user_kinds constant text[] := array['notif', 'export', 'import', 'importrow', 'device'];
  v_kind text;
  v_base text;
  v_id   uuid;
begin
  if p_key in ('tz', 'ke') then
    select c.id into v_id from public.countries c where c.iso2 = upper(p_key);
    if v_id is null then
      raise exception 'tests.id(%): country is missing, call tests.fixture() first', p_key;
    end if;
    return v_id;
  end if;

  if p_key = any (c_users) then
    return tests._uuid('user:' || p_key || '@example.org');
  end if;

  if p_key = any (c_areas || c_branches || c_projects || c_misc) then
    return tests._uuid('fixture:' || p_key);
  end if;

  if position(':' in p_key) > 0 then
    v_kind := split_part(p_key, ':', 1);
    v_base := split_part(p_key, ':', 2);
    if (v_kind = any (c_project_kinds) and v_base = any (c_projects))
       or (v_kind = any (c_area_kinds) and v_base = any (c_areas))
       or (v_kind = any (c_user_kinds) and v_base = any (c_users)) then
      return tests._uuid('fixture:' || p_key);
    end if;
  end if;

  raise exception 'tests.id: unknown fixture key "%"', p_key;
end;
$$;

create function tests.fixture_projects()
returns uuid[]
language sql
stable
as $$
  select array[tests.id('p_pemba_1'), tests.id('p_pemba_2'), tests.id('p_tanga_1'), tests.id('p_ke_1')];
$$;

create function tests.fixture_users()
returns uuid[]
language sql
stable
as $$
  select array[
    tests.id('u_hq'), tests.id('u_mgr_tz'), tests.id('u_mgr_ke'), tests.id('u_sup_pemba'),
    tests.id('u_col_pemba'), tests.id('u_col_pemba2'), tests.id('u_col_tanga'), tests.id('u_col_ke'),
    tests.id('u_viewer_tz'), tests.id('u_viewer_global')];
$$;

-- Sorted ids of several fixture keys: tests.ids('p_pemba_1', 'p_ke_1').
create function tests.ids(variadic p_keys text[])
returns uuid[]
language sql
stable
as $$
  select coalesce(array_agg(x.id order by x.id), '{}'::uuid[])
  from (select tests.id(k) as id from unnest(p_keys) as k) x;
$$;

-- Ids of one derived kind for every base key it can have, e.g.
-- tests.kind_ids('photo') = the photo ids of the four fixture projects.
create function tests.kind_ids(p_kind text)
returns uuid[]
language sql
stable
as $$
  select coalesce(array_agg(tests._uuid('fixture:' || p_kind || ':' || b.k)), '{}'::uuid[])
  from unnest(array[
    'p_pemba_1', 'p_pemba_2', 'p_tanga_1', 'p_ke_1',
    'tz_pemba_north', 'tz_tanga', 'ke_mombasa',
    'u_hq', 'u_mgr_tz', 'u_mgr_ke', 'u_sup_pemba', 'u_col_pemba', 'u_col_pemba2',
    'u_col_tanga', 'u_col_ke', 'u_viewer_tz', 'u_viewer_global']) as b (k);
$$;

-- Sorted ids the CURRENT role can see in public.<p_table>, optionally limited
-- to the candidates in p_among (use it for roles whose scope may also contain
-- non-fixture rows, e.g. staging seed data). Raises when the role has no
-- SELECT privilege.
create function tests.visible(p_table text, p_among uuid[] default null)
returns uuid[]
language plpgsql
stable
as $$
declare
  v_ids uuid[];
begin
  execute format(
    'select coalesce(array_agg(t.id order by t.id), ''{}''::uuid[]) from public.%I t '
    'where $1 is null or t.id = any ($1)', p_table)
  into v_ids
  using p_among;
  return v_ids;
end;
$$;

-- -----------------------------------------------------------------------------
-- Users and sessions
-- -----------------------------------------------------------------------------

-- Creates (or re-uses) an auth user + active profile and, when p_role is not
-- null, one role grant. The id is derived from the e-mail, so the call is
-- idempotent. Only auth.users columns that exist on real Supabase are used.
create function tests.create_user(p_email text, p_role text, p_scope_type text, p_scope_id uuid)
returns uuid
language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_email text := lower(btrim(p_email));
  v_id    uuid := tests._uuid('user:' || lower(btrim(p_email)));
begin
  insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at)
  values (
    v_id, v_email,
    '{"provider": "email", "providers": ["email"]}'::jsonb, '{}'::jsonb,
    'authenticated', 'authenticated', now(), now())
  on conflict (id) do nothing;

  -- A profile may already exist (trigger on auth.users, earlier call).
  insert into public.profiles (id, full_name, preferred_language, active)
  values (v_id, split_part(v_email, '@', 1), 'ar', true)
  on conflict (id) do update
    set full_name = excluded.full_name, active = true, deleted_at = null, sessions_revoked_at = null
    where profiles.full_name is distinct from excluded.full_name
       or not profiles.active
       or profiles.deleted_at is not null
       or profiles.sessions_revoked_at is not null;

  if p_role is not null then
    insert into public.user_roles (id, user_id, role, scope_type, scope_id)
    select
      tests._uuid('role:' || v_email || ':' || p_role || ':' || p_scope_type || ':' || coalesce(p_scope_id::text, '')),
      v_id, p_role, p_scope_type, p_scope_id
    where not exists (
      select 1
      from public.user_roles ur
      where ur.user_id = v_id
        and ur.role = p_role
        and ur.scope_type = p_scope_type
        and ur.scope_id is not distinct from p_scope_id
        and ur.deleted_at is null)
    on conflict (id) do update set deleted_at = null;
  end if;

  return v_id;
end;
$$;

-- Acts as an end user: role `authenticated` + GoTrue-style JWT claims + the
-- x-device-id request header, all transaction-local.
create function tests.login_as(p_user uuid, p_aal text default 'aal2', p_device text default 'dev-test')
returns void
language plpgsql
as $$
declare
  v_iat bigint := floor(extract(epoch from clock_timestamp()))::bigint;
begin
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', p_user,
    'role', 'authenticated',
    'aud', 'authenticated',
    'aal', p_aal,
    'iat', v_iat,
    'exp', v_iat + 3600,
    'session_id', tests._uuid('session:' || p_user::text || ':' || coalesce(p_device, ''))
  )::text, true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config(
    'request.headers',
    case when p_device is null then '{}' else jsonb_build_object('x-device-id', p_device)::text end,
    true);
  perform set_config('role', 'authenticated', true);
end;
$$;

create function tests.login_anon()
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims', '{"role": "anon"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.headers', '{}', true);
  perform set_config('role', 'anon', true);
end;
$$;

-- Back to the role that runs the test file, without any JWT.
create function tests.logout()
returns void
language plpgsql
as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.headers', '', true);
end;
$$;

-- Overrides one claim of the current login, e.g.
--   select tests.set_claim('iat', to_jsonb(extract(epoch from now() - interval '1 hour')::bigint));
create function tests.set_claim(p_name text, p_value jsonb)
returns void
language plpgsql
as $$
begin
  perform set_config(
    'request.jwt.claims',
    (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
      || jsonb_build_object(p_name, p_value))::text,
    true);
end;
$$;

-- -----------------------------------------------------------------------------
-- Base fixture (Appendix A.4). Call it as the privileged role, inside the test
-- transaction, before any login. Safe to call more than once.
-- -----------------------------------------------------------------------------
create function tests.fixture()
returns void
language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_tz uuid;
  v_ke uuid;
  r    record;
begin
  if current_user in ('anon', 'authenticated') then
    raise exception 'tests.fixture() must be called before tests.login_as()';
  end if;
  -- No JWT while seeding: the standard trigger then keeps the explicit created_by.
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);

  -- Countries (reference data may already provide TZ and KE) -------------------
  insert into public.countries (id, iso2, iso3, name_ar, name_en, name_sw, default_currency)
  select tests._uuid('fixture:tz'), 'TZ', 'TZA', 'تنزانيا', 'Tanzania', 'Tanzania', 'TZS'
  where not exists (select 1 from public.countries where iso2 = 'TZ');

  insert into public.countries (id, iso2, iso3, name_ar, name_en, name_sw, default_currency)
  select tests._uuid('fixture:ke'), 'KE', 'KEN', 'كينيا', 'Kenya', 'Kenya', 'KES'
  where not exists (select 1 from public.countries where iso2 = 'KE');

  v_tz := tests.id('tz');
  v_ke := tests.id('ke');

  -- Level-1 admin areas: simple squares that contain the fixture points ----------
  insert into public.admin_areas (id, country_id, level, code, short_code, name_ar, name_en, name_sw, geom)
  values
    (tests.id('tz_pemba_north'), v_tz, 1, 'TEST-TZ-PN', 'PN', 'شمال بيمبا', 'Pemba North (test)', 'Kaskazini Pemba',
     st_multi(st_makeenvelope(39.60, -5.20, 39.90, -4.80, 4326))),
    (tests.id('tz_tanga'), v_tz, 1, 'TEST-TZ-TG', 'TG', 'تانغا', 'Tanga (test)', 'Tanga',
     st_multi(st_makeenvelope(38.80, -5.40, 39.30, -4.80, 4326))),
    (tests.id('ke_mombasa'), v_ke, 1, 'TEST-KE-MB', 'MB', 'مومباسا', 'Mombasa (test)', 'Mombasa',
     st_multi(st_makeenvelope(39.50, -4.20, 39.80, -3.90, 4326)))
  on conflict (id) do nothing;

  -- Branches ---------------------------------------------------------------------
  insert into public.branches (id, country_id, code, name_ar, name_en, name_sw, admin_area_ids)
  values
    (tests.id('br_pemba'), v_tz, 'TEST-PEMBA', 'فرع بيمبا', 'Pemba branch (test)', 'Tawi la Pemba',
     array[tests.id('tz_pemba_north')]),
    (tests.id('br_tanga'), v_tz, 'TEST-TANGA', 'فرع تانغا', 'Tanga branch (test)', 'Tawi la Tanga',
     array[tests.id('tz_tanga')]),
    (tests.id('br_mombasa'), v_ke, 'TEST-MOMBASA', 'فرع مومباسا', 'Mombasa branch (test)', 'Tawi la Mombasa',
     array[tests.id('ke_mombasa')])
  on conflict (id) do nothing;

  -- Users ------------------------------------------------------------------------
  perform tests.create_user('u_hq@example.org', 'hq_admin', 'global', null);
  perform tests.create_user('u_mgr_tz@example.org', 'country_manager', 'country', v_tz);
  perform tests.create_user('u_mgr_ke@example.org', 'country_manager', 'country', v_ke);
  perform tests.create_user('u_sup_pemba@example.org', 'branch_supervisor', 'branch', tests.id('br_pemba'));
  perform tests.create_user('u_col_pemba@example.org', 'field_collector', 'branch', tests.id('br_pemba'));
  perform tests.create_user('u_col_pemba2@example.org', 'field_collector', 'branch', tests.id('br_pemba'));
  perform tests.create_user('u_col_tanga@example.org', 'field_collector', 'branch', tests.id('br_tanga'));
  perform tests.create_user('u_col_ke@example.org', 'field_collector', 'branch', tests.id('br_mombasa'));
  perform tests.create_user('u_viewer_tz@example.org', 'viewer', 'country', v_tz);
  perform tests.create_user('u_viewer_global@example.org', 'viewer', 'global', null);

  -- Projects + one staff member, compensation, sensitive row, photo and
  -- maintenance entry each ---------------------------------------------------------
  for r in
    select *
    from (values
      ('p_pemba_1', 'u_col_pemba', 'br_pemba',   'tz', 'TZ', 'mosque',   'approved', 39.75::float8, -5.05::float8, 'TZS', '+255700000001'),
      ('p_pemba_2', 'u_col_pemba', 'br_pemba',   'tz', 'TZ', 'school',   'draft',    39.70::float8, -4.95::float8, 'TZS', '+255700000002'),
      ('p_tanga_1', 'u_col_tanga', 'br_tanga',   'tz', 'TZ', 'combined', 'approved', 39.10::float8, -5.07::float8, 'TZS', '+255700000003'),
      ('p_ke_1',    'u_col_ke',    'br_mombasa', 'ke', 'KE', 'mosque',   'approved', 39.66::float8, -4.05::float8, 'KES', '+254700000004')
    ) as t (pkey, ukey, bkey, ckey, iso2, ptype, state, lon, lat, currency, phone)
  loop
    insert into public.projects
      (id, created_by, name_ar, name_latin, type, status, capacity, geom, gps_accuracy_m,
       location_source, country_id, branch_id, builder, build_year, record_state)
    values
      (tests.id(r.pkey), tests.id(r.ukey), 'مشروع اختبار ' || r.pkey, 'Test project ' || r.pkey, r.ptype,
       'active', 100, st_setsrid(st_makepoint(r.lon, r.lat), 4326), 8, 'gps',
       tests.id(r.ckey), tests.id(r.bkey), 'Istiqama', 2015, r.state)
    on conflict (id) do nothing;

    insert into public.persons
      (id, created_by, name_ar, name_latin, phone_e164, gender, birth_year, country_id, branch_id)
    values
      (tests.id('person:' || r.pkey), tests.id(r.ukey), 'إمام ' || r.pkey, 'Imam ' || r.pkey, r.phone,
       'male', 1980, tests.id(r.ckey), tests.id(r.bkey))
    on conflict (id) do nothing;

    insert into public.project_staff (id, created_by, project_id, person_id, role, start_date)
    values
      (tests.id('staff:' || r.pkey), tests.id(r.ukey), tests.id(r.pkey), tests.id('person:' || r.pkey),
       'imam', date '2020-01-01')
    on conflict (id) do nothing;

    insert into public.staff_compensation
      (id, created_by, project_staff_id, monthly_amount, currency, effective_from)
    values
      (tests.id('comp:' || r.pkey), tests.id(r.ukey), tests.id('staff:' || r.pkey), 250000, r.currency,
       date '2024-01-01')
    on conflict (id) do nothing;

    insert into public.community_sensitive
      (id, created_by, project_id, ibadi_families, omani_families, omani_student_pct,
       ibadi_student_pct, guest_financial_capacity)
    values
      (tests.id('sens:' || r.pkey), tests.id(r.ukey), tests.id(r.pkey), 12, 3, 5, 40, 'limited')
    on conflict (id) do nothing;

    insert into public.project_photos
      (id, created_by, project_id, storage_path_full, storage_path_thumb, taken_at, width, height,
       bytes, is_cover, category, upload_state)
    values
      (tests.id('photo:' || r.pkey), tests.id(r.ukey), tests.id(r.pkey),
       'projects/' || r.iso2 || '/' || tests.id(r.pkey)::text || '/' || tests.id('photo:' || r.pkey)::text || '_full.webp',
       'projects/' || r.iso2 || '/' || tests.id(r.pkey)::text || '/' || tests.id('photo:' || r.pkey)::text || '_thumb.webp',
       timestamptz '2025-01-15 09:00:00+00', 1600, 1200, 210000, true, 'mosque_front', 'uploaded')
    on conflict (id) do nothing;

    insert into public.project_maintenance
      (id, created_by, project_id, reported_on, description, priority, estimated_cost, currency, state)
    values
      (tests.id('maint:' || r.pkey), tests.id(r.ukey), tests.id(r.pkey), date '2025-02-01',
       'Roof repair (' || r.pkey || ')', 'high', 1500, 'USD', 'open')
    on conflict (id) do nothing;
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Extra rows for the authorisation suite: one row (at least) in every remaining
-- scoped table. Calls tests.fixture() first.
-- -----------------------------------------------------------------------------
create function tests.fixture_extra()
returns void
language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  r record;
begin
  perform tests.fixture();

  -- Children that every reader of a project may see + donors -----------------------
  for r in
    select *
    from (values
      ('p_pemba_1', 'u_col_pemba', 'TZS'),
      ('p_pemba_2', 'u_col_pemba', 'TZS'),
      ('p_tanga_1', 'u_col_tanga', 'TZS'),
      ('p_ke_1',    'u_col_ke',    'KES')
    ) as t (pkey, ukey, currency)
  loop
    insert into public.project_land (id, created_by, project_id, ownership, owner_name, area_m2, utilization_pct, expandable)
    values (tests.id('land:' || r.pkey), tests.id(r.ukey), tests.id(r.pkey), 'waqf', 'Waqf ' || r.pkey, 900, 60, true)
    on conflict (id) do nothing;

    insert into public.project_facilities (id, created_by, project_id, teacher_housing, library, quran_count, quran_need, student_transport)
    values (tests.id('fac:' || r.pkey), tests.id(r.ukey), tests.id(r.pkey), true, false, 40, 60, 'needed')
    on conflict (id) do nothing;

    insert into public.community_profiles (id, created_by, project_id, branch_name, population, muslim_pct)
    values (tests.id('community:' || r.pkey), tests.id(r.ukey), tests.id(r.pkey), 'Community ' || r.pkey, 2500, 85)
    on conflict (id) do nothing;

    insert into public.donors (id, created_by, name_ar, name_latin)
    values (tests.id('donor:' || r.pkey), tests.id(r.ukey), 'متبرع ' || r.pkey, 'Donor ' || r.pkey)
    on conflict (id) do nothing;

    insert into public.project_donors (id, created_by, project_id, donor_id, amount, currency, year)
    values (tests.id('pdonor:' || r.pkey), tests.id(r.ukey), tests.id(r.pkey), tests.id('donor:' || r.pkey), 5000, 'USD', 2015)
    on conflict (id) do nothing;

    -- A sync conflict on the project itself.
    insert into public.sync_conflicts
      (id, table_name, row_id, project_id, field, base_version, server_value, client_value,
       client_user_id, client_device_id, state)
    values
      (tests.id('conflict:' || r.pkey), 'projects', tests.id(r.pkey), tests.id(r.pkey), 'capacity', 1,
       '100'::jsonb, '120'::jsonb, tests.id(r.ukey), 'dev-test', 'open')
    on conflict (id) do nothing;
  end loop;

  -- A donor nobody linked to a project yet (entered by u_col_pemba).
  insert into public.donors (id, created_by, name_ar, name_latin)
  values (tests.id('donor_unlinked'), tests.id('u_col_pemba'), 'متبرع غير مرتبط', 'Unlinked donor')
  on conflict (id) do nothing;

  -- Second person + merge request + person conflict in Pemba and in Kenya -------------
  for r in
    select *
    from (values
      ('p_pemba_1', 'u_col_pemba', 'br_pemba',   'tz'),
      ('p_ke_1',    'u_col_ke',    'br_mombasa', 'ke')
    ) as t (pkey, ukey, bkey, ckey)
  loop
    insert into public.persons (id, created_by, name_ar, name_latin, country_id, branch_id)
    values (tests.id('person2:' || r.pkey), tests.id(r.ukey), 'معلم ' || r.pkey, 'Teacher ' || r.pkey,
            tests.id(r.ckey), tests.id(r.bkey))
    on conflict (id) do nothing;

    insert into public.person_merge_requests (id, created_by, source_person_id, target_person_id, state, reason)
    values (tests.id('merge:' || r.pkey), tests.id(r.ukey), tests.id('person2:' || r.pkey),
            tests.id('person:' || r.pkey), 'pending', 'fixture')
    on conflict (id) do nothing;

    insert into public.sync_conflicts
      (id, table_name, row_id, project_id, field, base_version, server_value, client_value,
       client_user_id, client_device_id, state)
    values
      (tests.id('pconflict:' || r.pkey), 'persons', tests.id('person:' || r.pkey), null, 'phone_e164', 1,
       '"+255700000001"'::jsonb, '"+255700000009"'::jsonb, tests.id(r.ukey), 'dev-test', 'open')
    on conflict (id) do nothing;
  end loop;

  -- Localities (one per area) + a conflict on each --------------------------------------
  for r in
    select *
    from (values
      ('tz_pemba_north', 'tz', 'u_col_pemba', 39.74::float8, -5.00::float8),
      ('tz_tanga',       'tz', 'u_col_tanga', 39.05::float8, -5.10::float8),
      ('ke_mombasa',     'ke', 'u_col_ke',    39.65::float8, -4.00::float8)
    ) as t (akey, ckey, ukey, lon, lat)
  loop
    insert into public.localities (id, created_by, country_id, admin_area_id, name_ar, name_latin, geom, status)
    values (tests.id('loc:' || r.akey), tests.id(r.ukey), tests.id(r.ckey), tests.id(r.akey),
            'قرية ' || r.akey, 'Village ' || r.akey, st_setsrid(st_makepoint(r.lon, r.lat), 4326), 'proposed')
    on conflict (id) do nothing;

    insert into public.sync_conflicts
      (id, table_name, row_id, project_id, field, base_version, server_value, client_value,
       client_user_id, client_device_id, state)
    values
      (tests.id('lconflict:' || r.akey), 'localities', tests.id('loc:' || r.akey), null, 'name_latin', 1,
       '"a"'::jsonb, '"b"'::jsonb, tests.id(r.ukey), 'dev-test', 'open')
    on conflict (id) do nothing;
  end loop;

  -- Own-row tables ---------------------------------------------------------------------
  for r in
    select * from (values ('u_col_pemba'), ('u_col_ke'), ('u_hq')) as t (ukey)
  loop
    insert into public.notifications (id, user_id, kind, payload)
    values (tests.id('notif:' || r.ukey), tests.id(r.ukey), 'test.fixture', '{}'::jsonb)
    on conflict (id) do nothing;

    insert into public.export_jobs (id, user_id, format, lang, state)
    values (tests.id('export:' || r.ukey), tests.id(r.ukey), 'csv', 'ar', 'done')
    on conflict (id) do nothing;

    insert into public.import_batches (id, user_id, source_kind, file_name, state, row_count)
    values (tests.id('import:' || r.ukey), tests.id(r.ukey), 'csv', 'fixture.csv', 'staged', 1)
    on conflict (id) do nothing;

    insert into public.import_rows (id, batch_id, row_no, raw)
    values (tests.id('importrow:' || r.ukey), tests.id('import:' || r.ukey), 1, '{"name_ar": "x"}'::jsonb)
    on conflict (id) do nothing;

    insert into public.devices (id, user_id, device_id, label)
    values (tests.id('device:' || r.ukey), tests.id(r.ukey), 'dev-' || r.ukey, 'Fixture device')
    on conflict (id) do nothing;
  end loop;

  -- Reference / admin rows --------------------------------------------------------------
  insert into public.app_settings (id, key, value, is_public)
  values
    (tests.id('setting_public'), 'test.public_setting', '"1"'::jsonb, true),
    (tests.id('setting_private'), 'test.private_setting', '"secret"'::jsonb, false)
  on conflict (id) do nothing;

  insert into public.map_packs (id, code, name_ar, name_en, country_id, storage_path, bytes)
  values (tests.id('map_pack'), 'TEST-PACK', 'حزمة اختبار', 'Test pack', tests.id('tz'), 'packs/test.pmtiles', 1024)
  on conflict (id) do nothing;

  insert into public.option_values (id, list_key, code, name_ar, name_en)
  values (tests.id('option_value'), 'livelihoods', 'test_fixture_option', 'خيار اختبار', 'Test option')
  on conflict (id) do nothing;

  insert into public.fx_rates (id, currency, usd_per_unit, effective_date)
  values (tests.id('fx_rate'), 'XTS', 1, date '2000-01-01')
  on conflict (id) do nothing;

  -- Logs / ledger --------------------------------------------------------------------------
  insert into public.sync_applied_ops (op_id, user_id, device_id, result)
  values (tests.id('applied_op'), tests.id('u_col_pemba'), 'dev-test', '{"status": "applied"}'::jsonb)
  on conflict (op_id) do nothing;

  insert into public.restricted_access_log (user_id, device_id, table_name, row_ids, row_count, context)
  select tests.id('u_mgr_tz'), 'dev-test', 'staff_compensation', array[tests.id('comp:p_pemba_1')], 1, 'tests.fixture_extra'
  where not exists (select 1 from public.restricted_access_log where context = 'tests.fixture_extra');
end;
$$;

-- -----------------------------------------------------------------------------
-- storage.objects rows for the bucket policies (needs the storage schema and
-- the buckets of migration 0015). Calls tests.fixture() first.
--   photos   the full + thumb object of every fixture photo
--   exports  {u_col_pemba}/export.csv, {u_col_ke}/export.csv
--   imports  {u_col_pemba}/import.csv
--   tiles    packs/test.pmtiles
-- -----------------------------------------------------------------------------
create function tests.fixture_storage()
returns void
language plpgsql
set search_path = public, extensions, pg_temp
as $$
begin
  perform tests.fixture();

  insert into storage.objects (bucket_id, name)
  select 'photos', x.name
  from (
    select ph.storage_path_full as name from public.project_photos ph where ph.project_id = any (tests.fixture_projects())
    union all
    select ph.storage_path_thumb from public.project_photos ph where ph.project_id = any (tests.fixture_projects())
  ) x
  where not exists (select 1 from storage.objects o where o.bucket_id = 'photos' and o.name = x.name);

  insert into storage.objects (bucket_id, name)
  select x.bucket_id, x.name
  from (values
    ('exports', tests.id('u_col_pemba')::text || '/export.csv'),
    ('exports', tests.id('u_col_ke')::text || '/export.csv'),
    ('imports', tests.id('u_col_pemba')::text || '/import.csv'),
    ('tiles', 'packs/test.pmtiles')
  ) as x (bucket_id, name)
  where not exists (select 1 from storage.objects o where o.bucket_id = x.bucket_id and o.name = x.name);
end;
$$;

-- Everybody may call the helpers (they are used while acting as API roles).
grant execute on all functions in schema tests to public;

-- =============================================================================
-- Self-test (valid TAP; everything below is rolled back)
-- =============================================================================
begin;
set local search_path = public, extensions, tests;

select plan(14);

select has_schema('tests', 'schema tests exists');
select has_function('tests', 'create_user', array['text', 'text', 'text', 'uuid'], 'tests.create_user(text, text, text, uuid)');
select has_function('tests', 'login_as', array['uuid', 'text', 'text'], 'tests.login_as(uuid, text, text)');
select has_function('tests', 'login_anon', array[]::text[], 'tests.login_anon()');
select has_function('tests', 'logout', array[]::text[], 'tests.logout()');
select has_function('tests', 'fixture', array[]::text[], 'tests.fixture()');
select has_function('tests', 'id', array['text'], 'tests.id(text)');

select lives_ok('select tests.fixture()', 'tests.fixture() runs');
select lives_ok('select tests.fixture()', 'tests.fixture() is idempotent');

select is(
  (select count(*)::int from public.projects where id = any (tests.fixture_projects())),
  4, 'fixture: four projects');
select is(
  (select count(*)::int from public.user_roles where user_id = any (tests.fixture_users()) and deleted_at is null),
  10, 'fixture: ten users with one role each');

select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select is(current_user::text, 'authenticated', 'login_as switches to role authenticated');
select is(auth.uid(), tests.id('u_col_pemba'), 'login_as sets auth.uid()');
select tests.logout();
select isnt(current_user::text, 'authenticated', 'logout returns to the privileged role');

select * from finish();
rollback;

-- =============================================================================
-- 21  sync_push: idempotency, insert/update/delete, authorisation, workflow
--     (workflow rules also govern deletes: sections E, F, J)
--     (docs/contracts/sync.md; migration 0023)
-- =============================================================================
begin;
set local search_path = public, extensions, tests;

select plan(119);

do $$ begin perform tests.fixture(); end $$;

-- -----------------------------------------------------------------------------
-- Helpers (session-local, rolled back with the transaction)
-- -----------------------------------------------------------------------------
create temp table res (k text primary key, v jsonb) on commit drop;
create temp table ops (k text primary key, v jsonb) on commit drop;

-- ids of rows created by this file
create function pg_temp.nid(p_n integer) returns uuid language sql immutable as
$fn$ select ('00000000-0000-7000-9000-' || lpad(p_n::text, 12, '0'))::uuid $fn$;

create function pg_temp.op(
  p_n integer, p_table text, p_id uuid, p_base integer, p_fields jsonb, p_kind text default 'upsert')
returns jsonb language sql immutable as
$fn$
  select jsonb_build_object(
    'op_id', ('00000000-0000-7000-8000-' || lpad(p_n::text, 12, '0'))::uuid,
    'table', p_table, 'id', p_id, 'kind', p_kind, 'base_version', p_base,
    'fields', coalesce(p_fields, '{}'::jsonb), 'client_ts', '2026-10-03T10:00:00Z');
$fn$;

-- push as an end user (role authenticated + JWT + x-device-id header)
create function pg_temp.push(p_user uuid, p_device text, p_ops jsonb, p_aal text default 'aal1')
returns jsonb language plpgsql as
$fn$
declare
  r jsonb;
begin
  perform tests.login_as(p_user, p_aal, p_device);
  r := public.sync_push(p_ops, p_device);
  perform tests.logout();
  return r;
end;
$fn$;

create function pg_temp.st(p_k text) returns text[] language sql stable as
$fn$
  select array_agg(e.value ->> 'status' order by e.ord)
  from res, jsonb_array_elements(res.v -> 'results') with ordinality as e(value, ord)
  where res.k = p_k;
$fn$;

create function pg_temp.err(p_k text, p_i integer) returns text language sql stable as
$fn$ select res.v -> 'results' -> p_i -> 'error' ->> 'code' from res where res.k = p_k $fn$;

create function pg_temp.r(p_k text, p_i integer) returns jsonb language sql stable as
$fn$ select res.v -> 'results' -> p_i from res where res.k = p_k $fn$;

create function pg_temp.ver(p_table text, p_id uuid) returns integer language plpgsql stable as
$fn$
declare
  v integer;
begin
  execute format('select version from public.%I where id = $1', p_table) into v using p_id;
  return v;
end;
$fn$;

insert into public.devices (user_id, device_id, label)
values (tests.id('u_col_pemba'), 'dev-a', 'Collector phone A');

-- =============================================================================
-- A. Insert path, server-managed columns, idempotent replay
-- =============================================================================
insert into ops
select 'a', jsonb_build_array(
  pg_temp.op(1, 'projects', pg_temp.nid(1), 0, jsonb_build_object(
    'name_ar', 'مسجد النور', 'name_latin', 'Masjid An-Nur', 'type', 'mosque', 'status', 'active',
    'capacity', 150, 'lon', 39.7123456, 'lat', -5.0123456, 'gps_accuracy_m', 6.5,
    'location_source', 'gps', 'country_id', tests.id('tz'), 'build_year', 2012,
    -- everything below is server-managed and must be ignored
    'code', 'HACK-000001', 'version', 99, 'created_by', tests.id('u_hq'), 'completeness', 7,
    'search_norm', 'zzz', 'deleted_at', '2020-01-01T00:00:00Z', 'reviewed_by', tests.id('u_hq'),
    'import_batch_id', pg_temp.nid(999), 'sync_xid', 1, 'geom', 'SRID=4326;POINT(0 0)',
    -- not a column at all
    'bogus', 1)),
  pg_temp.op(2, 'project_land', pg_temp.nid(2), 0, jsonb_build_object(
    'project_id', pg_temp.nid(1), 'ownership', 'waqf', 'area_m2', 900.5, 'expandable', true)),
  pg_temp.op(3, 'project_facilities', pg_temp.nid(3), 0, jsonb_build_object(
    'project_id', pg_temp.nid(1), 'library', true, 'quran_count', 40, 'quran_need', 60)),
  pg_temp.op(4, 'persons', pg_temp.nid(4), 0, jsonb_build_object(
    'name_ar', 'عبد الله سالم', 'name_latin', 'Abdallah Salim', 'phone_e164', '+255712345678', 'gender', 'male')),
  pg_temp.op(5, 'project_staff', pg_temp.nid(5), 0, jsonb_build_object(
    'project_id', pg_temp.nid(1), 'person_id', pg_temp.nid(4), 'role', 'imam', 'start_date', '2020-02-01')),
  pg_temp.op(6, 'project_maintenance', pg_temp.nid(6), 0, jsonb_build_object(
    'project_id', pg_temp.nid(1), 'description', 'Roof leak', 'priority', 'high',
    'estimated_cost', 1200, 'currency', 'USD')),
  pg_temp.op(7, 'project_photos', pg_temp.nid(7), 0, jsonb_build_object(
    'project_id', pg_temp.nid(1),
    'storage_path_full', 'projects/TZ/' || pg_temp.nid(1) || '/' || pg_temp.nid(7) || '_full.webp',
    'storage_path_thumb', 'projects/TZ/' || pg_temp.nid(1) || '/' || pg_temp.nid(7) || '_thumb.webp',
    'width', 1600, 'height', 1200, 'bytes', 200000, 'is_cover', true, 'category', 'mosque_front')),
  pg_temp.op(8, 'community_profiles', pg_temp.nid(8), 0, jsonb_build_object(
    'project_id', pg_temp.nid(1), 'population', 2500, 'muslim_pct', 85.5)),
  pg_temp.op(9, 'community_sensitive', pg_temp.nid(9), 0, jsonb_build_object(
    'project_id', pg_temp.nid(1), 'ibadi_families', 12, 'guest_financial_capacity', 'limited')),
  pg_temp.op(10, 'staff_compensation', pg_temp.nid(10), 0, jsonb_build_object(
    'project_staff_id', pg_temp.nid(5), 'monthly_amount', 250000, 'currency', 'TZS',
    'effective_from', '2025-01-01')),
  pg_temp.op(11, 'donors', pg_temp.nid(11), 0, jsonb_build_object('name_ar', 'متبرع كريم')),
  pg_temp.op(12, 'project_donors', pg_temp.nid(12), 0, jsonb_build_object(
    'project_id', pg_temp.nid(1), 'donor_id', pg_temp.nid(11), 'amount', 5000, 'currency', 'USD', 'year', 2012)));

insert into res
select 'a1', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', (select v from ops where k = 'a'));

select is(pg_temp.st('a1'), array_fill('applied'::text, array[12]),
  'insert: a project with all its children is applied in one batch (parent before child)');

select ok((select res.v ? 'server_time' from res where k = 'a1'), 'response carries server_time');

select is(
  (select row(p.created_by, p.branch_id, p.country_id, p.admin_area_id, p.record_state, p.deleted_at, p.reviewed_by,
              p.import_batch_id)::text
   from public.projects p where p.id = pg_temp.nid(1)),
  row(tests.id('u_col_pemba'), tests.id('br_pemba'), tests.id('tz'), tests.id('tz_pemba_north'), 'draft'::text,
      null::timestamptz, null::uuid, null::uuid)::text,
  'insert: creator = caller, branch defaulted from the single branch scope, area derived, protected columns ignored');

select ok(
  (select p.code like 'TZ-PN-%' and p.search_norm <> 'zzz' and p.completeness = 100
   from public.projects p where p.id = pg_temp.nid(1)),
  'insert: code, search_norm and completeness are computed by the server');

select is(
  (select array[st_x(p.geom), st_y(p.geom)] from public.projects p where p.id = pg_temp.nid(1)),
  array[39.7123456, -5.0123456]::double precision[],
  'insert: lon/lat become the point geometry (client geom is ignored)');

select is(
  (select st_srid(p.geom) from public.projects p where p.id = pg_temp.nid(1)), 4326, 'geometry SRID is 4326');

select is(pg_temp.r('a1', 0) -> 'ignored_fields', '["bogus"]'::jsonb,
  'unknown field names are reported, server-managed ones are dropped silently');

select is(
  (select row(pe.country_id, pe.branch_id, pe.created_by)::text from public.persons pe where pe.id = pg_temp.nid(4)),
  row(tests.id('tz'), tests.id('br_pemba'), tests.id('u_col_pemba'))::text,
  'person: country and branch default from the caller''s scope');

select is(
  (select array_agg(key order by key) from jsonb_object_keys(pg_temp.r('a1', 8)) as key),
  array['op_id', 'status', 'version'],
  'restricted insert (community_sensitive): the result echoes no stored value');

select is(
  (select array_agg(key order by key) from jsonb_object_keys(pg_temp.r('a1', 9)) as key),
  array['op_id', 'status', 'version'],
  'restricted insert (staff_compensation): the result echoes no stored value');

select is(
  (select row(a.user_id, a.device_id)::text from public.audit_log a
   where a.table_name = 'projects' and a.row_id = pg_temp.nid(1) and a.op = 'INSERT'),
  row(tests.id('u_col_pemba'), 'dev-a'::text)::text,
  'audit_log records the user and the device of the push');

select is(
  (select count(*)::int from public.sync_applied_ops o where o.device_id = 'dev-a'), 12,
  'ledger: one row per applied operation');

-- replay the identical batch -----------------------------------------------------
insert into res
select 'a2', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', (select v from ops where k = 'a'));

select is(pg_temp.st('a2'), array_fill('duplicate'::text, array[12]),
  'replay of the same batch: every operation is reported as duplicate');

select is(pg_temp.r('a2', 0) ->> 'original_status', 'applied', 'duplicate: the stored outcome is returned');

select is(
  (select (select count(*) from public.projects where id = pg_temp.nid(1))
        + (select count(*) from public.project_land where project_id = pg_temp.nid(1))
        + (select count(*) from public.project_staff where project_id = pg_temp.nid(1))
        + (select count(*) from public.project_photos where project_id = pg_temp.nid(1))
        + (select count(*) from public.persons where id = pg_temp.nid(4))
        + (select count(*) from public.community_sensitive where project_id = pg_temp.nid(1))
        + (select count(*) from public.staff_compensation where project_staff_id = pg_temp.nid(5)))::int,
  7, 'replay: no duplicate rows');

select is(
  (select count(*)::int from public.audit_log a
   where a.table_name = 'projects' and a.row_id = pg_temp.nid(1) and a.op = 'INSERT'),
  1, 'replay: nothing was written again');

select ok(
  (select d.last_push_at is not null from public.devices d
   where d.user_id = tests.id('u_col_pemba') and d.device_id = 'dev-a'),
  'devices.last_push_at is maintained');

-- =============================================================================
-- B. Update, version bumps, soft delete
-- =============================================================================
insert into res select 'b0', to_jsonb(pg_temp.ver('projects', pg_temp.nid(1)));

insert into res
select 'b1', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(20, 'projects', pg_temp.nid(1), pg_temp.ver('projects', pg_temp.nid(1)),
             jsonb_build_object('name_latin', 'Masjid Nur', 'capacity', '200'))));

select is(pg_temp.st('b1'), array['applied'], 'update with base_version = current version is applied');

select is(
  (pg_temp.r('b1', 0) ->> 'version')::int, (select (v #>> '{}')::int + 1 from res where k = 'b0'),
  'update bumps the version by one and returns it');

select is(
  (select row(p.name_latin, p.capacity, p.version)::text from public.projects p where p.id = pg_temp.nid(1)),
  row('Masjid Nur'::text, 200, (pg_temp.r('b1', 0) ->> 'version')::int)::text,
  'update: values stored (JSON string coerced to integer)');

insert into res
select 'b2', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(21, 'projects', pg_temp.nid(1), pg_temp.ver('projects', pg_temp.nid(1)),
             jsonb_build_object('name_latin', 'Masjid Nur', 'capacity', 200))));

select is(
  (pg_temp.r('b2', 0) ->> 'version')::int, (pg_temp.r('b1', 0) ->> 'version')::int,
  'update that changes nothing: applied without a new version');

insert into res
select 'b3', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(22, 'project_maintenance', pg_temp.nid(6), 1, null, 'delete')));

select is(pg_temp.st('b3'), array['applied'], 'delete is applied');
select ok(
  (select m.deleted_at is not null and m.version = 2 from public.project_maintenance m where m.id = pg_temp.nid(6)),
  'delete is soft: deleted_at set, version bumped, row kept');

insert into res
select 'b4', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(23, 'project_maintenance', pg_temp.nid(6), 2, null, 'delete'),
  pg_temp.op(24, 'project_maintenance', pg_temp.nid(4040), 0, null, 'delete'),
  pg_temp.op(25, 'project_maintenance', pg_temp.nid(6), 2, jsonb_build_object('description', 'again'))));

select is(pg_temp.st('b4'), array['applied', 'applied', 'rejected'],
  'deleting twice / deleting an unknown row is a no-op; editing a deleted row is rejected');
select is((pg_temp.r('b4', 0) ->> 'version')::int, 2, 'second delete does not bump the version');
select is(pg_temp.err('b4', 2), 'row_deleted', 'edit of a deleted row: row_deleted');

-- =============================================================================
-- C. A rejected operation does not abort the batch
-- =============================================================================
insert into res
select 'c1', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(30, 'projects', pg_temp.nid(1), pg_temp.ver('projects', pg_temp.nid(1)),
             jsonb_build_object('builder', 'Istiqama')),
  pg_temp.op(31, 'no_such_table', pg_temp.nid(31), 0, '{}'::jsonb),
  pg_temp.op(32, 'projects', pg_temp.nid(32), 0, jsonb_build_object(
    'name_ar', 'مدرسة', 'type', 'castle', 'lon', 39.72, 'lat', -5.02)),
  pg_temp.op(33, 'project_maintenance', pg_temp.nid(33), 0, jsonb_build_object(
    'project_id', pg_temp.nid(1), 'description', 'Paint')),
  jsonb_build_object('op_id', 'not-a-uuid', 'table', 'projects', 'id', pg_temp.nid(34)),
  pg_temp.op(35, 'projects', pg_temp.nid(35), 0, jsonb_build_object(
    'name_ar', 'مدرسة', 'type', 'school', 'lon', 539.72, 'lat', -5.02)),
  pg_temp.op(36, 'projects', pg_temp.nid(36), 0, jsonb_build_object(
    'name_ar', 'مدرسة', 'type', 'school', 'capacity', 'many'))));

select is(pg_temp.st('c1'),
  array['applied', 'rejected', 'rejected', 'applied', 'rejected', 'rejected', 'rejected'],
  'bad operations are rejected one by one, the good ones in the same batch are applied');

select is(
  array[pg_temp.err('c1', 1), pg_temp.err('c1', 2), pg_temp.err('c1', 4), pg_temp.err('c1', 5), pg_temp.err('c1', 6)],
  array['unknown_table', 'check_violation', 'invalid_op', 'invalid_coordinates', 'invalid_value'],
  'rejections carry a machine-readable error code');

select is(pg_temp.r('c1', 2) #>> '{error,constraint}', 'projects_type_ck',
  'constraint violations name the constraint');

select ok(
  (select p.builder = 'Istiqama' from public.projects p where p.id = pg_temp.nid(1))
  and exists (select 1 from public.project_maintenance m where m.id = pg_temp.nid(33))
  and not exists (select 1 from public.projects p where p.id in (pg_temp.nid(32), pg_temp.nid(35), pg_temp.nid(36))),
  'the applied operations are stored, the rejected ones left nothing behind');

select is(
  (select count(*)::int from public.sync_applied_ops o
   where o.op_id in ('00000000-0000-7000-8000-000000000031', '00000000-0000-7000-8000-000000000032')),
  0, 'rejected operations are not recorded in the ledger');

select is(
  (select array_agg(r.code order by r.code) from private.sync_rejections r
   where r.user_id = tests.id('u_col_pemba') and r.device_id = 'dev-a'),
  array['check_violation', 'invalid_coordinates', 'invalid_op', 'invalid_value', 'row_deleted', 'unknown_table'],
  'rejected operations are logged for the sync-status board (private.sync_rejections)');

-- ... and the board (sync_status(), migration 0045) reports them per user and device
create function pg_temp.status_of(p_user uuid) returns jsonb language plpgsql as
$fn$
declare
  r jsonb;
begin
  perform tests.login_as(tests.id('u_hq'), 'aal2', 'dev-hq');
  r := public.sync_status();
  perform tests.logout();
  return (select u from jsonb_array_elements(r -> 'users') u where (u ->> 'user_id')::uuid = p_user);
end;
$fn$;

select is(
  (select jsonb_build_object(
            'user', s -> 'rejected_7d',
            'device', (select d -> 'rejected_7d' from jsonb_array_elements(s -> 'devices') d
                       where d ->> 'device_id' = 'dev-a'))
   from pg_temp.status_of(tests.id('u_col_pemba')) s),
  '{"user": 6, "device": 6}'::jsonb,
  'sync_status(): the six operations rejected by sync_push are counted as rejected_7d of the user and of the device');

insert into res
select 'c2', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(32, 'projects', pg_temp.nid(32), 0, jsonb_build_object(
    'name_ar', 'مدرسة', 'type', 'school', 'lon', 39.72, 'lat', -5.02))));

select is(pg_temp.st('c2'), array['applied'], 'a rejected op_id can be retried once the payload is fixed');

select throws_ok(
  format($q$select pg_temp.push(%L::uuid, 'dev-a',
           (select jsonb_agg(pg_temp.op(1000 + g, 'donors', pg_temp.nid(1000 + g), 0, '{"name_ar": "x"}'::jsonb))
            from generate_series(1, 51) g))$q$, tests.id('u_col_pemba')),
  'PT422', 'too_many_ops', 'more than 50 operations per call are refused (PT422)');

insert into res
select 'c3', pg_temp.push(tests.id('u_col_pemba'), 'dev-a',
  (select jsonb_agg(pg_temp.op(1000 + g, 'donors', pg_temp.nid(1000 + g), 0,
                               jsonb_build_object('name_latin', 'Donor ' || g)))
   from generate_series(1, 50) g));

select is(pg_temp.st('c3'), array_fill('applied'::text, array[50]), 'a batch of exactly 50 operations is accepted');

select throws_ok(
  format($q$select pg_temp.push(%L::uuid, 'dev-a', '{"not": "an array"}'::jsonb)$q$, tests.id('u_col_pemba')),
  'PT422', 'invalid_ops', 'p_ops must be an array');

create function pg_temp.push_mismatch(p_user uuid) returns jsonb language plpgsql as
$fn$
begin
  perform tests.login_as(p_user, 'aal1', 'dev-header');
  return public.sync_push('[]'::jsonb, 'dev-argument');
end;
$fn$;

select throws_ok(
  format($q$select pg_temp.push_mismatch(%L::uuid)$q$, tests.id('u_col_pemba')),
  'PT422', 'device_mismatch', 'x-device-id header and p_device_id must name the same device');

-- =============================================================================
-- D. Authorisation
-- =============================================================================
-- a Kenyan collector cannot write into Tanzania
insert into res
select 'd1', pg_temp.push(tests.id('u_col_ke'), 'dev-k', jsonb_build_array(
  pg_temp.op(40, 'projects', pg_temp.nid(40), 0, jsonb_build_object(
    'name_ar', 'اختراق', 'type', 'mosque', 'lon', 39.72, 'lat', -5.02,
    'country_id', tests.id('tz'), 'branch_id', tests.id('br_pemba'))),
  pg_temp.op(41, 'projects', pg_temp.nid(41), 0, jsonb_build_object(
    'name_ar', 'اختراق', 'type', 'mosque', 'lon', 39.72, 'lat', -5.02)),
  pg_temp.op(42, 'projects', tests.id('p_pemba_2'), 1, jsonb_build_object('name_ar', 'اختراق')),
  pg_temp.op(43, 'project_maintenance', pg_temp.nid(43), 0, jsonb_build_object(
    'project_id', tests.id('p_pemba_1'), 'description', 'x')),
  pg_temp.op(44, 'persons', pg_temp.nid(44), 0, jsonb_build_object(
    'name_ar', 'اختراق', 'country_id', tests.id('tz'), 'branch_id', tests.id('br_pemba'))),
  pg_temp.op(45, 'community_sensitive', pg_temp.nid(45), 0, jsonb_build_object(
    'project_id', tests.id('p_tanga_1'), 'ibadi_families', 1)),
  pg_temp.op(46, 'projects', tests.id('p_pemba_2'), 1, null, 'delete')));

select is(pg_temp.st('d1'), array_fill('rejected'::text, array[7]),
  'a collector of another country cannot insert, update or delete anything in Tanzania');

select is(
  array[pg_temp.err('d1', 0), pg_temp.err('d1', 1), pg_temp.err('d1', 2), pg_temp.err('d1', 3),
        pg_temp.err('d1', 4), pg_temp.err('d1', 5), pg_temp.err('d1', 6)],
  array['out_of_scope', 'branch_country_mismatch', 'out_of_scope', 'out_of_scope', 'out_of_scope',
        'out_of_scope', 'out_of_scope'],
  'cross-country writes: out_of_scope (a point inside another country is caught after the area is derived)');

select ok(
  not exists (select 1 from public.projects p where p.id in (pg_temp.nid(40), pg_temp.nid(41)))
  and not exists (select 1 from public.persons pe where pe.id = pg_temp.nid(44))
  and (select p.name_ar <> 'اختراق' and p.deleted_at is null from public.projects p where p.id = tests.id('p_pemba_2')),
  'cross-country writes left no trace');

-- same branch, but not the creator
insert into res
select 'd2', pg_temp.push(tests.id('u_col_pemba2'), 'dev-b', jsonb_build_array(
  pg_temp.op(50, 'projects', tests.id('p_pemba_2'), 1, jsonb_build_object('name_ar', 'تعديل')),
  pg_temp.op(51, 'projects', tests.id('p_pemba_2'), 1, null, 'delete'),
  pg_temp.op(52, 'project_land', pg_temp.nid(52), 0, jsonb_build_object(
    'project_id', tests.id('p_pemba_2'), 'ownership', 'waqf')),
  pg_temp.op(53, 'project_maintenance', pg_temp.nid(53), 0, jsonb_build_object(
    'project_id', tests.id('p_pemba_2'), 'description', 'Door')),
  pg_temp.op(54, 'project_photos', pg_temp.nid(54), 0, jsonb_build_object(
    'project_id', tests.id('p_pemba_2'), 'category', 'land')),
  pg_temp.op(55, 'project_maintenance', tests.id('maint:p_pemba_2'), 1, jsonb_build_object('state', 'done')),
  pg_temp.op(56, 'persons', tests.id('person:p_pemba_2'), pg_temp.ver('persons', tests.id('person:p_pemba_2')),
             jsonb_build_object('graduated_from', 'Zanzibar')),
  pg_temp.op(57, 'persons', tests.id('person:p_pemba_2'), pg_temp.ver('persons', tests.id('person:p_pemba_2')) + 1,
             null, 'delete')));

select is(pg_temp.st('d2'),
  array['rejected', 'rejected', 'rejected', 'applied', 'applied', 'rejected', 'applied', 'rejected'],
  'a collector edits only what he created; maintenance entries and photos may be added to any project in scope');

select is(
  array[pg_temp.err('d2', 0), pg_temp.err('d2', 1), pg_temp.err('d2', 2), pg_temp.err('d2', 5), pg_temp.err('d2', 7)],
  array_fill('not_owner'::text, array[5]),
  'editing somebody else''s project, child or entry: not_owner');

select ok(
  (select ph.storage_path_full like 'projects/TZ/%_full.webp' and ph.created_by = tests.id('u_col_pemba2')
   from public.project_photos ph where ph.id = pg_temp.nid(54)),
  'photo added by another collector of the branch (paths defaulted by the server)');

-- the branch supervisor may change other people's records in the branch
insert into res
select 'd3', pg_temp.push(tests.id('u_sup_pemba'), 'dev-s', jsonb_build_array(
  pg_temp.op(60, 'project_maintenance', tests.id('maint:p_pemba_2'),
             pg_temp.ver('project_maintenance', tests.id('maint:p_pemba_2')), jsonb_build_object('state', 'done')),
  pg_temp.op(61, 'projects', tests.id('p_pemba_2'), pg_temp.ver('projects', tests.id('p_pemba_2')),
             jsonb_build_object('builder', 'Supervisor')),
  pg_temp.op(62, 'projects', tests.id('p_tanga_1'), 1, jsonb_build_object('builder', 'Supervisor'))));

select is(pg_temp.st('d3'), array['applied', 'applied', 'rejected'],
  'a branch supervisor edits records of his branch, not of another branch');
select is(pg_temp.err('d3', 2), 'out_of_scope', 'supervisor outside his branch: out_of_scope');

-- another branch, a viewer, reference tables, ordering, immutable parent
insert into res
select 'd4', pg_temp.push(tests.id('u_col_tanga'), 'dev-t', jsonb_build_array(
  pg_temp.op(63, 'project_maintenance', pg_temp.nid(63), 0, jsonb_build_object(
    'project_id', tests.id('p_pemba_2'), 'description', 'x')),
  pg_temp.op(64, 'projects', pg_temp.nid(64), 0, jsonb_build_object(
    'name_ar', 'مسجد', 'type', 'mosque', 'lon', 39.10, 'lat', -5.05, 'branch_id', tests.id('br_pemba')))));

select is(array[pg_temp.err('d4', 0), pg_temp.err('d4', 1)], array['out_of_scope', 'out_of_scope'],
  'a collector of another branch of the same country is out of scope');

insert into res
select 'd5', pg_temp.push(tests.id('u_viewer_tz'), 'dev-v', jsonb_build_array(
  pg_temp.op(65, 'project_maintenance', pg_temp.nid(65), 0, jsonb_build_object(
    'project_id', tests.id('p_pemba_2'), 'description', 'x')),
  pg_temp.op(66, 'donors', pg_temp.nid(66), 0, jsonb_build_object('name_ar', 'x')),
  pg_temp.op(67, 'projects', pg_temp.nid(67), 0, jsonb_build_object(
    'name_ar', 'x', 'type', 'mosque', 'country_id', tests.id('tz')))));

select is(array[pg_temp.err('d5', 0), pg_temp.err('d5', 1), pg_temp.err('d5', 2)],
  array['out_of_scope', 'out_of_scope', 'out_of_scope'], 'a viewer cannot write anything');

insert into res
select 'd6', pg_temp.push(tests.id('u_hq'), 'dev-h', jsonb_build_array(
  pg_temp.op(68, 'countries', tests.id('tz'), 1, jsonb_build_object('name_ar', 'x')),
  pg_temp.op(69, 'sync_conflicts', pg_temp.nid(69), 0, jsonb_build_object('field', 'x')),
  pg_temp.op(70, 'project_land', pg_temp.nid(70), 0, jsonb_build_object(
    'project_id', pg_temp.nid(7070), 'ownership', 'waqf')),
  pg_temp.op(71, 'project_land', pg_temp.nid(2), 1, jsonb_build_object('project_id', tests.id('p_pemba_2')))), 'aal2');

select is(
  array[pg_temp.err('d6', 0), pg_temp.err('d6', 1), pg_temp.err('d6', 2), pg_temp.err('d6', 3)],
  array['table_not_writable', 'table_not_writable', 'parent_missing', 'immutable_field'],
  'reference tables and sync_conflicts are not writable through push; missing parent; parent link is immutable');

-- an hq_admin without MFA has no effective role
insert into res
select 'd7', pg_temp.push(tests.id('u_hq'), 'dev-h', jsonb_build_array(
  pg_temp.op(72, 'donors', pg_temp.nid(72), 0, jsonb_build_object('name_ar', 'x'))), 'aal1');
select is(pg_temp.err('d7', 0), 'out_of_scope', 'hq_admin at aal1 (no MFA) cannot write');

-- =============================================================================
-- E. record_state workflow
-- =============================================================================
insert into res
select 'e1', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(80, 'projects', pg_temp.nid(1), pg_temp.ver('projects', pg_temp.nid(1)),
             jsonb_build_object('record_state', 'submitted')),
  pg_temp.op(81, 'projects', pg_temp.nid(1), pg_temp.ver('projects', pg_temp.nid(1)) + 1,
             jsonb_build_object('record_state', 'approved'))));

select is(pg_temp.st('e1'), array['applied', 'rejected'], 'collector: draft -> submitted is allowed, -> approved is not');
select is(pg_temp.err('e1', 1), 'forbidden_transition', 'collector approving: forbidden_transition');
select is((select record_state from public.projects where id = pg_temp.nid(1)), 'submitted', 'state is submitted');

insert into res
select 'e2', pg_temp.push(tests.id('u_sup_pemba'), 'dev-s', jsonb_build_array(
  pg_temp.op(82, 'projects', pg_temp.nid(1), pg_temp.ver('projects', pg_temp.nid(1)),
             jsonb_build_object('record_state', 'approved', 'review_note', 'ok'))));

select is(pg_temp.st('e2'), array['applied'], 'supervisor: submitted -> approved');
select is(
  (select row(p.record_state, p.review_note, p.reviewed_by, p.reviewed_at is not null)::text
   from public.projects p where p.id = pg_temp.nid(1)),
  row('approved'::text, 'ok'::text, tests.id('u_sup_pemba'), true)::text,
  'approval stamps reviewed_by / reviewed_at and stores the note');

insert into res
select 'e3', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(83, 'projects', pg_temp.nid(1), pg_temp.ver('projects', pg_temp.nid(1)),
             jsonb_build_object('capacity', 300, 'review_note', 'hacked', 'record_state', 'approved'))));

select is(pg_temp.st('e3'), array['applied'], 'collector edits his approved record');
select is(
  (select row(p.record_state, p.capacity, p.review_note)::text from public.projects p where p.id = pg_temp.nid(1)),
  row('submitted'::text, 300, 'ok'::text)::text,
  'a collector edit of an approved record sends it back to submitted; review_note is a reviewer field');

insert into res
select 'e4', pg_temp.push(tests.id('u_sup_pemba'), 'dev-s', jsonb_build_array(
  pg_temp.op(84, 'projects', pg_temp.nid(1), pg_temp.ver('projects', pg_temp.nid(1)),
             jsonb_build_object('record_state', 'returned', 'review_note', 'fix the name'))));
insert into res
select 'e5', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(85, 'projects', pg_temp.nid(1), pg_temp.ver('projects', pg_temp.nid(1)),
             jsonb_build_object('record_state', 'draft')),
  pg_temp.op(86, 'projects', pg_temp.nid(1), pg_temp.ver('projects', pg_temp.nid(1)),
             jsonb_build_object('record_state', 'submitted', 'name_latin', 'Masjid An-Nur (fixed)'))));

select is(pg_temp.st('e4') || pg_temp.st('e5'), array['applied', 'rejected', 'applied'],
  'supervisor returns; collector cannot go back to draft but may resubmit');
select is(pg_temp.err('e5', 0), 'invalid_transition', 'returned -> draft: invalid_transition');
select is(
  (select row(p.record_state, p.review_note)::text from public.projects p where p.id = pg_temp.nid(1)),
  row('submitted'::text, 'fix the name'::text)::text, 'resubmitted, the reviewer''s note is kept');

-- children that describe the project follow the same rule
insert into res
select 'e6', pg_temp.push(tests.id('u_sup_pemba'), 'dev-s', jsonb_build_array(
  pg_temp.op(87, 'projects', pg_temp.nid(1), pg_temp.ver('projects', pg_temp.nid(1)),
             jsonb_build_object('record_state', 'approved'))));
insert into res
select 'e7', pg_temp.push(tests.id('u_col_pemba2'), 'dev-b', jsonb_build_array(
  pg_temp.op(88, 'project_maintenance', pg_temp.nid(88), 0, jsonb_build_object(
    'project_id', pg_temp.nid(1), 'description', 'Window'))));
select is(
  (select record_state from public.projects where id = pg_temp.nid(1)), 'approved',
  'adding a maintenance entry does not un-approve the project');

insert into res
select 'e8', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(89, 'project_land', pg_temp.nid(2), pg_temp.ver('project_land', pg_temp.nid(2)),
             jsonb_build_object('notes', 'boundary wall added'))));
select is(pg_temp.st('e8'), array['applied'], 'creator edits the land record of his approved project');
select is(
  (select record_state from public.projects where id = pg_temp.nid(1)), 'submitted',
  'editing a describing child of an approved project sends the project back to submitted');

insert into res
select 'e9', pg_temp.push(tests.id('u_sup_pemba'), 'dev-s', jsonb_build_array(
  pg_temp.op(90, 'projects', tests.id('p_tanga_1'), 1, jsonb_build_object('record_state', 'returned'))));
select is(pg_temp.err('e9', 0), 'out_of_scope', 'a supervisor cannot review a project of another branch');

insert into res
select 'e10', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(91, 'projects', pg_temp.nid(91), 0, jsonb_build_object(
    'name_ar', 'بلا موقع', 'type', 'school', 'country_id', tests.id('tz'), 'record_state', 'submitted')),
  pg_temp.op(92, 'projects', pg_temp.nid(92), 0, jsonb_build_object(
    'name_ar', 'بلا موقع', 'type', 'school', 'country_id', tests.id('tz')))));
select is(pg_temp.st('e10'), array['rejected', 'applied'],
  'a record without a location can be saved as draft but not submitted');
select is(pg_temp.r('e10', 0) #>> '{error,constraint}', 'projects_geom_required_ck',
  'the violated rule is named in the error');

-- deleting is a workflow decision as well (the delete path runs the guard):
-- a collector deletes his record only while it is draft or returned
insert into res
select 'e11', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(93, 'projects', tests.id('p_pemba_1'), 0, null, 'delete'),
  pg_temp.op(94, 'projects', pg_temp.nid(1), pg_temp.ver('projects', pg_temp.nid(1)), null, 'delete'),
  pg_temp.op(95, 'projects', pg_temp.nid(92), pg_temp.ver('projects', pg_temp.nid(92)), null, 'delete')));
select is(pg_temp.st('e11'), array['rejected', 'rejected', 'applied'],
  'collector delete: his approved and his submitted record are refused, his draft is deleted');
select ok(
  pg_temp.err('e11', 0) = 'forbidden_transition' and pg_temp.err('e11', 1) = 'forbidden_transition'
  and (select p.record_state = 'approved' and p.deleted_at is null from public.projects p where p.id = tests.id('p_pemba_1'))
  and (select p.record_state = 'submitted' and p.deleted_at is null from public.projects p where p.id = pg_temp.nid(1))
  and (select p.deleted_at is not null from public.projects p where p.id = pg_temp.nid(92)),
  'deleting a submitted or approved record needs a reviewer (forbidden_transition) and leaves it untouched');

insert into res
select 'e12', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(96, 'projects', pg_temp.nid(96), 0, jsonb_build_object(
    'name_ar', 'مكرر', 'type', 'school', 'lon', 39.73, 'lat', -5.03, 'record_state', 'submitted'))));
insert into res
select 'e13', pg_temp.push(tests.id('u_sup_pemba'), 'dev-s', jsonb_build_array(
  pg_temp.op(97, 'projects', pg_temp.nid(96), pg_temp.ver('projects', pg_temp.nid(96)),
             jsonb_build_object('record_state', 'returned', 'review_note', 'duplicate')),
  pg_temp.op(98, 'projects', tests.id('p_pemba_1'), pg_temp.ver('projects', tests.id('p_pemba_1')), null, 'delete')));
insert into res
select 'e14', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(99, 'projects', pg_temp.nid(96), pg_temp.ver('projects', pg_temp.nid(96)), null, 'delete')));
select is(pg_temp.st('e12') || pg_temp.st('e13') || pg_temp.st('e14'), array['applied', 'applied', 'applied', 'applied'],
  'a record returned to its collector may be withdrawn by him; a reviewer deletes an approved record');
select ok(
  (select p.deleted_at is not null and p.record_state = 'returned' from public.projects p where p.id = pg_temp.nid(96))
  and (select p.deleted_at is not null and p.record_state = 'approved' from public.projects p where p.id = tests.id('p_pemba_1')),
  'both deletes are stored (soft)');

-- =============================================================================
-- F. Localities: collectors propose, reviewers approve
-- =============================================================================
insert into res
select 'f1', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(100, 'localities', pg_temp.nid(100), 0, jsonb_build_object(
    'name_latin', 'Kijiji A', 'lon', 39.74, 'lat', -5.01, 'status', 'approved')),
  pg_temp.op(101, 'localities', pg_temp.nid(101), 0, jsonb_build_object(
    'name_latin', 'Kijiji B', 'lon', 39.74, 'lat', -5.01))));

select is(pg_temp.st('f1'), array['rejected', 'applied'], 'a collector may only propose a locality');
select is(pg_temp.err('f1', 0), 'forbidden_transition', 'collector inserting an approved locality: forbidden_transition');
select is(
  (select row(l.status, l.country_id, l.admin_area_id, l.approved_by, st_x(l.geom), st_y(l.geom))::text
   from public.localities l where l.id = pg_temp.nid(101)),
  row('proposed'::text, tests.id('tz'), tests.id('tz_pemba_north'), null::uuid, 39.74::float8, -5.01::float8)::text,
  'proposed locality: country defaulted, area derived, lon/lat stored');

insert into res
select 'f2', pg_temp.push(tests.id('u_sup_pemba'), 'dev-s', jsonb_build_array(
  pg_temp.op(102, 'localities', pg_temp.nid(101), 1, jsonb_build_object('status', 'approved'))));
select is(
  (select row(l.status, l.approved_by, l.approved_at is not null)::text
   from public.localities l where l.id = pg_temp.nid(101)),
  row('approved'::text, tests.id('u_sup_pemba'), true)::text,
  'a supervisor approves the locality (approved_by / approved_at stamped)');

insert into res
select 'f3', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(103, 'localities', pg_temp.nid(101), 2, jsonb_build_object('name_latin', 'Kijiji C'))));
select is(pg_temp.err('f3', 0), 'locality_locked', 'an approved locality can only be changed by a reviewer');

insert into res
select 'f4', pg_temp.push(tests.id('u_col_ke'), 'dev-k', jsonb_build_array(
  pg_temp.op(104, 'localities', pg_temp.nid(104), 0, jsonb_build_object(
    'name_latin', 'X', 'country_id', tests.id('tz')))));
select is(pg_temp.err('f4', 0), 'out_of_scope', 'a locality cannot be proposed in another country');

-- deleting follows the same lock as editing
insert into res
select 'f5', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(105, 'localities', pg_temp.nid(101), 0, null, 'delete'),
  pg_temp.op(106, 'localities', pg_temp.nid(106), 0, jsonb_build_object(
    'name_latin', 'Kijiji D', 'lon', 39.74, 'lat', -5.01)),
  pg_temp.op(107, 'localities', pg_temp.nid(106), 1, null, 'delete')));
select is(pg_temp.st('f5'), array['rejected', 'applied', 'applied'],
  'a collector deletes his proposed locality, not an approved one');
select ok(
  pg_temp.err('f5', 0) = 'locality_locked'
  and (select l.status = 'approved' and l.deleted_at is null from public.localities l where l.id = pg_temp.nid(101))
  and (select l.deleted_at is not null from public.localities l where l.id = pg_temp.nid(106)),
  'deleting an approved locality: locality_locked, the locality stays');

insert into res
select 'f6', pg_temp.push(tests.id('u_sup_pemba'), 'dev-s', jsonb_build_array(
  pg_temp.op(108, 'localities', pg_temp.nid(101), pg_temp.ver('localities', pg_temp.nid(101)), null, 'delete')));
select ok(
  pg_temp.st('f6') = array['applied']
  and (select l.deleted_at is not null from public.localities l where l.id = pg_temp.nid(101)),
  'a reviewer may delete an approved locality');

-- =============================================================================
-- G. Restricted tables: blind writes
-- =============================================================================
-- the same device re-enters the sensitive row of the project with a NEW id
insert into res
select 'g1', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(110, 'community_sensitive', pg_temp.nid(110), 0, jsonb_build_object(
    'project_id', pg_temp.nid(1), 'ibadi_families', 15))));

select is(pg_temp.st('g1'), array['applied'], 'blind re-entry from the same device is applied');
select is((pg_temp.r('g1', 0) ->> 'row_id')::uuid, pg_temp.nid(9),
  'natural key: the operation was applied to the existing row and its id is returned');
select is(
  (select row(count(*), max(s.ibadi_families))::text from public.community_sensitive s
   where s.project_id = pg_temp.nid(1) and s.deleted_at is null),
  row(1::bigint, 15)::text, 'still one live sensitive row per project, with the new value');

-- another device enters different values blind: nothing is overwritten silently
insert into res
select 'g2', pg_temp.push(tests.id('u_col_pemba2'), 'dev-b', jsonb_build_array(
  pg_temp.op(111, 'community_sensitive', pg_temp.nid(111), 0, jsonb_build_object(
    'project_id', pg_temp.nid(1), 'ibadi_families', 20, 'omani_families', 2))));

select is(pg_temp.st('g2'), array['conflict'], 'blind entry from another device over existing values: conflict');
select ok(
  not (pg_temp.r('g2', 0) ? 'server_values') and jsonb_array_length(pg_temp.r('g2', 0) -> 'conflict_ids') = 2,
  'restricted conflict: two conflict ids, but stored values are never echoed');
select is(
  (select row(s.ibadi_families, s.omani_families)::text from public.community_sensitive s where s.id = pg_temp.nid(9)),
  row(15, null::integer)::text, 'the stored restricted values are untouched until a manager decides');
select is(
  (select array_agg(c.field || ':' || c.server_value::text || ':' || c.client_value::text order by c.field)
   from public.sync_conflicts c where c.table_name = 'community_sensitive' and c.row_id = pg_temp.nid(9)),
  array['ibadi_families:15:20', 'omani_families:null:2'],
  'the conflict rows keep both values for whoever may see restricted data');

insert into res
select 'g3', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(112, 'staff_compensation', pg_temp.nid(112), 0, jsonb_build_object(
    'project_staff_id', pg_temp.nid(5), 'monthly_amount', 300000, 'currency', 'TZS',
    'effective_from', '2025-01-01')),
  pg_temp.op(113, 'staff_compensation', pg_temp.nid(113), 0, jsonb_build_object(
    'project_staff_id', pg_temp.nid(5), 'monthly_amount', 320000, 'currency', 'TZS',
    'effective_from', '2026-01-01'))));

select is(pg_temp.st('g3'), array['applied', 'applied'], 'salary correction and a new salary period are applied blind');
select is(
  (select array_agg(sc.monthly_amount::int order by sc.effective_from) from public.staff_compensation sc
   where sc.project_staff_id = pg_temp.nid(5) and sc.deleted_at is null),
  array[300000, 320000], 'one live amount per assignment and effective date');

-- =============================================================================
-- H. Persons are never merged automatically
-- =============================================================================
insert into res
select 'h1', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(120, 'persons', pg_temp.nid(120), 0, jsonb_build_object('name_ar', 'محمد علي', 'phone_e164', '+255700111222')),
  pg_temp.op(121, 'persons', pg_temp.nid(121), 0, jsonb_build_object('name_ar', 'محمد علي', 'phone_e164', '+255700111222')),
  pg_temp.op(122, 'project_staff', pg_temp.nid(122), 0, jsonb_build_object(
    'project_id', pg_temp.nid(1), 'person_id', tests.id('person:p_ke_1'), 'role', 'teacher')),
  pg_temp.op(123, 'persons', pg_temp.nid(120), 1, jsonb_build_object('merged_into_id', pg_temp.nid(121)))));

select is(pg_temp.st('h1'), array['applied', 'applied', 'rejected', 'applied'],
  'two persons with the same name and phone are both stored; a foreign person cannot be linked');
select is(
  (select count(*)::int from public.persons pe
   where pe.id in (pg_temp.nid(120), pg_temp.nid(121)) and pe.deleted_at is null and pe.merged_into_id is null),
  2, 'no automatic merge by name or phone, and merged_into_id cannot be set through push');
select is(pg_temp.err('h1', 2), 'person_not_available', 'a person outside the caller''s scope cannot be assigned');

-- =============================================================================
-- I. Notifications: only own read_at
-- =============================================================================
insert into public.notifications (id, user_id, kind, payload)
values (pg_temp.nid(130), tests.id('u_col_pemba'), 'test.push', '{}'::jsonb),
       (pg_temp.nid(131), tests.id('u_col_ke'), 'test.push', '{}'::jsonb);

insert into res
select 'i1', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(132, 'notifications', pg_temp.nid(130), 1, jsonb_build_object(
    'read_at', '2026-10-03T12:00:00Z', 'kind', 'hacked', 'user_id', tests.id('u_col_ke'))),
  pg_temp.op(133, 'notifications', pg_temp.nid(131), 1, jsonb_build_object('read_at', '2026-10-03T12:00:00Z')),
  pg_temp.op(134, 'notifications', pg_temp.nid(134), 0, jsonb_build_object(
    'user_id', tests.id('u_col_pemba'), 'kind', 'test.forged')),
  pg_temp.op(135, 'notifications', pg_temp.nid(130), 2, null, 'delete')));

select is(pg_temp.st('i1'), array['applied', 'rejected', 'rejected', 'rejected'],
  'notifications: only the owner may mark his own notification as read');
select is(
  (select row(n.read_at is not null, n.kind, n.user_id)::text from public.notifications n where n.id = pg_temp.nid(130)),
  row(true, 'test.push'::text, tests.id('u_col_pemba'))::text,
  'read_at is stored, every other column of the notification is ignored');
select is(array[pg_temp.err('i1', 1), pg_temp.err('i1', 2), pg_temp.err('i1', 3)],
  array['not_owner', 'operation_not_allowed', 'operation_not_allowed'],
  'foreign notification: not_owner; inserting / deleting notifications is not allowed');

-- =============================================================================
-- J. Merge requests: reviewers only
-- =============================================================================
insert into res
select 'j1', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(140, 'person_merge_requests', pg_temp.nid(140), 0, jsonb_build_object(
    'source_person_id', pg_temp.nid(120), 'target_person_id', pg_temp.nid(121), 'reason', 'same person'))));
select is(pg_temp.err('j1', 0), 'reviewer_required', 'a collector cannot file a merge request');

insert into res
select 'j2', pg_temp.push(tests.id('u_sup_pemba'), 'dev-s', jsonb_build_array(
  pg_temp.op(141, 'person_merge_requests', pg_temp.nid(141), 0, jsonb_build_object(
    'source_person_id', pg_temp.nid(120), 'target_person_id', pg_temp.nid(121), 'reason', 'same person',
    'undo', '{"x": 1}'::jsonb, 'decided_by', tests.id('u_hq'))),
  pg_temp.op(142, 'person_merge_requests', pg_temp.nid(142), 0, jsonb_build_object(
    'source_person_id', pg_temp.nid(120), 'target_person_id', tests.id('person:p_ke_1'))),
  pg_temp.op(143, 'person_merge_requests', pg_temp.nid(141), 1, jsonb_build_object('state', 'merged')),
  pg_temp.op(144, 'person_merge_requests', pg_temp.nid(141), 1, jsonb_build_object('state', 'rejected'))));

select is(pg_temp.st('j2'), array['applied', 'rejected', 'rejected', 'applied'],
  'a supervisor files and rejects merge requests; merging itself is not possible through push');
select is(array[pg_temp.err('j2', 1), pg_temp.err('j2', 2)], array['out_of_scope', 'invalid_transition'],
  'both persons must be in the reviewer''s scope; state merged is reserved for merge_persons()');
select is(
  (select row(m.state, m.decided_by, m.undo)::text from public.person_merge_requests m where m.id = pg_temp.nid(141)),
  row('rejected'::text, tests.id('u_sup_pemba'), null::jsonb)::text,
  'rejection stamps decided_by; undo / decided_by from the client are ignored');
select ok(
  (select pe.deleted_at is null and pe.merged_into_id is null from public.persons pe where pe.id = pg_temp.nid(120)),
  'filing or rejecting a merge request never changes the persons');

-- a pending request may be withdrawn (deleted); a decided one is the trace of
-- the decision
insert into res
select 'j3', pg_temp.push(tests.id('u_sup_pemba'), 'dev-s', jsonb_build_array(
  pg_temp.op(145, 'person_merge_requests', pg_temp.nid(145), 0, jsonb_build_object(
    'source_person_id', pg_temp.nid(121), 'target_person_id', pg_temp.nid(120))),
  pg_temp.op(146, 'person_merge_requests', pg_temp.nid(145), 1, null, 'delete'),
  pg_temp.op(147, 'person_merge_requests', pg_temp.nid(141),
             pg_temp.ver('person_merge_requests', pg_temp.nid(141)), null, 'delete')));
select is(pg_temp.st('j3'), array['applied', 'applied', 'rejected'],
  'a pending merge request can be withdrawn, a rejected one cannot be deleted');
select is(pg_temp.err('j3', 2), 'invalid_transition', 'deleting a decided merge request: invalid_transition');

-- a merged request holds the undo data: deleting it would make the merge
-- irreversible (revert_person_merge ignores soft-deleted requests)
create function pg_temp.as_sup(p_sql text) returns jsonb language plpgsql as
$fn$
declare
  r jsonb;
begin
  begin
    perform tests.login_as(tests.id('u_sup_pemba'), 'aal1', 'dev-s');
    execute p_sql into r;
    perform tests.logout();
  exception when others then
    r := jsonb_build_object('error', sqlerrm);   -- the login is rolled back with the block
  end;
  return r;
end;
$fn$;

insert into res
select 'j4', pg_temp.as_sup(format('select public.merge_persons(%L::uuid, %L::uuid, %L)',
                                   pg_temp.nid(120), pg_temp.nid(121), 'same person'));
insert into res
select 'j5', pg_temp.push(tests.id('u_sup_pemba'), 'dev-s', jsonb_build_array(
  pg_temp.op(148, 'person_merge_requests', (select (v ->> 'request_id')::uuid from res where k = 'j4'), 0, null, 'delete')));
insert into res
select 'j6', pg_temp.as_sup(format('select public.revert_person_merge(%L::uuid)',
                                   (select v ->> 'request_id' from res where k = 'j4')));
select ok(
  (select v ->> 'state' from res where k = 'j4') = 'merged'
  and pg_temp.err('j5', 0) = 'invalid_transition'
  and (select v ->> 'state' from res where k = 'j6') = 'reverted',
  'a merged request cannot be deleted through push, so the merge can still be reverted');

-- =============================================================================
-- L. created_at: the offline entry time is kept on insert, immutable afterwards
-- =============================================================================
insert into res
select 'l1', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(160, 'projects', pg_temp.nid(160), 0, jsonb_build_object(
    'name_ar', 'أدخل دون اتصال', 'type', 'school', 'country_id', tests.id('tz'),
    'created_at', now() - interval '3 days')),
  pg_temp.op(161, 'project_maintenance', pg_temp.nid(161), 0, jsonb_build_object(
    'project_id', pg_temp.nid(160), 'description', 'Entered offline', 'created_at', now() - interval '2 days')),
  pg_temp.op(162, 'donors', pg_temp.nid(162), 0, jsonb_build_object(
    'name_latin', 'Clock slightly ahead', 'created_at', now() + interval '2 minutes')),
  pg_temp.op(163, 'donors', pg_temp.nid(163), 0, jsonb_build_object(
    'name_latin', 'Clock far ahead', 'created_at', now() + interval '2 days')),
  pg_temp.op(164, 'donors', pg_temp.nid(164), 0, jsonb_build_object('name_latin', 'No entry time', 'created_at', null)),
  pg_temp.op(165, 'donors', pg_temp.nid(165), 0, jsonb_build_object('name_latin', 'Blank entry time', 'created_at', ' ')),
  pg_temp.op(166, 'donors', pg_temp.nid(166), 0, jsonb_build_object('name_latin', 'Infinite', 'created_at', '-infinity')),
  pg_temp.op(167, 'donors', pg_temp.nid(167), 0, jsonb_build_object('name_latin', 'Not a time', 'created_at', 'not-a-timestamp'))));

select is(pg_temp.st('l1'), array_fill('applied'::text, array[7]) || array['rejected'],
  'insert with created_at: accepted, only a value that is not a timestamp rejects the operation');
select is(
  array[(select p.created_at from public.projects p where p.id = pg_temp.nid(160)),
        (select m.created_at from public.project_maintenance m where m.id = pg_temp.nid(161))],
  array[now() - interval '3 days', now() - interval '2 days'],
  'insert: the client-supplied created_at (offline entry time) is stored, on a project and on a child');
select is(
  array[(select d.created_at from public.donors d where d.id = pg_temp.nid(162)),
        (select d.created_at from public.donors d where d.id = pg_temp.nid(163))],
  array[now() + interval '2 minutes', now()],
  'insert: a small clock skew is tolerated, a created_at further in the future is replaced by the server time');
select is(
  (select array_agg(d.created_at order by d.id) from public.donors d
   where d.id in (pg_temp.nid(164), pg_temp.nid(165), pg_temp.nid(166))),
  array[now(), now(), now()],
  'insert: a null, blank or infinite created_at falls back to the server time');
select ok(
  pg_temp.err('l1', 7) = 'invalid_value'
  and not exists (select 1 from public.donors d where d.id = pg_temp.nid(167)),
  'insert: a created_at that is not a timestamp is rejected as invalid_value');

insert into res
select 'l2', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(168, 'projects', pg_temp.nid(160), 1, jsonb_build_object(
    'builder', 'Later edit', 'created_at', now() - interval '30 days'))));
select ok(
  pg_temp.st('l2') = array['applied'] and not (pg_temp.r('l2', 0) ? 'ignored_fields')
  and (select p.builder = 'Later edit' and p.created_at = now() - interval '3 days'
       from public.projects p where p.id = pg_temp.nid(160)),
  'update: created_at stays immutable (dropped silently like the other server-managed columns)');

-- =============================================================================
-- M. Donors: only a donor the caller can see may be changed, deleted or linked
--    (same visibility rule as RLS and sync_pull)
-- =============================================================================
-- a colleague of the branch sees the donor through the project link and may
-- correct it; deleting needs the creator or a reviewer; an unlinked donor of
-- somebody else is invisible to him
insert into res
select 'm1', pg_temp.push(tests.id('u_col_pemba2'), 'dev-b', jsonb_build_array(
  pg_temp.op(170, 'donors', pg_temp.nid(11), 1, jsonb_build_object('name_latin', 'Generous donor')),
  pg_temp.op(171, 'donors', pg_temp.nid(11), 2, null, 'delete'),
  pg_temp.op(172, 'donors', pg_temp.nid(1001), 1, jsonb_build_object('name_latin', 'x'))));

select is(pg_temp.st('m1'), array['applied', 'rejected', 'rejected'],
  'a donor linked to a project in scope may be corrected by any writer of that scope');
select is(array[pg_temp.err('m1', 1), pg_temp.err('m1', 2)], array['not_owner', 'out_of_scope'],
  'deleting it needs the creator or a reviewer; an unlinked donor of a colleague is out of scope');

-- a collector of another country who knows the id: the stale base would be a
-- conflict (which echoes the stored value) if the donor were visible to him
insert into res
select 'm2', pg_temp.push(tests.id('u_col_ke'), 'dev-k', jsonb_build_array(
  pg_temp.op(173, 'donors', pg_temp.nid(11), 1, jsonb_build_object('name_latin', 'Hacked')),
  pg_temp.op(174, 'donors', pg_temp.nid(11), 2, null, 'delete'),
  pg_temp.op(175, 'project_donors', pg_temp.nid(175), 0, jsonb_build_object(
    'project_id', tests.id('p_ke_1'), 'donor_id', pg_temp.nid(11), 'year', 2020)),
  pg_temp.op(176, 'project_donors', pg_temp.nid(176), 0, jsonb_build_object(
    'project_id', tests.id('p_ke_1'), 'donor_id', pg_temp.nid(7676), 'year', 2020)),
  -- his own donor, created and linked in the same batch
  pg_temp.op(177, 'donors', pg_temp.nid(177), 0, jsonb_build_object('name_latin', 'Kenyan donor')),
  pg_temp.op(178, 'project_donors', pg_temp.nid(178), 0, jsonb_build_object(
    'project_id', tests.id('p_ke_1'), 'donor_id', pg_temp.nid(177), 'year', 2021))));

select is(pg_temp.st('m2'), array['rejected', 'rejected', 'rejected', 'rejected', 'applied', 'applied'],
  'a donor of another country cannot be changed, deleted or linked by id; an own donor is linked in the same batch');
select is(
  array[pg_temp.err('m2', 0), pg_temp.err('m2', 1), pg_temp.err('m2', 2), pg_temp.err('m2', 3)],
  array['out_of_scope', 'out_of_scope', 'donor_not_available', 'parent_missing'],
  'foreign donor: out_of_scope / donor_not_available; a donor that does not exist: parent_missing');
select ok(
  not (pg_temp.r('m2', 0) ? 'server_values') and not (pg_temp.r('m2', 0) ? 'conflict_ids')
  and (select d.name_latin = 'Generous donor' and d.deleted_at is null from public.donors d where d.id = pg_temp.nid(11))
  and not exists (select 1 from public.project_donors pd where pd.id in (pg_temp.nid(175), pg_temp.nid(176)))
  and not exists (select 1 from public.sync_conflicts sc where sc.table_name = 'donors' and sc.row_id = pg_temp.nid(11)),
  'nothing about the foreign donor is disclosed (no conflict, no server value) and nothing is written');

insert into res
select 'm3', pg_temp.push(tests.id('u_hq'), 'dev-h', jsonb_build_array(
  pg_temp.op(179, 'donors', pg_temp.nid(1001), 1, jsonb_build_object('notes', 'checked by HQ'))), 'aal2');
select is(pg_temp.st('m3'), array['applied'], 'a global reader (hq_admin) may correct any donor');

-- re-pointing an existing link follows the same rule
insert into res
select 'm4', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(180, 'project_donors', pg_temp.nid(12), pg_temp.ver('project_donors', pg_temp.nid(12)),
             jsonb_build_object('donor_id', pg_temp.nid(177))),
  pg_temp.op(181, 'project_donors', pg_temp.nid(12), pg_temp.ver('project_donors', pg_temp.nid(12)),
             jsonb_build_object('donor_id', pg_temp.nid(1002), 'amount', 6000))));
select is(
  array[pg_temp.err('m4', 0), pg_temp.r('m4', 1) ->> 'status'], array['donor_not_available', 'applied'],
  'a link can be re-pointed only to a donor the caller can see');

-- =============================================================================
-- K. Ledger ownership and revoked sessions
-- =============================================================================
insert into res
select 'k1', pg_temp.push(tests.id('u_col_pemba2'), 'dev-b', jsonb_build_array(
  pg_temp.op(1, 'projects', pg_temp.nid(1), 0, jsonb_build_object('name_ar', 'x'))));
select is(pg_temp.err('k1', 0), 'op_id_taken', 'an op_id applied by another user is refused, its result is not disclosed');

update public.devices set revoked_at = now()
where user_id = tests.id('u_col_pemba') and device_id = 'dev-a';

select throws_ok(
  format($q$select pg_temp.push(%L::uuid, 'dev-a', '[]'::jsonb)$q$, tests.id('u_col_pemba')),
  'PT403', 'session_revoked', 'a revoked device cannot push');

insert into res
select 'k2', pg_temp.push(tests.id('u_col_pemba'), 'dev-a2', jsonb_build_array(
  pg_temp.op(150, 'donors', pg_temp.nid(150), 0, jsonb_build_object('name_ar', 'جهاز آخر'))));
select is(pg_temp.st('k2'), array['applied'], 'the same user keeps working from a device that is not revoked');

update public.profiles set sessions_revoked_at = now() + interval '1 hour'
where id = tests.id('u_col_pemba');

select throws_ok(
  format($q$select pg_temp.push(%L::uuid, 'dev-a2', '[]'::jsonb)$q$, tests.id('u_col_pemba')),
  'PT403', 'session_revoked', 'revoked sessions cannot push');

select * from finish();
rollback;

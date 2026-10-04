-- =============================================================================
-- 01  Core schema triggers (migrations 0001-0009; contract: docs/contracts/schema.md)
--
--   1. catalog         every table carries the standard triggers
--   2. standard cols   id / created_at / created_by / updated_* / version / sync_xid
--   3. audit log       one row per change, changed_fields, geometry digests
--   4. project code    <ISO2>-<level-1 short code|XX>-<counter>, unique, immutable
--   5. admin area      derived from the point (deepest polygon), manual fallback
--   6. completeness    the weights of schema.md section 5
--   7. photos          paths, single cover, max 10 live, project immutable
--   8. normalisation   name_norm / name_normalized / search_norm
--   9. validation      CHECK constraints and PT422 errors
--  10. hard delete     DELETE / TRUNCATE forbidden for API users, logs append-only
--
-- The file brings its own geography: two countries (ZZ, ZY) with square
-- boundaries in the South Atlantic, where neither the staging seed nor imported
-- boundaries have anything, so project codes and derived areas are deterministic
-- on any database. Non-ASCII text is written as U&'\XXXX' escapes on purpose.
--
-- Writes are made by the role that runs the file (owner, bypasses RLS). "Acting
-- as an end user" only sets the JWT claims, which is all the triggers look at;
-- privileges and RLS of the API roles are covered by files 10-16.
-- =============================================================================
begin;
set local search_path = public, extensions, tests;

select plan(163);

-- -----------------------------------------------------------------------------
-- Helpers (session-local)
-- -----------------------------------------------------------------------------
create function pg_temp.cid(p_key text) returns uuid language sql immutable as
$f$ select md5('core-schema-test:' || p_key)::uuid $f$;

create function pg_temp.pt(p_lon double precision, p_lat double precision)
returns extensions.geometry language sql immutable as
$f$ select extensions.st_setsrid(extensions.st_makepoint(p_lon, p_lat), 4326) $f$;

create function pg_temp.sq(p_x1 double precision, p_y1 double precision, p_x2 double precision, p_y2 double precision)
returns extensions.geometry language sql immutable as
$f$ select extensions.st_multi(extensions.st_makeenvelope(p_x1, p_y1, p_x2, p_y2, 4326)) $f$;

-- JWT claims + x-device-id header of an end user; the database role does not change.
create function pg_temp.act_as(p_user uuid, p_jwt_role text default 'authenticated')
returns void language plpgsql as
$f$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_user, 'role', p_jwt_role, 'aud', p_jwt_role, 'aal', 'aal1')::text, true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.headers', '{"x-device-id": "dev-core"}', true);
end
$f$;

-- Server-side code: no JWT, no request headers.
create function pg_temp.act_as_server()
returns void language plpgsql as
$f$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.headers', '', true);
end
$f$;

create temporary table _ids (k text primary key, id uuid not null) on commit drop;
create temporary table _memo (k text primary key, v text) on commit drop;

create function pg_temp.u(p_key text) returns uuid language sql stable as
$f$ select i.id from _ids i where i.k = p_key $f$;

create function pg_temp.memo(p_key text) returns text language sql stable as
$f$ select m.v from _memo m where m.k = p_key $f$;

-- -----------------------------------------------------------------------------
-- Fixture (server side, no JWT)
-- -----------------------------------------------------------------------------
select pg_temp.act_as_server();

insert into _ids (k, id) values
  ('a', tests.create_user('core_a@example.org', null, null, null)),
  ('b', tests.create_user('core_b@example.org', null, null, null));

insert into public.countries (id, iso2, iso3, name_ar, name_en, default_currency) values
  (pg_temp.cid('zz'), 'ZZ', 'ZZZ', U&'\0628\0644\062F \0627\0644\0627\062E\062A\0628\0627\0631', 'Testland', 'USD'),
  (pg_temp.cid('zy'), 'ZY', 'ZYY', U&'\0628\0644\062F \062B\0627\0646', 'Otherland', 'USD');

-- ZZ: region ZN > district > ward (nested squares) and region ZR without a shape.
-- ZY: region YA.
insert into public.admin_areas (id, country_id, parent_id, level, code, short_code, name_en, geom) values
  (pg_temp.cid('zn'),   pg_temp.cid('zz'), null,               1, 'CORE-ZN',     'ZN', 'Z North',    pg_temp.sq(-30.0, -50.0, -29.0, -49.0)),
  (pg_temp.cid('zn_d'), pg_temp.cid('zz'), pg_temp.cid('zn'),   2, 'CORE-ZN-D',   null, 'Z District', pg_temp.sq(-29.8, -49.8, -29.4, -49.4)),
  (pg_temp.cid('zn_w'), pg_temp.cid('zz'), pg_temp.cid('zn_d'), 3, 'CORE-ZN-D-W', null, 'Z Ward',     pg_temp.sq(-29.7, -49.7, -29.5, -49.5)),
  (pg_temp.cid('zr'),   pg_temp.cid('zz'), null,               1, 'CORE-ZR',     'ZR', 'Z Remote',   null),
  (pg_temp.cid('ya'),   pg_temp.cid('zy'), null,               1, 'CORE-YA',     'YA', 'Y Area',     pg_temp.sq(-20.0, -50.0, -19.0, -49.0));

insert into public.branches (id, country_id, code, name_ar) values
  (pg_temp.cid('br'), pg_temp.cid('zz'), 'CORE-BR', U&'\0641\0631\0639');

insert into public.option_values (id, list_key, code, name_ar) values
  (pg_temp.cid('opt_liv'),   'livelihoods',      'core_test_livelihood', U&'\062E\064A\0627\0631'),
  (pg_temp.cid('opt_daawa'), 'daawa_activities', 'core_test_daawa',      U&'\062E\064A\0627\0631');

-- Points:  ward (-29.6, -49.6) | district only (-29.45, -49.45) | region only (-29.1, -49.1)
--          no polygon (-25.0, -49.5) | YA (-19.5, -49.5)

-- =============================================================================
-- 1. Catalog
-- =============================================================================
select is_empty(
  $$ select c.relname
     from pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
       and not exists (select 1 from pg_depend d
                       where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
       and (select count(*) from pg_trigger g
            where g.tgrelid = c.oid and g.tgenabled <> 'D'
              and g.tgname in ('t00_no_hard_delete', 't00_no_truncate')) <> 2
     order by 1 $$,
  'every table of schema public has the enabled triggers t00_no_hard_delete and t00_no_truncate');

select is_empty(
  $$ select c.relname
     from pg_class c
     join pg_attribute a on a.attrelid = c.oid and a.attname = 'version' and not a.attisdropped
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
       and not exists (select 1 from pg_trigger g
                       where g.tgrelid = c.oid and g.tgname = 't10_std' and g.tgenabled <> 'D')
     order by 1 $$,
  'every table with the standard columns has the enabled trigger t10_std');

select set_eq(
  $$ select c.relname::text
     from pg_class c
     join pg_attribute a on a.attrelid = c.oid and a.attname = 'version' and not a.attisdropped
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
       and not exists (select 1 from pg_trigger g
                       where g.tgrelid = c.oid and g.tgname = 't90_audit' and g.tgenabled <> 'D') $$,
  array['import_rows'],
  'every table with the standard columns is audited (t90_audit), except the staging table import_rows');

select set_eq(
  $$ select c.relname::text
     from pg_class c
     join pg_attribute a on a.attrelid = c.oid and a.attname = 'sync_xid' and not a.attisdropped
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') $$,
  array['countries', 'admin_areas', 'branches', 'option_values', 'fx_rates', 'localities', 'donors',
        'projects', 'project_land', 'project_facilities', 'project_maintenance', 'project_photos',
        'project_donors', 'persons', 'project_staff', 'community_profiles', 'staff_compensation',
        'community_sensitive', 'person_merge_requests', 'sync_conflicts', 'notifications', 'map_packs'],
  'exactly the 22 syncable tables of the contract carry sync_xid');

select is_empty(
  $$ select c.relname
     from pg_class c
     join pg_attribute a on a.attrelid = c.oid and a.attname = 'sync_xid' and not a.attisdropped
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
       and (not exists (select 1 from pg_index i
                        where i.indrelid = c.oid and pg_get_indexdef(i.indexrelid) like '%(sync_xid, id)%')
            or not exists (select 1 from pg_trigger g
                           where g.tgrelid = c.oid and g.tgname = 't10_std' and g.tgargs = 'sync\000'::bytea))
     order by 1 $$,
  'every syncable table has an index (sync_xid, id) and t10_std(''sync'')');

-- =============================================================================
-- 2. Standard columns (on donors: a syncable table without other derived state)
-- =============================================================================
-- Server-side insert: explicit values are kept, bookkeeping is not.
insert into public.donors (id, name_latin, created_by, created_at, version, sync_xid, updated_at)
values (pg_temp.cid('d1'), 'Donor One', pg_temp.u('a'), now() - interval '3 days', 42, 1, now() - interval '9 days');
insert into public.donors (name_latin, created_at) values ('Donor Two', now() + interval '1 hour');

select is((select version from public.donors where id = pg_temp.cid('d1')), 1,
  'insert: version is 1 whatever the writer sends');
select is((select array[created_by, updated_by] from public.donors where id = pg_temp.cid('d1')),
  array[pg_temp.u('a'), pg_temp.u('a')],
  'insert without a JWT user: the explicit created_by is kept and updated_by follows it');
select ok((select created_at = now() - interval '3 days' from public.donors where id = pg_temp.cid('d1')),
  'insert: a created_at in the past is kept (offline entry time)');
select ok((select updated_at = now() from public.donors where id = pg_temp.cid('d1')),
  'insert: updated_at is always now()');
select is((select sync_xid from public.donors where id = pg_temp.cid('d1')), private.current_xid(),
  'insert: sync_xid is the id of the writing transaction, not the supplied value');
select is((select substr(id::text, 15, 1) from public.donors where name_latin = 'Donor Two'), '7',
  'insert: a missing id is generated as UUIDv7');
select ok((select created_at = now() from public.donors where name_latin = 'Donor Two'),
  'insert: a created_at more than 5 minutes in the future is replaced by now()');

-- End user A inserts; a spoofed created_by is ignored.
select pg_temp.act_as(pg_temp.u('a'));
insert into public.donors (id, name_latin, created_by, updated_by)
values (pg_temp.cid('d3'), 'Donor Three', pg_temp.u('b'), pg_temp.u('b'));
select is((select array[created_by, updated_by] from public.donors where id = pg_temp.cid('d3')),
  array[pg_temp.u('a'), pg_temp.u('a')],
  'insert with a JWT user: created_by and updated_by are auth.uid(), supplied values are ignored');
select is((select id from public.donors where name_latin = 'Donor Three'), pg_temp.cid('d3'),
  'insert: a client-generated id is kept');

-- End user B updates and tries to rewrite the bookkeeping columns.
select pg_temp.act_as(pg_temp.u('b'));
update public.donors
   set id = pg_temp.cid('d3x'), name_latin = 'Donor Three B', created_by = pg_temp.u('b'),
       created_at = timestamptz '2000-01-01', updated_at = timestamptz '2000-01-01', version = 99, sync_xid = 1
 where id = pg_temp.cid('d3');

select is((select count(*)::int from public.donors where id in (pg_temp.cid('d3'), pg_temp.cid('d3x'))), 1,
  'update: the row still exists exactly once');
select is((select name_latin from public.donors where id = pg_temp.cid('d3')), 'Donor Three B',
  'update: id is immutable (the data change itself is applied)');
select is((select version from public.donors where id = pg_temp.cid('d3')), 2,
  'update: version is old.version + 1, a supplied version is ignored');
select is((select array[created_by, updated_by] from public.donors where id = pg_temp.cid('d3')),
  array[pg_temp.u('a'), pg_temp.u('b')],
  'update: created_by is immutable for JWT users, updated_by is the updating user');
select ok((select created_at = now() and updated_at = now() from public.donors where id = pg_temp.cid('d3')),
  'update: created_at is immutable and updated_at is now()');
select is((select sync_xid from public.donors where id = pg_temp.cid('d3')), private.current_xid(),
  'update: sync_xid is stamped with the writing transaction again');

-- An UPDATE that changes nothing still bumps the version (and writes no audit row, see 3).
update public.donors set name_latin = name_latin where id = pg_temp.cid('d3');
select is((select version from public.donors where id = pg_temp.cid('d3')), 3,
  'update: every UPDATE bumps version, even one that changes nothing');

-- A row written by an earlier transaction (reference data of migration 0061) moves to the
-- current transaction id, which is what makes sync_pull deliver it again.
insert into _memo
select 'opt_xid', o.sync_xid::text from public.option_values o
where o.id = private.ref_uuid('option:livelihoods:fishing');
update public.option_values set sort_order = sort_order where id = private.ref_uuid('option:livelihoods:fishing');
select ok(
  (select o.sync_xid = private.current_xid() and o.sync_xid > pg_temp.memo('opt_xid')::bigint
   from public.option_values o where o.id = private.ref_uuid('option:livelihoods:fishing')),
  'update: sync_xid of a row from an earlier transaction changes to the current transaction id');

-- Server-side update: an explicit updated_by is kept.
select pg_temp.act_as_server();
update public.donors set notes = 'checked', updated_by = pg_temp.u('b') where id = pg_temp.cid('d1');
select is((select array[created_by, updated_by] from public.donors where id = pg_temp.cid('d1')),
  array[pg_temp.u('a'), pg_temp.u('b')],
  'update without a JWT user: an explicit updated_by is kept');

-- =============================================================================
-- 3. Audit log
-- =============================================================================
select results_eq(
  $$ select op, row_version, changed_fields, user_id, device_id
     from public.audit_log where table_name = 'donors' and row_id = pg_temp.cid('d3') order by id $$,
  $$ values ('INSERT', 1, null::text[], pg_temp.u('a'), 'dev-core'),
            ('UPDATE', 2, array['name_latin', 'name_norm'], pg_temp.u('b'), 'dev-core') $$,
  'audit: one row per change with op, row_version, changed_fields, user and device; the no-op update is not logged');

select ok(
  (select a.old_data is null and a.new_data ->> 'name_latin' = 'Donor Three' and a.new_data ->> 'version' = '1'
   from public.audit_log a
   where a.table_name = 'donors' and a.row_id = pg_temp.cid('d3') and a.op = 'INSERT'),
  'audit INSERT: old_data is null, new_data is the whole row');
select ok(
  (select a.old_data ->> 'name_latin' = 'Donor Three' and a.new_data ->> 'name_latin' = 'Donor Three B'
          and a.old_data ->> 'version' = '1' and a.new_data ->> 'version' = '2'
   from public.audit_log a
   where a.table_name = 'donors' and a.row_id = pg_temp.cid('d3') and a.op = 'UPDATE'),
  'audit UPDATE: old_data and new_data hold the row before and after');
select is_empty(
  $$ select a.id from public.audit_log a
     where a.op = 'UPDATE'
       and a.changed_fields && array['updated_at', 'updated_by', 'version', 'sync_xid'] $$,
  'audit: changed_fields never lists the bookkeeping columns');
select is_empty(
  $$ select a.id from public.audit_log a
     where (a.op = 'UPDATE') <> (a.changed_fields is not null) $$,
  'audit: changed_fields is set for UPDATE only');

-- Server-side change: the user falls back to the row's updated_by, there is no device.
select results_eq(
  $$ select op, row_version, changed_fields, user_id, device_id
     from public.audit_log where table_name = 'donors' and row_id = pg_temp.cid('d1') order by id $$,
  $$ values ('INSERT', 1, null::text[], pg_temp.u('a'), null::text),
            ('UPDATE', 2, array['notes'], pg_temp.u('b'), null::text) $$,
  'audit without a JWT user: user_id is the row''s updated_by and device_id is null');

-- devices: the heartbeat columns are not worth a log row, a revocation is.
insert into public.devices (id, user_id, device_id, label)
values (pg_temp.cid('dev'), pg_temp.u('a'), 'dev-core', 'Core test phone');
update public.devices
   set last_seen_at = now(), last_push_at = now(), last_pull_at = now(), pending_ops = 3, pending_photos = 1,
       app_version = '3.0.0', user_agent = 'pgTAP'
 where id = pg_temp.cid('dev');
update public.devices set revoked_at = now() where id = pg_temp.cid('dev');
select results_eq(
  $$ select op, row_version, changed_fields
     from public.audit_log where table_name = 'devices' and row_id = pg_temp.cid('dev') order by id $$,
  $$ values ('INSERT', 1, null::text[]), ('UPDATE', 3, array['revoked_at']) $$,
  'audit devices: a heartbeat update is not logged (version 2 has no row), a revocation is');

-- import_rows is the only standard table without an audit trail.
insert into public.import_batches (id, user_id, source_kind, file_name)
values (pg_temp.cid('batch'), pg_temp.u('a'), 'csv', 'core.csv');
insert into public.import_rows (batch_id, row_no, raw)
select pg_temp.cid('batch'), g, jsonb_build_object('n', g) from generate_series(1, 3) g;
select is(
  (select array[count(*) filter (where table_name = 'import_batches' and row_id = pg_temp.cid('batch')),
                count(*) filter (where table_name = 'import_rows')]::int[]
   from public.audit_log),
  array[1, 0],
  'audit: import_batches is logged, import_rows is not');

-- Geometry is logged as text: points as EWKT, boundaries as a digest.
select matches(
  (select a.new_data ->> 'geom' from public.audit_log a
   where a.table_name = 'admin_areas' and a.row_id = pg_temp.cid('zn') and a.op = 'INSERT'),
  '^SRID=4326;MULTIPOLYGON npoints=5 md5=[0-9a-f]{32}$',
  'audit admin_areas: geom is logged as a digest (type, point count, md5)');
select matches(
  (select a.new_data ->> 'geom_simple' from public.audit_log a
   where a.table_name = 'admin_areas' and a.row_id = pg_temp.cid('zn') and a.op = 'INSERT'),
  '^SRID=4326;MULTIPOLYGON npoints=[0-9]+ md5=[0-9a-f]{32}$',
  'audit admin_areas: geom_simple is logged as a digest');

-- =============================================================================
-- 4. Project code  +  5. admin area from the point (inserts shared by both)
-- =============================================================================
select pg_temp.act_as(pg_temp.u('a'));

-- p1: inside the ward; the client lies about country, area, code and derived columns.
insert into public.projects
  (id, name_ar, name_latin, type, geom, country_id, admin_area_id, capacity, code, completeness, search_norm, version)
values
  (pg_temp.cid('p1'), U&'\0645\0633\062C\062F \0627\0644\0646\0651\064F\0648\0631', 'Masjid An-Nur', 'mosque',
   pg_temp.pt(-29.6, -49.6), pg_temp.cid('zy'), pg_temp.cid('ya'), 200, 'HACK-1', 100, 'zzz', 7);
-- p2: inside the district only, no country supplied.
insert into public.projects (id, name_ar, type, geom)
values (pg_temp.cid('p2'), U&'\0645\062F\0631\0633\0629', 'school', pg_temp.pt(-29.45, -49.45));
-- p3: no polygon; manual area ZR (country ZZ) although the client says country ZY.
insert into public.projects (id, name_ar, type, geom, country_id, admin_area_id)
values (pg_temp.cid('p3'), 'p3', 'combined', pg_temp.pt(-25.0, -49.5), pg_temp.cid('zy'), pg_temp.cid('zr'));

-- p4: server-side insert with an explicit code that is ahead of the counter.
select pg_temp.act_as_server();
insert into public.projects (id, name_ar, type, geom, code, created_by)
values (pg_temp.cid('p4'), 'p4', 'mosque', pg_temp.pt(-29.1, -49.1), 'ZZ-ZN-000005', pg_temp.u('a'));
select pg_temp.act_as(pg_temp.u('a'));

-- p5: draft without a location. p6: ward again. p7: no polygon, country only. p8: region YA.
insert into public.projects (id, name_ar, type, country_id)
values (pg_temp.cid('p5'), 'p5', 'mosque', pg_temp.cid('zz'));
insert into public.projects (id, name_ar, type, geom)
values (pg_temp.cid('p6'), 'p6', 'mosque', pg_temp.pt(-29.6, -49.6));
insert into public.projects (id, name_ar, type, geom, country_id)
values (pg_temp.cid('p7'), 'p7', 'school', pg_temp.pt(-25.0, -49.5), pg_temp.cid('zy'));
insert into public.projects (id, name_ar, type, geom)
values (pg_temp.cid('p8'), 'p8', 'mosque', pg_temp.pt(-19.5, -49.5));

-- ---- 4. codes -----------------------------------------------------------------
select is((select code from public.projects where id = pg_temp.cid('p1')), 'ZZ-ZN-000001',
  'code: <ISO2>-<short code of the level-1 ancestor>-<6-digit counter>; a code sent by an end user is discarded');
select is((select code from public.projects where id = pg_temp.cid('p2')), 'ZZ-ZN-000002',
  'code: the counter is per country and the short code comes from the level-1 ancestor of a district');
select is((select code from public.projects where id = pg_temp.cid('p3')), 'ZZ-ZR-000003',
  'code: a manually chosen area provides the short code');
select is((select code from public.projects where id = pg_temp.cid('p4')), 'ZZ-ZN-000005',
  'code: server-side code without a JWT user may supply a code on insert');
select is((select code from public.projects where id = pg_temp.cid('p5')), 'ZZ-XX-000004',
  'code: XX when the project has no admin area (draft without a location)');
select is((select code from public.projects where id = pg_temp.cid('p6')), 'ZZ-ZN-000006',
  'code: a number already taken by an explicit code is skipped');
select is((select code from public.projects where id = pg_temp.cid('p7')), 'ZY-XX-000001',
  'code: every country has its own counter');
select is((select code from public.projects where id = pg_temp.cid('p8')), 'ZY-YA-000002',
  'code: second project of the other country');

update public.projects set code = 'ZZ' where id = pg_temp.cid('p1');
select is((select code from public.projects where id = pg_temp.cid('p1')), 'ZZ-ZN-000001',
  'code: immutable once set');

-- 40 rows in one statement.
insert into public.projects (name_ar, type, geom, country_id)
select 'bulk ' || g, 'mosque', pg_temp.pt(-25.0 + g * 0.001, -49.5), pg_temp.cid('zy')
from generate_series(1, 40) g;
select is(
  (select array[count(*), count(distinct code), min(code), max(code)]::text[]
   from public.projects where name_ar like 'bulk %' and country_id = pg_temp.cid('zy')),
  array['40', '40', 'ZY-XX-000003', 'ZY-XX-000042'],
  'code: a multi-row insert gets 40 distinct consecutive codes');
select is_empty(
  $$ select code from public.projects
     where country_id in (pg_temp.cid('zz'), pg_temp.cid('zy'))
       and code !~ '^Z[ZY]-(ZN|ZR|YA|XX)-[0-9]{6}$' $$,
  'code: every generated code has the documented format');
select results_eq(
  $$ select c.iso2::text, k.last_value
     from private.project_code_counters k join public.countries c on c.id = k.country_id
     where c.iso2 in ('ZZ', 'ZY') order by 1 $$,
  $$ values ('ZY', 42::bigint), ('ZZ', 6::bigint) $$,
  'code: the per-country counters hold the last number handed out');

select pg_temp.act_as_server();
select throws_ok(
  $$ insert into public.projects (name_ar, type, geom, code)
     values ('dup', 'mosque', pg_temp.pt(-29.6, -49.6), 'ZZ-ZN-000001') $$,
  '23505', 'duplicate key value violates unique constraint "projects_code_key"',
  'code: unique (a duplicate explicit code is refused)');

-- Beyond 999999 the number simply gets longer.
update private.project_code_counters set last_value = 999999 where country_id = pg_temp.cid('zy');
select pg_temp.act_as(pg_temp.u('a'));
insert into public.projects (id, name_ar, type, geom, country_id)
values (pg_temp.cid('p9'), 'p9', 'mosque', pg_temp.pt(-25.0, -49.5), pg_temp.cid('zy'));
select is((select code from public.projects where id = pg_temp.cid('p9')), 'ZY-XX-1000000',
  'code: the counter is not truncated after 999999');

select ok(not has_function_privilege('authenticated', 'private.next_project_code(uuid, uuid)', 'EXECUTE')
          and not has_function_privilege('service_role', 'private.next_project_code(uuid, uuid)', 'EXECUTE')
          and not has_function_privilege('anon', 'private.next_project_code(uuid, uuid)', 'EXECUTE'),
  'code: no API role can call next_project_code() and burn numbers');

-- ---- 5. admin area ------------------------------------------------------------
select is((select array[country_id, admin_area_id] from public.projects where id = pg_temp.cid('p1')),
  array[pg_temp.cid('zz'), pg_temp.cid('zn_w')],
  'area: the deepest polygon containing the point (level 3) overrides the client''s country and area');
select is((select array[country_id, admin_area_id] from public.projects where id = pg_temp.cid('p2')),
  array[pg_temp.cid('zz'), pg_temp.cid('zn_d')],
  'area: a point in the district but outside every ward gets the district and its country');
select is((select array[country_id, admin_area_id] from public.projects where id = pg_temp.cid('p4')),
  array[pg_temp.cid('zz'), pg_temp.cid('zn')],
  'area: a point inside the region only gets the level-1 area');
select is((select array[country_id, admin_area_id] from public.projects where id = pg_temp.cid('p3')),
  array[pg_temp.cid('zz'), pg_temp.cid('zr')],
  'area fallback: no polygon contains the point, the manual area is kept and decides the country');
select is((select array[country_id, admin_area_id] from public.projects where id = pg_temp.cid('p7')),
  array[pg_temp.cid('zy'), null],
  'area fallback: no polygon and no manual area, the supplied country is kept');
select throws_ok(
  $$ insert into public.projects (name_ar, type, geom) values ('nowhere', 'mosque', pg_temp.pt(-25.0, -49.5)) $$,
  '23502', null,
  'area: a project whose country can be neither derived nor supplied is refused (NOT NULL)');

select results_eq(
  $$ select id, country_id, level::int from private.deepest_admin_area(pg_temp.pt(-29.6, -49.6)) $$,
  $$ values (pg_temp.cid('zn_w'), pg_temp.cid('zz'), 3) $$,
  'deepest_admin_area() returns the level-3 area for a point inside the ward');
select is_empty(
  $$ select * from private.deepest_admin_area(pg_temp.pt(-25.0, -49.5)) $$,
  'deepest_admin_area() returns no row when nothing contains the point');

-- Updates re-derive.
update public.projects set geom = pg_temp.pt(-29.45, -49.45) where id = pg_temp.cid('p1');
select is((select admin_area_id from public.projects where id = pg_temp.cid('p1')), pg_temp.cid('zn_d'),
  'area: moving the point re-derives the admin area');
update public.projects set admin_area_id = pg_temp.cid('zr') where id = pg_temp.cid('p1');
select is((select admin_area_id from public.projects where id = pg_temp.cid('p1')), pg_temp.cid('zn_d'),
  'area: a manual correction is overridden while a polygon contains the point (decision D5)');
select is((select code from public.projects where id = pg_temp.cid('p1')), 'ZZ-ZN-000001',
  'area: the code does not change when the area changes');

update public.projects set admin_area_id = pg_temp.cid('ya') where id = pg_temp.cid('p3');
select is((select array[country_id, admin_area_id] from public.projects where id = pg_temp.cid('p3')),
  array[pg_temp.cid('zy'), pg_temp.cid('ya')],
  'area fallback: without a polygon a manual correction is accepted and the country follows it');

update public.projects set geom = pg_temp.pt(-29.6, -49.6) where id = pg_temp.cid('p7');
select is((select array[country_id, admin_area_id] from public.projects where id = pg_temp.cid('p7')),
  array[pg_temp.cid('zz'), pg_temp.cid('zn_w')],
  'area: a point moved into a polygon takes its area and country');

-- A soft-deleted boundary is ignored.
select pg_temp.act_as_server();
update public.admin_areas set deleted_at = now() where id = pg_temp.cid('zn_w');
select pg_temp.act_as(pg_temp.u('a'));
update public.projects set geom = pg_temp.pt(-29.61, -49.61) where id = pg_temp.cid('p6');
select is((select admin_area_id from public.projects where id = pg_temp.cid('p6')), pg_temp.cid('zn_d'),
  'area: a soft-deleted boundary is ignored (the district is now the deepest live area)');
select pg_temp.act_as_server();
update public.admin_areas set deleted_at = null where id = pg_temp.cid('zn_w');

-- Localities follow the same rule.
select pg_temp.act_as(pg_temp.u('a'));
insert into public.localities (id, country_id, name_ar, name_latin, geom, name_norm)
values (pg_temp.cid('loc'), pg_temp.cid('zy'), U&'\0642\0631\064A\0629 \0627\0644\0646\0648\0631', 'Kijiji Nuru',
        pg_temp.pt(-29.6, -49.6), 'zzz');
select is((select array[country_id, admin_area_id] from public.localities where id = pg_temp.cid('loc')),
  array[pg_temp.cid('zz'), pg_temp.cid('zn_w')],
  'localities: country and area are derived from the point by the same rule');
select is((select array[status, approved_by::text] from public.localities where id = pg_temp.cid('loc')),
  array['proposed', null],
  'localities: a new locality is proposed and carries no approval stamp');
select pg_temp.act_as(pg_temp.u('b'));
update public.localities set status = 'approved' where id = pg_temp.cid('loc');
select ok((select approved_by = pg_temp.u('b') and approved_at = now() from public.localities where id = pg_temp.cid('loc')),
  'localities: approving stamps approved_by / approved_at');

-- admin_areas: parent rule and geom_simple.
select pg_temp.act_as_server();
select throws_ok(
  $$ insert into public.admin_areas (country_id, parent_id, level, code, name_en)
     values (pg_temp.cid('zz'), pg_temp.cid('zn_d'), 2, 'CORE-BAD-1', 'bad level') $$,
  'PT422', 'admin_area_parent_mismatch', 'admin_areas: the parent must be exactly one level above');
select throws_ok(
  $$ insert into public.admin_areas (country_id, parent_id, level, code, name_en)
     values (pg_temp.cid('zy'), pg_temp.cid('zn'), 2, 'CORE-BAD-2', 'bad country') $$,
  'PT422', 'admin_area_parent_mismatch', 'admin_areas: the parent must be in the same country');
select throws_ok(
  $$ insert into public.admin_areas (country_id, parent_id, level, code, name_en)
     values (pg_temp.cid('zz'), pg_temp.cid('zn'), 1, 'CORE-BAD-3', 'level 1 with parent') $$,
  'PT422', 'admin_area_parent_mismatch', 'admin_areas: level 1 has no parent');
select is(
  (select array[count(*) filter (where geom is not null and geom_simple is not null),
                count(*) filter (where geom is null and geom_simple is null)]::int[]
   from public.admin_areas where country_id in (pg_temp.cid('zz'), pg_temp.cid('zy'))),
  array[4, 1],
  'admin_areas: geom_simple is derived from geom on insert (and stays null without a shape)');
update public.admin_areas set geom = pg_temp.sq(-20.0, -50.0, -18.0, -49.0) where id = pg_temp.cid('ya');
select ok((select st_equals(geom_simple, geom) from public.admin_areas where id = pg_temp.cid('ya')),
  'admin_areas: changing geom refreshes geom_simple');

-- =============================================================================
-- 6. Completeness (schema.md section 5)
-- =============================================================================
select pg_temp.act_as(pg_temp.u('a'));

select is((select completeness::int from public.projects where id = pg_temp.cid('p1')), 40,
  'completeness p1: name_ar 10 + name_latin 5 + location 15 + admin_area 5 + capacity 5 (the value sent by the client is ignored)');
select is((select completeness::int from public.projects where id = pg_temp.cid('p5')), 10,
  'completeness: a draft with only an Arabic name scores 10');
select is((select completeness::int from public.projects where id = pg_temp.cid('p9')), 25,
  'completeness: name + location without an admin area scores 25');

-- c1 is filled step by step.
insert into public.projects (id, name_ar, type, country_id)
values (pg_temp.cid('c1'), 'c1', 'mosque', pg_temp.cid('zz'));
update public.projects set name_latin = '   ' where id = pg_temp.cid('c1');
select is((select completeness::int from public.projects where id = pg_temp.cid('c1')), 10,
  'completeness: a blank name_latin does not count');
update public.projects set name_latin = 'Masjid C1' where id = pg_temp.cid('c1');
select is((select completeness::int from public.projects where id = pg_temp.cid('c1')), 15,
  'completeness: + name_latin 5');
update public.projects set geom = pg_temp.pt(-29.6, -49.6) where id = pg_temp.cid('c1');
select is((select completeness::int from public.projects where id = pg_temp.cid('c1')), 35,
  'completeness: + location 15 + admin_area 5 (derived from the point)');
update public.projects set capacity = 0 where id = pg_temp.cid('c1');
select is((select completeness::int from public.projects where id = pg_temp.cid('c1')), 35,
  'completeness: capacity 0 does not count');
update public.projects set capacity = 120 where id = pg_temp.cid('c1');
select is((select completeness::int from public.projects where id = pg_temp.cid('c1')), 40,
  'completeness: + capacity 5');
update public.projects set build_date = date '2011-05-06', completeness = 3 where id = pg_temp.cid('c1');
select is((select array[completeness, build_year]::int[] from public.projects where id = pg_temp.cid('c1')),
  array[45, 2011],
  'completeness: + build_year 5 (filled from build_date); a completeness sent by the writer is overwritten');

-- Children. The project row is rewritten only when the score changes.
insert into _memo select 'c1_v', version::text from public.projects where id = pg_temp.cid('c1');
insert into public.project_photos (id, project_id) values (pg_temp.cid('c1_ph1'), pg_temp.cid('c1'));
select is((select array[completeness::int, version] from public.projects where id = pg_temp.cid('c1')),
  array[60, pg_temp.memo('c1_v')::int + 1],
  'completeness: + photos 15 with the first photo; the project gets a new version');
select is(
  (select a.changed_fields from public.audit_log a
   where a.table_name = 'projects' and a.row_id = pg_temp.cid('c1') order by a.id desc limit 1),
  array['completeness'],
  'completeness: the child-driven change is audited with changed_fields = {completeness}');
select is((select sync_xid from public.projects where id = pg_temp.cid('c1')), private.current_xid(),
  'completeness: the child-driven change stamps sync_xid, so the new score is pulled');
insert into public.project_photos (id, project_id) values (pg_temp.cid('c1_ph2'), pg_temp.cid('c1'));
select is((select array[completeness::int, version] from public.projects where id = pg_temp.cid('c1')),
  array[60, pg_temp.memo('c1_v')::int + 1],
  'completeness: a second photo changes nothing and does not touch the project row');

insert into public.project_land (id, project_id, ownership) values (pg_temp.cid('c1_land'), pg_temp.cid('c1'), 'waqf');
select is((select completeness::int from public.projects where id = pg_temp.cid('c1')), 70, 'completeness: + land 10');
insert into public.project_facilities (id, project_id, quran_need) values (pg_temp.cid('c1_fac'), pg_temp.cid('c1'), 50);
select is((select completeness::int from public.projects where id = pg_temp.cid('c1')), 80, 'completeness: + facilities 10');
insert into public.persons (id, name_latin) values (pg_temp.cid('c1_person'), 'Juma Ali');
insert into public.project_staff (id, project_id, person_id, role)
values (pg_temp.cid('c1_staff'), pg_temp.cid('c1'), pg_temp.cid('c1_person'), 'imam');
select is((select completeness::int from public.projects where id = pg_temp.cid('c1')), 90, 'completeness: + staff 10');
insert into public.community_profiles (id, project_id, livelihoods)
values (pg_temp.cid('c1_comm'), pg_temp.cid('c1'), array[pg_temp.cid('opt_liv')]);
select is((select completeness::int from public.projects where id = pg_temp.cid('c1')), 100, 'completeness: + community 10 = 100');

-- Tables outside the formula.
insert into public.community_sensitive (project_id, ibadi_families) values (pg_temp.cid('c1'), 4);
insert into public.project_maintenance (project_id, description) values (pg_temp.cid('c1'), 'Roof');
insert into public.project_donors (project_id, donor_id) values (pg_temp.cid('c1'), pg_temp.cid('d3'));
select is((select completeness::int from public.projects where id = pg_temp.cid('c1')), 100,
  'completeness: restricted rows, maintenance entries and donors are not part of the score');

-- Soft delete, restore, hard delete of children.
update public.project_land set deleted_at = now() where id = pg_temp.cid('c1_land');
select is((select completeness::int from public.projects where id = pg_temp.cid('c1')), 90,
  'completeness: soft-deleting the land row takes its 10 away');
update public.project_land set deleted_at = null where id = pg_temp.cid('c1_land');
select is((select completeness::int from public.projects where id = pg_temp.cid('c1')), 100,
  'completeness: restoring it gives them back');
update public.project_photos set deleted_at = now() where project_id = pg_temp.cid('c1');
select is((select completeness::int from public.projects where id = pg_temp.cid('c1')), 85,
  'completeness: soft-deleting every photo (one statement) takes 15 away');
select pg_temp.act_as_server();
delete from public.project_staff where id = pg_temp.cid('c1_staff');
select is((select completeness::int from public.projects where id = pg_temp.cid('c1')), 75,
  'completeness: a maintenance hard delete of the only staff row takes 10 away');
select is(
  (select array[private.project_completeness(p), private.project_completeness(p, true)]::int[]
   from public.projects p where p.id = pg_temp.cid('c1')),
  array[75, 45],
  'project_completeness(): equals the stored score; p_skip_children counts the project columns only');
select is_empty(
  $$ select p.id from public.projects p
     where p.country_id in (pg_temp.cid('zz'), pg_temp.cid('zy'))
       and p.completeness is distinct from private.project_completeness(p) $$,
  'completeness: the stored score of every test project equals the formula');

-- =============================================================================
-- 7. Photos (on p2, country ZZ)
-- =============================================================================
select pg_temp.act_as(pg_temp.u('a'));

insert into public.project_photos (id, project_id, is_cover) values (pg_temp.cid('ph1'), pg_temp.cid('p2'), true);
select is(
  (select array[storage_path_full, storage_path_thumb] from public.project_photos where id = pg_temp.cid('ph1')),
  array['projects/ZZ/' || pg_temp.cid('p2') || '/' || pg_temp.cid('ph1') || '_full.webp',
        'projects/ZZ/' || pg_temp.cid('p2') || '/' || pg_temp.cid('ph1') || '_thumb.webp'],
  'photos: missing paths default to projects/{iso2}/{project_id}/{id}_{full|thumb}.webp');

insert into public.project_photos (id, project_id, is_cover) values (pg_temp.cid('ph2'), pg_temp.cid('p2'), true);
select results_eq(
  $$ select id, is_cover, version from public.project_photos
     where id in (pg_temp.cid('ph1'), pg_temp.cid('ph2')) order by created_at, version desc $$,
  $$ values (pg_temp.cid('ph1'), false, 2), (pg_temp.cid('ph2'), true, 1) $$,
  'photos: a new cover clears the previous one (which gets a new version)');

insert into public.project_photos (id, project_id, storage_path_full, storage_path_thumb)
values (pg_temp.cid('ph3'), pg_temp.cid('p2'),
        'projects/ZZ/' || pg_temp.cid('p2') || '/' || pg_temp.cid('ph3') || '_full.jpg',
        'projects/ZZ/' || pg_temp.cid('p2') || '/' || pg_temp.cid('ph3') || '_thumb.jpeg');
select is((select is_cover from public.project_photos where id = pg_temp.cid('ph3')), false,
  'photos: explicit .jpg / .jpeg paths of the right shape are accepted; is_cover defaults to false');
select throws_ok(
  $$ insert into public.project_photos (project_id, storage_path_full)
     values (pg_temp.cid('p2'), 'projects/ZZ/other/x_full.webp') $$,
  '23514', 'new row for relation "project_photos" violates check constraint "project_photos_path_full_ck"',
  'photos: a full path outside the project folder is refused');
select throws_ok(
  $$ insert into public.project_photos (id, project_id, storage_path_thumb)
     values (pg_temp.cid('ph_bad'), pg_temp.cid('p2'),
             'projects/ZZ/' || pg_temp.cid('p2') || '/' || pg_temp.cid('ph_bad') || '_thumb.png') $$,
  '23514', 'new row for relation "project_photos" violates check constraint "project_photos_path_thumb_ck"',
  'photos: a thumbnail with another extension is refused');

update public.project_photos set is_cover = true where id = pg_temp.cid('ph3');
select is(
  (select array_agg(id order by id) from public.project_photos
   where project_id = pg_temp.cid('p2') and is_cover and deleted_at is null),
  array[pg_temp.cid('ph3')],
  'photos: promoting another photo by UPDATE leaves exactly one live cover');

update public.project_photos set deleted_at = now() where id = pg_temp.cid('ph3');
select is(
  (select array[(select is_cover from public.project_photos where id = pg_temp.cid('ph3'))::text,
                (select count(*) from public.project_photos
                 where project_id = pg_temp.cid('p2') and is_cover and deleted_at is null)::text]),
  array['false', '0'],
  'photos: a soft-deleted photo loses the cover flag and no other photo is promoted automatically');
update public.project_photos set is_cover = true where id = pg_temp.cid('ph3');
select is((select is_cover from public.project_photos where id = pg_temp.cid('ph3')), false,
  'photos: a soft-deleted photo can never be the cover');

select throws_ok(
  $$ update public.project_photos set project_id = pg_temp.cid('p1') where id = pg_temp.cid('ph2') $$,
  'PT422', 'photo_project_immutable', 'photos: a photo cannot move to another project');

-- Limit: ph1 + ph2 are live, ph3 is deleted. Eight more make ten.
insert into public.project_photos (project_id) select pg_temp.cid('p2') from generate_series(1, 8);
select is((select count(*)::int from public.project_photos where project_id = pg_temp.cid('p2') and deleted_at is null), 10,
  'photos: ten live photos are allowed');
select throws_ok(
  $$ insert into public.project_photos (project_id) values (pg_temp.cid('p2')) $$,
  'PT422', 'photo_limit_exceeded', 'photos: the 11th live photo is refused');
select throws_ok(
  $$ update public.project_photos set deleted_at = null where id = pg_temp.cid('ph3') $$,
  'PT422', 'photo_limit_exceeded', 'photos: restoring a deleted photo counts against the limit too');
update public.project_photos set deleted_at = now() where id = pg_temp.cid('ph1');
select lives_ok(
  $$ insert into public.project_photos (id, project_id) values (pg_temp.cid('ph_new'), pg_temp.cid('p2')) $$,
  'photos: soft-deleted photos do not count, a new one fits again');
select is(
  (select array[count(*) filter (where deleted_at is null), count(*)]::int[]
   from public.project_photos where project_id = pg_temp.cid('p2')),
  array[10, 12],
  'photos: 10 live rows out of 12');

insert into public.project_photos (id, project_id) values (pg_temp.cid('ph_y'), pg_temp.cid('p8'));
select is((select storage_path_thumb from public.project_photos where id = pg_temp.cid('ph_y')),
  'projects/ZY/' || pg_temp.cid('p8') || '/' || pg_temp.cid('ph_y') || '_thumb.webp',
  'photos: the default path uses the ISO2 code of the project''s country');

-- =============================================================================
-- 8. Name normalisation
-- =============================================================================
insert into public.persons (id, name_ar, name_latin, phone_e164, birth_date, name_normalized)
values (pg_temp.cid('per1'),
        U&'\0639\064E\0644\0650\064A\0651 \0628\0646 \0645\064F\062D\064E\0645\0651\064E\062F',
        U&'Al\00ED bin  MOHAMED', '+255712345678', date '1980-05-01', 'zzz');
select is((select name_normalized from public.persons where id = pg_temp.cid('per1')),
  U&'\0639\0644\064A \0628\0646 \0645\062D\0645\062F' || ' ali bin mohamed',
  'persons: name_normalized = norm(name_ar || '' '' || name_latin); the value sent by the writer is ignored');
select is((select birth_year::int from public.persons where id = pg_temp.cid('per1')), 1980,
  'persons: birth_year is filled from birth_date');
update public.persons set name_latin = 'Ally bin Mohammed', birth_date = date '1975-02-03' where id = pg_temp.cid('per1');
select is(
  (select array[name_normalized, birth_year::text] from public.persons where id = pg_temp.cid('per1')),
  array[U&'\0639\0644\064A \0628\0646 \0645\062D\0645\062F' || ' ally bin mohammed', '1975'],
  'persons: an update refreshes name_normalized and birth_year');

insert into public.donors (id, name_ar) values (pg_temp.cid('d4'), U&'\0645\0624\0633\0633\0629 \0627\0644\062E\064A\0631');
select is((select name_norm from public.donors where id = pg_temp.cid('d4')),
  U&'\0645\0624\0633\0633\0647 \0627\0644\062E\064A\0631',
  'donors: name_norm folds teh marbuta and keeps waw with hamza');
select is((select name_norm from public.donors where id = pg_temp.cid('d3')), 'donor three b',
  'donors: name_norm follows a renamed donor');

select is((select name_norm from public.localities where id = pg_temp.cid('loc')),
  U&'\0642\0631\064A\0647 \0627\0644\0646\0648\0631' || ' kijiji nuru',
  'localities: name_norm holds both scripts; the value sent by the writer is ignored');

select is((select search_norm from public.projects where id = pg_temp.cid('p1')),
  U&'\0645\0633\062C\062F \0627\0644\0646\0648\0631' || ' masjid an-nur zz-zn-000001',
  'projects: search_norm = norm(name_ar, name_latin, code); the value sent by the writer is ignored');
update public.projects set locality_id = pg_temp.cid('loc'), search_norm = 'zzz' where id = pg_temp.cid('p1');
select is((select search_norm from public.projects where id = pg_temp.cid('p1')),
  U&'\0645\0633\062C\062F \0627\0644\0646\0648\0631' || ' masjid an-nur zz-zn-000001 '
    || U&'\0642\0631\064A\0647 \0627\0644\0646\0648\0631' || ' kijiji nuru',
  'projects: search_norm also carries the names of the locality');
insert into _memo select 'p1_v', version::text from public.projects where id = pg_temp.cid('p1');
update public.localities set name_latin = 'Kijiji Amani' where id = pg_temp.cid('loc');
select is(
  (select array[search_norm, version::text] from public.projects where id = pg_temp.cid('p1')),
  array[U&'\0645\0633\062C\062F \0627\0644\0646\0648\0631' || ' masjid an-nur zz-zn-000001 '
          || U&'\0642\0631\064A\0647 \0627\0644\0646\0648\0631' || ' kijiji amani',
        (pg_temp.memo('p1_v')::int + 1)::text],
  'projects: renaming the locality refreshes search_norm of its projects (new version)');

-- =============================================================================
-- 9. Validation
-- =============================================================================
select throws_ok(
  $$ insert into public.projects (name_ar, type, country_id) values ('x', 'church', pg_temp.cid('zz')) $$,
  '23514', 'new row for relation "projects" violates check constraint "projects_type_ck"',
  'projects: unknown type');
select throws_ok(
  $$ insert into public.projects (name_ar, type, status, country_id) values ('x', 'mosque', 'closed', pg_temp.cid('zz')) $$,
  '23514', 'new row for relation "projects" violates check constraint "projects_status_ck"',
  'projects: unknown status');
select throws_ok(
  $$ insert into public.projects (name_ar, type, record_state, geom) values ('x', 'mosque', 'published', pg_temp.pt(-29.6, -49.6)) $$,
  '23514', 'new row for relation "projects" violates check constraint "projects_record_state_ck"',
  'projects: unknown record_state');
select throws_ok(
  $$ insert into public.projects (name_ar, type, record_state, country_id) values ('x', 'mosque', 'submitted', pg_temp.cid('zz')) $$,
  '23514', 'new row for relation "projects" violates check constraint "projects_geom_required_ck"',
  'projects: only a draft may lack a location');
select throws_ok(
  $$ update public.projects set record_state = 'submitted' where id = pg_temp.cid('p5') $$,
  '23514', 'new row for relation "projects" violates check constraint "projects_geom_required_ck"',
  'projects: a draft without a location cannot be submitted');
select throws_ok(
  $$ insert into public.projects (name_ar, type, country_id) values ('   ', 'mosque', pg_temp.cid('zz')) $$,
  '23514', 'new row for relation "projects" violates check constraint "projects_name_ar_ck"',
  'projects: a blank Arabic name');
select throws_ok(
  $$ update public.projects set capacity = -1 where id = pg_temp.cid('p5') $$,
  '23514', 'new row for relation "projects" violates check constraint "projects_capacity_ck"',
  'projects: a negative capacity');
select throws_ok(
  $$ update public.projects set build_year = 1700 where id = pg_temp.cid('p5') $$,
  '23514', 'new row for relation "projects" violates check constraint "projects_build_year_ck"',
  'projects: a build year out of range');
select throws_ok(
  $$ update public.projects set geom = pg_temp.pt(200, 0) where id = pg_temp.cid('p5') $$,
  '23514', 'new row for relation "projects" violates check constraint "projects_geom_ck"',
  'projects: a longitude out of range');
select throws_ok(
  $$ update public.projects set location_source = 'guess' where id = pg_temp.cid('p5') $$,
  '23514', 'new row for relation "projects" violates check constraint "projects_location_source_ck"',
  'projects: unknown location_source');
select throws_ok(
  $$ insert into public.projects (name_ar, type, country_id, external_id) values
       ('e1', 'mosque', pg_temp.cid('zz'), 'CORE-EXT-1'), ('e2', 'mosque', pg_temp.cid('zz'), 'CORE-EXT-1') $$,
  '23505', 'duplicate key value violates unique constraint "projects_external_id_key"',
  'projects: external_id is unique');

-- Review stamp.
select pg_temp.act_as(pg_temp.u('b'));
update public.projects set record_state = 'approved' where id = pg_temp.cid('p2');
select ok((select reviewed_by = pg_temp.u('b') and reviewed_at = now() from public.projects where id = pg_temp.cid('p2')),
  'projects: approving stamps reviewed_by / reviewed_at');
select pg_temp.act_as(pg_temp.u('a'));

select throws_ok(
  $$ insert into public.persons (name_latin, phone_e164) values ('Bad Phone', '0712345678') $$,
  '23514', 'new row for relation "persons" violates check constraint "persons_phone_ck"',
  'persons: the phone must be E.164');
select throws_ok(
  $$ insert into public.persons (name_ar, name_latin) values ('  ', null) $$,
  '23514', 'new row for relation "persons" violates check constraint "persons_name_ck"',
  'persons: at least one name is required');
select throws_ok(
  $$ insert into public.donors (name_ar, name_latin) values (null, '') $$,
  '23514', 'new row for relation "donors" violates check constraint "donors_name_ck"',
  'donors: at least one name is required');

-- 1:1 children: a second live row is refused, a soft-deleted one makes room.
select throws_ok(
  $$ insert into public.project_land (project_id) values (pg_temp.cid('c1')) $$,
  '23505', 'duplicate key value violates unique constraint "project_land_project_live_key"',
  'project_land: a second live row for the same project is refused');
update public.project_land set deleted_at = now() where id = pg_temp.cid('c1_land');
select lives_ok(
  $$ insert into public.project_land (project_id, ownership) values (pg_temp.cid('c1'), 'person') $$,
  'project_land: after a soft delete a new live row is accepted');

-- staff_compensation
insert into public.project_staff (id, project_id, person_id, role)
values (pg_temp.cid('p2_staff'), pg_temp.cid('p2'), pg_temp.cid('per1'), 'teacher');
select throws_ok(
  $$ insert into public.staff_compensation (project_staff_id, monthly_amount, currency)
     values (pg_temp.cid('p2_staff'), 100, 'EUR') $$,
  '23514', 'new row for relation "staff_compensation" violates check constraint "staff_compensation_currency_ck"',
  'staff_compensation: only the documented currencies');
select lives_ok(
  $$ insert into public.staff_compensation (project_staff_id, monthly_amount, currency, effective_from)
     values (pg_temp.cid('p2_staff'), 250000, 'TZS', date '2026-01-01') $$,
  'staff_compensation: a valid row');
select throws_ok(
  $$ insert into public.staff_compensation (project_staff_id, monthly_amount, currency, effective_from)
     values (pg_temp.cid('p2_staff'), 300000, 'TZS', date '2026-01-01') $$,
  '23505', 'duplicate key value violates unique constraint "staff_compensation_live_key"',
  'staff_compensation: one live row per staff member and effective date');

-- community_profiles: option ids must belong to the list of the column.
select throws_ok(
  $$ insert into public.community_profiles (project_id, daawa_activities)
     values (pg_temp.cid('p2'), array[pg_temp.cid('opt_liv')]) $$,
  'PT422', 'invalid_option_value', 'community_profiles: an option of another list is refused');
select throws_ok(
  $$ insert into public.community_profiles (project_id, livelihoods)
     values (pg_temp.cid('p2'), array[pg_temp.cid('opt_liv'), pg_temp.cid('no_such_option')]) $$,
  'PT422', 'invalid_option_value', 'community_profiles: an unknown option id is refused');
select throws_ok(
  $$ update public.community_profiles set livelihoods = array[pg_temp.cid('opt_daawa')] where id = pg_temp.cid('c1_comm') $$,
  'PT422', 'invalid_option_value', 'community_profiles: the check also runs on UPDATE');
select pg_temp.act_as_server();
update public.option_values set active = false, deleted_at = now() where id = pg_temp.cid('opt_daawa');
select pg_temp.act_as(pg_temp.u('a'));
select lives_ok(
  $$ insert into public.community_profiles (project_id, daawa_activities, livelihoods)
     values (pg_temp.cid('p2'), array[pg_temp.cid('opt_daawa')], array[pg_temp.cid('opt_liv')]) $$,
  'community_profiles: inactive / soft-deleted options stay valid');

-- user_roles
select pg_temp.act_as_server();
select throws_ok(
  $$ insert into public.user_roles (user_id, role, scope_type, scope_id)
     values (pg_temp.u('a'), 'field_collector', 'branch', pg_temp.cid('zz')) $$,
  'PT422', 'invalid_scope', 'user_roles: a branch scope must reference a branch');
select throws_ok(
  $$ insert into public.user_roles (user_id, role, scope_type, scope_id)
     values (pg_temp.u('a'), 'country_manager', 'country', pg_temp.cid('br')) $$,
  'PT422', 'invalid_scope', 'user_roles: a country scope must reference a country');
select throws_ok(
  $$ insert into public.user_roles (user_id, role, scope_type, scope_id)
     values (pg_temp.u('a'), 'hq_admin', 'country', pg_temp.cid('zz')) $$,
  '23514', 'new row for relation "user_roles" violates check constraint "user_roles_hq_global_ck"',
  'user_roles: hq_admin must be global');
select throws_ok(
  $$ insert into public.user_roles (user_id, role, scope_type, scope_id)
     values (pg_temp.u('a'), 'viewer', 'global', pg_temp.cid('zz')) $$,
  '23514', 'new row for relation "user_roles" violates check constraint "user_roles_scope_id_ck"',
  'user_roles: a global scope has no scope_id');
select throws_ok(
  $$ insert into public.user_roles (user_id, role, scope_type, scope_id)
     values (pg_temp.u('a'), 'owner', 'global', null) $$,
  '23514', 'new row for relation "user_roles" violates check constraint "user_roles_role_ck"',
  'user_roles: unknown role');
select lives_ok(
  $$ insert into public.user_roles (user_id, role, scope_type, scope_id) values
       (pg_temp.u('a'), 'field_collector', 'branch', pg_temp.cid('br')),
       (pg_temp.u('a'), 'viewer', 'global', null) $$,
  'user_roles: valid branch and global grants');
select throws_ok(
  $$ insert into public.user_roles (user_id, role, scope_type, scope_id) values (pg_temp.u('a'), 'viewer', 'global', null) $$,
  '23505', 'duplicate key value violates unique constraint "user_roles_live_key"',
  'user_roles: the same live grant twice is refused (NULL scope ids are not distinct)');

-- =============================================================================
-- 10. Hard delete, truncate, append-only logs
-- =============================================================================
-- On behalf of an end user (JWT role authenticated / anon), whatever the database role.
select pg_temp.act_as(pg_temp.u('a'));
select throws_ok(
  $$ delete from public.donors where id = pg_temp.cid('d4') $$,
  'PT403', 'hard_delete_forbidden', 'hard delete: DELETE on behalf of an end user is refused, even for the table owner');
select throws_ok(
  $$ truncate public.project_donors $$,
  'PT403', 'hard_delete_forbidden', 'hard delete: TRUNCATE on behalf of an end user is refused');
select throws_ok(
  $$ delete from public.sync_applied_ops $$,
  'PT403', 'hard_delete_forbidden', 'hard delete: the tables without standard columns are protected too');
select pg_temp.act_as(null, 'anon');
select throws_ok(
  $$ delete from public.project_maintenance $$,
  'PT403', 'hard_delete_forbidden', 'hard delete: refused for the JWT role anon');

-- Directly as an API role (no JWT at all).
select pg_temp.act_as_server();
set local role service_role;
select throws_ok(
  'delete from public.project_donors',
  'PT403', 'hard_delete_forbidden', 'hard delete: service_role cannot DELETE');
select throws_ok(
  'truncate public.project_maintenance',
  'PT403', 'hard_delete_forbidden', 'hard delete: service_role cannot TRUNCATE');
reset role;

-- Owner without an end-user JWT (migrations, cron, maintenance functions): allowed and audited.
select lives_ok(
  $$ delete from public.donors where id = pg_temp.cid('d1') $$,
  'hard delete: maintenance code without an end-user JWT may delete');
select results_eq(
  $$ select op, row_version, changed_fields, new_data is null, old_data ->> 'name_latin', user_id
     from public.audit_log where table_name = 'donors' and row_id = pg_temp.cid('d1') order by id desc limit 1 $$,
  $$ values ('DELETE', 2, null::text[], true, 'Donor One', pg_temp.u('b')) $$,
  'audit DELETE: row_version is the version before the delete, new_data is null, old_data is the row');

-- Append-only logs: nobody updates, deletes or truncates them.
select throws_ok(
  $$ update public.audit_log set op = 'DELETE' $$,
  'PT403', 'append_only_table', 'audit_log: UPDATE is refused, even for the owner');
select throws_ok(
  'delete from public.audit_log',
  'PT403', 'append_only_table', 'audit_log: DELETE is refused, even for the owner');
select throws_ok(
  'truncate public.audit_log',
  'PT403', 'append_only_table', 'audit_log: TRUNCATE is refused, even for the owner');
select throws_ok(
  $$ update public.restricted_access_log set context = 'x' $$,
  'PT403', 'append_only_table', 'restricted_access_log: UPDATE is refused');
select throws_ok(
  'delete from public.restricted_access_log',
  'PT403', 'append_only_table', 'restricted_access_log: DELETE is refused');
select throws_ok(
  'truncate public.restricted_access_log',
  'PT403', 'append_only_table', 'restricted_access_log: TRUNCATE is refused');

select * from finish();
rollback;

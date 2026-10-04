-- =============================================================================
-- 22  Field-level merge, sync_conflicts and resolve_conflict()
--     (brief §4.3 and acceptance criterion 4; docs/contracts/sync.md)
--
-- Two devices edit the same record offline:
--   * different fields  -> merged automatically
--   * the same field    -> a sync_conflicts row; a supervisor chooses
-- =============================================================================
begin;
set local search_path = public, extensions, tests;

select plan(65);

-- Deterministic transaction-id clock (explained in 23_sync_pull.test.sql): the
-- whole file is one transaction, so sync_pull would otherwise never see the
-- rows written here.
create or replace function private.current_xid() returns bigint language sql stable as
$fn$ select current_setting('test.xid')::bigint $fn$;
create or replace function private.safe_xid() returns bigint language sql stable as
$fn$ select current_setting('test.safe')::bigint $fn$;

do $$
begin
  perform set_config('test.xid', '100', true);
  perform set_config('test.safe', '101', true);
  perform tests.fixture();
end $$;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------
create temp table res (k text primary key, v jsonb) on commit drop;

create function pg_temp.nid(p_n integer) returns uuid language sql immutable as
$fn$ select ('00000000-0000-7000-9000-' || lpad(p_n::text, 12, '0'))::uuid $fn$;

create function pg_temp.op(
  p_n integer, p_table text, p_id uuid, p_base integer, p_fields jsonb, p_kind text default 'upsert')
returns jsonb language sql immutable as
$fn$
  select jsonb_build_object(
    'op_id', ('00000000-0000-7000-8000-' || lpad(p_n::text, 12, '0'))::uuid,
    'table', p_table, 'id', p_id, 'kind', p_kind, 'base_version', p_base,
    'fields', coalesce(p_fields, '{}'::jsonb));
$fn$;

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

create function pg_temp.resolve(p_user uuid, p_conflict uuid, p_choice text, p_aal text default 'aal1')
returns jsonb language plpgsql as
$fn$
declare
  r jsonb;
begin
  perform tests.login_as(p_user, p_aal, 'dev-review');
  r := public.resolve_conflict(p_conflict, p_choice);
  perform tests.logout();
  return r;
end;
$fn$;

-- ids of one table in a full pull (null cursor, limit 1000)
create function pg_temp.pulled(p_user uuid, p_table text, p_aal text default 'aal1')
returns uuid[] language plpgsql as
$fn$
declare
  r jsonb;
  v uuid[];
begin
  perform tests.login_as(p_user, p_aal, 'dev-review');
  r := public.sync_pull(null, 1000);
  perform tests.logout();
  select coalesce(array_agg((x ->> 'id')::uuid), '{}'::uuid[]) into v
  from jsonb_array_elements(r -> 'changes') ch, jsonb_array_elements(ch -> 'rows') x
  where ch ->> 'table' = p_table;
  return v;
end;
$fn$;

create function pg_temp.st(p_k text) returns text[] language sql stable as
$fn$
  select array_agg(e.value ->> 'status' order by e.ord)
  from res, jsonb_array_elements(res.v -> 'results') with ordinality as e(value, ord)
  where res.k = p_k;
$fn$;

create function pg_temp.r(p_k text, p_i integer) returns jsonb language sql stable as
$fn$ select res.v -> 'results' -> p_i from res where res.k = p_k $fn$;

-- first conflict id of a stored push result
create function pg_temp.cid(p_k text, p_i integer default 0) returns uuid language sql stable as
$fn$ select (res.v -> 'results' -> p_i -> 'conflict_ids' ->> 0)::uuid from res where res.k = p_k $fn$;

create function pg_temp.ver(p_table text, p_id uuid) returns integer language plpgsql stable as
$fn$
declare
  v integer;
begin
  execute format('select version from public.%I where id = $1', p_table) into v using p_id;
  return v;
end;
$fn$;

-- "what both devices have": remember the current version under a name
create function pg_temp.mark(p_k text, p_table text, p_id uuid) returns void language sql as
$fn$
  insert into res values (p_k, to_jsonb(pg_temp.ver(p_table, p_id)))
  on conflict (k) do update set v = excluded.v;
$fn$;

create function pg_temp.base(p_k text) returns integer language sql stable as
$fn$ select (res.v #>> '{}')::integer from res where res.k = p_k $fn$;

-- The record both devices will edit, created by the collector on device A.
insert into res
select 'setup', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(1, 'projects', pg_temp.nid(1), 0, jsonb_build_object(
    'name_ar', 'الاسم الأصلي', 'name_latin', 'Original', 'type', 'mosque', 'capacity', 100,
    'builder', 'B0', 'lon', 39.70, 'lat', -5.00, 'country_id', tests.id('tz'))),
  pg_temp.op(2, 'project_maintenance', pg_temp.nid(2), 0, jsonb_build_object(
    'project_id', pg_temp.nid(1), 'description', 'Roof')),
  pg_temp.op(3, 'project_maintenance', pg_temp.nid(3), 0, jsonb_build_object(
    'project_id', pg_temp.nid(1), 'description', 'Door'))));

select is(pg_temp.st('setup'), array['applied', 'applied', 'applied'], 'setup: record created from device A');

-- =============================================================================
-- 1. Different fields: automatic merge
-- =============================================================================
do $$ begin perform pg_temp.mark('v0', 'projects', pg_temp.nid(1)); end $$;

-- device A (collector) and device S (supervisor) both start from version v0
insert into res
select 'm1', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(10, 'projects', pg_temp.nid(1), pg_temp.base('v0'), jsonb_build_object('name_ar', 'اسم من الجهاز أ'))));
insert into res
select 'm2', pg_temp.push(tests.id('u_sup_pemba'), 'dev-s', jsonb_build_array(
  pg_temp.op(11, 'projects', pg_temp.nid(1), pg_temp.base('v0'), jsonb_build_object('capacity', 250))));

select is(pg_temp.st('m1'), array['applied'], 'device A: first writer, base = current -> applied');
select is(pg_temp.st('m2'), array['merged'], 'device S: stale base but a different field -> merged automatically');
select is(
  (select row(p.name_ar, p.capacity)::text from public.projects p where p.id = pg_temp.nid(1)),
  row('اسم من الجهاز أ'::text, 250)::text, 'both edits are stored');
select is((pg_temp.r('m2', 0) ->> 'version')::int, pg_temp.base('v0') + 2,
  'each applied edit produced one new version');
select is(
  (select count(*)::int from public.sync_conflicts c where c.row_id = pg_temp.nid(1)), 0,
  'no conflict is recorded for disjoint fields');

-- =============================================================================
-- 2. The same field on both sides: conflict for the supervisor
-- =============================================================================
do $$ begin perform pg_temp.mark('v2', 'projects', pg_temp.nid(1)); end $$;

insert into res
select 'c1', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(20, 'projects', pg_temp.nid(1), pg_temp.base('v2'), jsonb_build_object('builder', 'Builder A'))));
-- the second device changes the same field (and one more) from the same base
insert into res
select 'c2', pg_temp.push(tests.id('u_col_pemba'), 'dev-a2', jsonb_build_array(
  pg_temp.op(21, 'projects', pg_temp.nid(1), pg_temp.base('v2'),
             jsonb_build_object('builder', 'Builder A2', 'status', 'maintenance'))));

select is(pg_temp.st('c1') || pg_temp.st('c2'), array['applied', 'conflict'],
  'same field edited on two devices: the second push reports a conflict');
select is(pg_temp.r('c2', 0) -> 'conflict_fields', '["builder"]'::jsonb, 'the conflicting field is named');
select is(pg_temp.r('c2', 0) -> 'server_values', '{"builder": "Builder A"}'::jsonb,
  'the current server value is returned so the device can show it');
select is(
  (select row(p.builder, p.status)::text from public.projects p where p.id = pg_temp.nid(1)),
  row('Builder A'::text, 'maintenance'::text)::text,
  'the server keeps its value for the conflicting field; the non-conflicting field of the same op is applied');
select is(
  (select row(c.table_name, c.row_id, c.project_id, c.field, c.base_version, c.server_value, c.client_value,
              c.client_user_id, c.client_device_id, c.client_op_id, c.state)::text
   from public.sync_conflicts c where c.id = pg_temp.cid('c2')),
  row('projects'::text, pg_temp.nid(1), pg_temp.nid(1), 'builder'::text, pg_temp.base('v2'),
      '"Builder A"'::jsonb, '"Builder A2"'::jsonb, tests.id('u_col_pemba'), 'dev-a2'::text,
      '00000000-0000-7000-8000-000000000021'::uuid, 'open'::text)::text,
  'one open sync_conflicts row with both values, the base version, user, device and op');

-- replaying the conflicting op must not create a second conflict
insert into res
select 'c3', pg_temp.push(tests.id('u_col_pemba'), 'dev-a2', jsonb_build_array(
  pg_temp.op(21, 'projects', pg_temp.nid(1), pg_temp.base('v2'),
             jsonb_build_object('builder', 'Builder A2', 'status', 'maintenance'))));
select is(
  array[pg_temp.r('c3', 0) ->> 'status', pg_temp.r('c3', 0) ->> 'original_status'],
  array['duplicate', 'conflict'], 'replay of the conflicting op: duplicate, original outcome conflict');
select is(pg_temp.r('c3', 0) -> 'conflict_ids', pg_temp.r('c2', 0) -> 'conflict_ids',
  'replay returns the same conflict id');
select is(
  (select count(*)::int from public.sync_conflicts c where c.row_id = pg_temp.nid(1)), 1,
  'replay created no second conflict row');

-- the same proposal arriving again as a NEW op (another device) joins the open conflict
insert into res
select 'c3b', pg_temp.push(tests.id('u_sup_pemba'), 'dev-s', jsonb_build_array(
  pg_temp.op(22, 'projects', pg_temp.nid(1), pg_temp.base('v2'), jsonb_build_object('builder', 'Builder A2'))));
select is(pg_temp.r('c3b', 0) -> 'conflict_ids', pg_temp.r('c2', 0) -> 'conflict_ids',
  'an identical proposal for the same field re-uses the open conflict');
select is(
  (select count(*)::int from public.sync_conflicts c where c.row_id = pg_temp.nid(1)), 1,
  'open conflicts do not pile up');

-- the conflict shows up for the supervisor (sync_pull), not for the collector
select ok(pg_temp.cid('c2') = any (pg_temp.pulled(tests.id('u_sup_pemba'), 'sync_conflicts')),
  'the branch supervisor receives the conflict through sync_pull');
select is(pg_temp.pulled(tests.id('u_col_pemba'), 'sync_conflicts'), '{}'::uuid[],
  'collectors do not receive sync_conflicts');
select ok(not (pg_temp.cid('c2') = any (pg_temp.pulled(tests.id('u_mgr_ke'), 'sync_conflicts', 'aal2'))),
  'a manager of another country does not receive it');

-- =============================================================================
-- 3. resolve_conflict: only a reviewer of the record's scope, both choices
-- =============================================================================
select throws_ok(
  format($q$select pg_temp.resolve(%L::uuid, %L::uuid, 'client')$q$, tests.id('u_col_pemba'), pg_temp.cid('c2')),
  'PT403', 'out_of_scope', 'a collector cannot resolve a conflict');
select throws_ok(
  format($q$select pg_temp.resolve(%L::uuid, %L::uuid, 'client', 'aal2')$q$, tests.id('u_mgr_ke'), pg_temp.cid('c2')),
  'PT403', 'out_of_scope', 'a manager of another country cannot resolve it');
select throws_ok(
  format($q$select pg_temp.resolve(%L::uuid, %L::uuid, 'both')$q$, tests.id('u_sup_pemba'), pg_temp.cid('c2')),
  'PT422', 'invalid_choice', 'the choice must be server or client');
select throws_ok(
  format($q$select pg_temp.resolve(%L::uuid, %L::uuid, 'server')$q$, tests.id('u_sup_pemba'), pg_temp.nid(404)),
  'PT404', 'conflict_not_found', 'unknown conflict id');

do $$ begin perform pg_temp.mark('v3', 'projects', pg_temp.nid(1)); end $$;
insert into res
select 'r1', pg_temp.resolve(tests.id('u_sup_pemba'), pg_temp.cid('c2'), 'client');

select is((select v ->> 'state' from res where k = 'r1'), 'resolved_client', 'supervisor chooses the client value');
select is(
  (select row(p.builder, p.version)::text from public.projects p where p.id = pg_temp.nid(1)),
  row('Builder A2'::text, pg_temp.base('v3') + 1)::text,
  'choice "client": the client value is written as a new version');
select is(
  (select row(c.state, c.resolved_by, c.resolved_at is not null)::text
   from public.sync_conflicts c where c.id = pg_temp.cid('c2')),
  row('resolved_client'::text, tests.id('u_sup_pemba'), true)::text,
  'the conflict is stamped with state, resolved_by and resolved_at');
select throws_ok(
  format($q$select pg_temp.resolve(%L::uuid, %L::uuid, 'server')$q$, tests.id('u_sup_pemba'), pg_temp.cid('c2')),
  'PT409', 'conflict_already_resolved', 'a conflict is resolved once');

-- second conflict, resolved the other way (by the country manager)
do $$ begin perform pg_temp.mark('v4', 'projects', pg_temp.nid(1)); end $$;
insert into res
select 'c4', pg_temp.push(tests.id('u_sup_pemba'), 'dev-s', jsonb_build_array(
  pg_temp.op(30, 'projects', pg_temp.nid(1), pg_temp.base('v4'), jsonb_build_object('name_latin', 'Latin S'))));
insert into res
select 'c5', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(31, 'projects', pg_temp.nid(1), pg_temp.base('v4'), jsonb_build_object('name_latin', 'Latin A'))));

select is(pg_temp.st('c4') || pg_temp.st('c5'), array['applied', 'conflict'], 'second conflict (collector vs supervisor)');

do $$ begin perform pg_temp.mark('v5', 'projects', pg_temp.nid(1)); end $$;
insert into res
select 'r2', pg_temp.resolve(tests.id('u_mgr_tz'), pg_temp.cid('c5'), 'server', 'aal2');

select is(
  (select row(p.name_latin, p.version)::text from public.projects p where p.id = pg_temp.nid(1)),
  row('Latin S'::text, pg_temp.base('v5'))::text,
  'choice "server": the row is left as it is (no new version)');
select is(
  (select row(c.state, c.resolved_by)::text from public.sync_conflicts c where c.id = pg_temp.cid('c5')),
  row('resolved_server'::text, tests.id('u_mgr_tz'))::text,
  'the country manager resolved it as resolved_server');

-- =============================================================================
-- 4. Consecutive operations of the SAME device never conflict with each other
-- =============================================================================
do $$ begin perform pg_temp.mark('v6', 'projects', pg_temp.nid(1)); end $$;
-- three edits queued offline on device A, all recorded against the same base
insert into res
select 's1', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(40, 'projects', pg_temp.nid(1), pg_temp.base('v6'), jsonb_build_object('capacity', 111)),
  pg_temp.op(41, 'projects', pg_temp.nid(1), pg_temp.base('v6'), jsonb_build_object('capacity', 222)),
  pg_temp.op(42, 'projects', pg_temp.nid(1), pg_temp.base('v6'),
             jsonb_build_object('capacity', 333, 'build_year', 2001))));

select is(pg_temp.st('s1'), array['applied', 'applied', 'applied'],
  'same device, same field, stale base: applied in order, no conflict');
select is(
  (select row(p.capacity, p.build_year, p.version)::text from public.projects p where p.id = pg_temp.nid(1)),
  row(333, 2001::smallint, pg_temp.base('v6') + 3)::text, 'the last edit of the device wins, three versions');
select is(
  (select count(*)::int from public.sync_conflicts c where c.row_id = pg_temp.nid(1) and c.state = 'open'), 0,
  'no open conflict was created by the device''s own edits');

-- =============================================================================
-- 5. Same value on both sides is not a conflict
-- =============================================================================
do $$ begin perform pg_temp.mark('v7', 'projects', pg_temp.nid(1)); end $$;
insert into res
select 'e1', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(50, 'projects', pg_temp.nid(1), pg_temp.base('v7'), jsonb_build_object('status', 'inactive'))));
insert into res
select 'e2', pg_temp.push(tests.id('u_sup_pemba'), 'dev-s', jsonb_build_array(
  pg_temp.op(51, 'projects', pg_temp.nid(1), pg_temp.base('v7'), jsonb_build_object('status', 'inactive'))));

select is(pg_temp.st('e1') || pg_temp.st('e2'), array['applied', 'applied'],
  'both devices set the same value: nothing to merge, no conflict');
select is((pg_temp.r('e2', 0) ->> 'version')::int, pg_temp.base('v7') + 1, 'and no extra version');

-- =============================================================================
-- 6. Location conflicts travel as lon/lat
-- =============================================================================
do $$ begin perform pg_temp.mark('v8', 'projects', pg_temp.nid(1)); end $$;
insert into res
select 'g1', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(60, 'projects', pg_temp.nid(1), pg_temp.base('v8'), jsonb_build_object('lon', 39.71, 'lat', -5.01))));
insert into res
select 'g2', pg_temp.push(tests.id('u_sup_pemba'), 'dev-s', jsonb_build_array(
  pg_temp.op(61, 'projects', pg_temp.nid(1), pg_temp.base('v8'), jsonb_build_object('lon', 39.72, 'lat', -5.02))));

select is(pg_temp.st('g1') || pg_temp.st('g2'), array['applied', 'conflict'], 'two devices moved the point: conflict');
select is(pg_temp.r('g2', 0) -> 'conflict_fields', '["geom"]'::jsonb, 'the location conflict is reported as field geom');
select is(pg_temp.r('g2', 0) -> 'server_values', '{"geom": {"lon": 39.71, "lat": -5.01}}'::jsonb,
  'server value of a location conflict is a lon/lat object');
select is(
  (select c.client_value from public.sync_conflicts c where c.id = pg_temp.cid('g2')),
  '{"lon": 39.72, "lat": -5.02}'::jsonb, 'client value of a location conflict is a lon/lat object');

insert into res
select 'g3', pg_temp.resolve(tests.id('u_sup_pemba'), pg_temp.cid('g2'), 'client');
select is(
  (select array[st_x(p.geom), st_y(p.geom)] from public.projects p where p.id = pg_temp.nid(1)),
  array[39.72, -5.02]::double precision[], 'resolving a location conflict with "client" moves the point');

-- =============================================================================
-- 7. Delete against update
-- =============================================================================
insert into res
select 'd1', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(70, 'project_maintenance', pg_temp.nid(2), 1, null, 'delete')));
insert into res
select 'd2', pg_temp.push(tests.id('u_sup_pemba'), 'dev-s', jsonb_build_array(
  pg_temp.op(71, 'project_maintenance', pg_temp.nid(2), 1, jsonb_build_object('priority', 'urgent'))));
select is(pg_temp.st('d1') || pg_temp.st('d2'), array['applied', 'rejected'],
  'an edit that arrives after the row was deleted is rejected');
select is(pg_temp.r('d2', 0) #>> '{error,code}', 'row_deleted', 'edit after delete: row_deleted');

insert into res
select 'd3', pg_temp.push(tests.id('u_sup_pemba'), 'dev-s', jsonb_build_array(
  pg_temp.op(72, 'project_maintenance', pg_temp.nid(3), 1, jsonb_build_object('priority', 'urgent'))));
insert into res
select 'd4', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(73, 'project_maintenance', pg_temp.nid(3), 1, null, 'delete')));
select is(pg_temp.st('d3') || pg_temp.st('d4'), array['applied', 'merged'],
  'a delete that arrives after somebody else''s edit still deletes (reported as merged)');
select ok(
  (select m.deleted_at is not null and m.priority = 'urgent' from public.project_maintenance m where m.id = pg_temp.nid(3)),
  'the row is soft-deleted and keeps the other device''s edit in its history');

-- =============================================================================
-- 8. Two devices create the same 1:1 child offline (natural key)
-- =============================================================================
insert into res
select 'n1', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(80, 'project_land', pg_temp.nid(80), 0, jsonb_build_object(
    'project_id', pg_temp.nid(1), 'ownership', 'waqf', 'area_m2', 500))));
insert into res
select 'n2', pg_temp.push(tests.id('u_sup_pemba'), 'dev-s', jsonb_build_array(
  pg_temp.op(81, 'project_land', pg_temp.nid(81), 0, jsonb_build_object(
    'project_id', pg_temp.nid(1), 'ownership', 'waqf', 'area_m2', 650, 'owner_name', 'Waqf board'))));

select is(pg_temp.st('n1') || pg_temp.st('n2'), array['applied', 'conflict'],
  'second land record for the same project is redirected to the existing row');
select is((pg_temp.r('n2', 0) ->> 'row_id')::uuid, pg_temp.nid(80), 'the canonical row id is returned');
select is(pg_temp.r('n2', 0) -> 'server_values', '{"area_m2": 500, "owner_name": null}'::jsonb,
  'server_values keeps an empty server value as null');
select is(
  (select array_agg(c.field order by c.field) from public.sync_conflicts c
   where c.table_name = 'project_land' and c.row_id = pg_temp.nid(80)),
  array['area_m2', 'owner_name'],
  'every differing field becomes a conflict (equal values do not)');
select is(
  (select count(*)::int from public.project_land l where l.project_id = pg_temp.nid(1) and l.deleted_at is null), 1,
  'still exactly one live land record');

-- =============================================================================
-- 9. Conflicts on restricted tables: values only for those who may see them
-- =============================================================================
-- fixture row sens:p_pemba_1 (ibadi_families = 12) was written by "another device"
insert into res
select 'x1', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(90, 'community_sensitive', pg_temp.nid(90), 0, jsonb_build_object(
    'project_id', tests.id('p_pemba_1'), 'ibadi_families', 99))));

-- The collector writes blind: his answer is a constant (it does not even say
-- that a conflict was recorded, sync.md §4.4); the conflict row is found here
-- through the table.
create function pg_temp.xcid() returns uuid language sql stable as
$fn$
  select c.id from public.sync_conflicts c
  where c.table_name = 'community_sensitive' and c.row_id = tests.id('sens:p_pemba_1')
    and c.field = 'ibadi_families' and c.client_value = '99'::jsonb
$fn$;

select is(pg_temp.r('x1', 0) - 'op_id', '{"status": "applied", "version": null}'::jsonb,
  'blind entry over an existing restricted value: constant answer, nothing about the stored value');
select is(
  (select row(c.state, c.server_value, c.client_user_id)::text from public.sync_conflicts c where c.id = pg_temp.xcid()),
  row('open'::text, '12'::jsonb, tests.id('u_col_pemba'))::text,
  'the differing value is stored as an open conflict for those who may see restricted data');

select ok(not (pg_temp.xcid() = any (pg_temp.pulled(tests.id('u_sup_pemba'), 'sync_conflicts'))),
  'a branch supervisor does not receive conflicts about restricted data');
select ok(pg_temp.xcid() = any (pg_temp.pulled(tests.id('u_mgr_tz'), 'sync_conflicts', 'aal2')),
  'the country manager receives the restricted conflict');
select ok(
  exists (select 1 from public.restricted_access_log l
          where l.user_id = tests.id('u_mgr_tz') and l.table_name = 'community_sensitive'
            and l.context = 'sync_pull:sync_conflicts' and tests.id('sens:p_pemba_1') = any (l.row_ids)),
  'pulling a restricted conflict is written to restricted_access_log');

select throws_ok(
  format($q$select pg_temp.resolve(%L::uuid, %L::uuid, 'client')$q$, tests.id('u_sup_pemba'), pg_temp.xcid()),
  'PT403', 'out_of_scope', 'a supervisor cannot resolve a conflict about restricted data');

insert into res
select 'x2', pg_temp.resolve(tests.id('u_mgr_tz'), pg_temp.xcid(), 'client', 'aal2');
select is(
  (select s.ibadi_families from public.community_sensitive s where s.id = tests.id('sens:p_pemba_1')), 99,
  'the country manager applies the client value');
select ok(
  exists (select 1 from public.restricted_access_log l
          where l.user_id = tests.id('u_mgr_tz') and l.table_name = 'community_sensitive'
            and l.context = 'resolve_conflict'),
  'resolving a restricted conflict is logged as a restricted read');

-- =============================================================================
-- 10. A conflict whose row was deleted can only be closed with "server"
-- =============================================================================
do $$ begin perform pg_temp.mark('w1', 'project_land', pg_temp.nid(80)); end $$;
insert into res
select 'w', pg_temp.push(tests.id('u_sup_pemba'), 'dev-s', jsonb_build_array(
  pg_temp.op(95, 'project_land', pg_temp.nid(80), pg_temp.base('w1'), null, 'delete')));

select throws_ok(
  format($q$select pg_temp.resolve(%L::uuid, %L::uuid, 'client')$q$, tests.id('u_sup_pemba'),
         (select c.id from public.sync_conflicts c
          where c.table_name = 'project_land' and c.row_id = pg_temp.nid(80) and c.field = 'area_m2')),
  'PT409', 'row_deleted', 'choice "client" is refused when the record was deleted meanwhile');

insert into res
select 'w2', pg_temp.resolve(tests.id('u_sup_pemba'),
  (select c.id from public.sync_conflicts c
   where c.table_name = 'project_land' and c.row_id = pg_temp.nid(80) and c.field = 'area_m2'), 'server');
select is((select v ->> 'state' from res where k = 'w2'), 'resolved_server', '... but it can be closed with "server"');

-- =============================================================================
-- 11. Donors have no country or branch: everybody who sees a donor through a
--     project may edit it, but a conflict on a donor is decided by a global
--     reviewer only
-- =============================================================================
insert into res
select 'dn0', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(200, 'donors', pg_temp.nid(200), 0, jsonb_build_object('name_latin', 'Donor zero')),
  pg_temp.op(201, 'project_donors', pg_temp.nid(201), 0, jsonb_build_object(
    'project_id', pg_temp.nid(1), 'donor_id', pg_temp.nid(200), 'year', 2020))));
-- the supervisor (who sees the donor through the project) and a second device
-- of the collector rename it from the same base
insert into res
select 'dn1', pg_temp.push(tests.id('u_sup_pemba'), 'dev-s', jsonb_build_array(
  pg_temp.op(202, 'donors', pg_temp.nid(200), 1, jsonb_build_object('name_latin', 'Donor S'))));
insert into res
select 'dn2', pg_temp.push(tests.id('u_col_pemba'), 'dev-a2', jsonb_build_array(
  pg_temp.op(203, 'donors', pg_temp.nid(200), 1, jsonb_build_object('name_latin', 'Donor A'))));

select is(pg_temp.st('dn0') || pg_temp.st('dn1') || pg_temp.st('dn2'),
  array['applied', 'applied', 'applied', 'conflict'],
  'a donor renamed on two devices from the same base: conflict');
select is(
  (select row(c.table_name, c.row_id, c.project_id, c.field, c.server_value, c.client_value)::text
   from public.sync_conflicts c where c.id = pg_temp.cid('dn2')),
  row('donors'::text, pg_temp.nid(200), null::uuid, 'name_latin'::text, '"Donor S"'::jsonb, '"Donor A"'::jsonb)::text,
  'the donor conflict carries no project (a donor belongs to no country or branch)');

select ok(
  not (pg_temp.cid('dn2') = any (pg_temp.pulled(tests.id('u_sup_pemba'), 'sync_conflicts')))
  and not (pg_temp.cid('dn2') = any (pg_temp.pulled(tests.id('u_mgr_tz'), 'sync_conflicts', 'aal2')))
  and pg_temp.cid('dn2') = any (pg_temp.pulled(tests.id('u_hq'), 'sync_conflicts', 'aal2')),
  'a donor conflict is sent to global reviewers only');
select throws_ok(
  format($q$select pg_temp.resolve(%L::uuid, %L::uuid, 'client')$q$, tests.id('u_sup_pemba'), pg_temp.cid('dn2')),
  'PT403', 'out_of_scope', 'a branch supervisor cannot resolve a donor conflict');
select throws_ok(
  format($q$select pg_temp.resolve(%L::uuid, %L::uuid, 'client', 'aal2')$q$, tests.id('u_mgr_tz'), pg_temp.cid('dn2')),
  'PT403', 'out_of_scope', 'a country manager cannot resolve a donor conflict');

insert into res
select 'dn3', pg_temp.resolve(tests.id('u_hq'), pg_temp.cid('dn2'), 'client', 'aal2');
select is(
  (select row(d.name_latin, c.state)::text
   from public.donors d, public.sync_conflicts c
   where d.id = pg_temp.nid(200) and c.id = pg_temp.cid('dn2')),
  row('Donor A'::text, 'resolved_client'::text)::text,
  'hq_admin (global reviewer) resolves the donor conflict');

select * from finish();
rollback;

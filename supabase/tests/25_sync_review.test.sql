-- =============================================================================
-- 25  Sync review 2026-10-05 (migration 20261003007400): adversarial cases
--     A. base_version games            B. idempotency, retries, malformed calls
--     C. future base after a restore   D. null kept in server_values
--     E. own superseded conflicts      F. photo upload_state only moves forward
--     G. resolve_conflict "client" validated like a write (scope escape)
--     H. sync_rebase without session_replication_role
--     I. pull paging: every visible row exactly once for limits 1..13
-- Uses the transaction-id clock of file 23 (private.current_xid / safe_xid
-- replaced inside this transaction only).
-- =============================================================================
begin;
set local search_path = public, extensions, tests;

select plan(39);

create or replace function private.current_xid() returns bigint language sql stable as
$fn$ select current_setting('test.xid')::bigint $fn$;
create or replace function private.safe_xid() returns bigint language sql stable as
$fn$ select current_setting('test.safe')::bigint $fn$;

create function pg_temp.clock(p_xid integer, p_safe integer default null) returns void language plpgsql as
$fn$
declare
  b bigint := current_setting('test.base')::bigint;
begin
  perform set_config('test.xid', (b + p_xid)::text, true);
  perform set_config('test.safe', (b + coalesce(p_safe, p_xid + 1))::text, true);
end;
$fn$;

do $$
begin
  perform set_config('test.base', (pg_current_xact_id()::text::bigint + 1000000)::text, true);
  perform set_config('app.rate_limit', 'off', true);
  perform pg_temp.clock(100);
  perform tests.fixture();
  perform tests.fixture_extra();
end $$;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------
create temp table res (k text primary key, v jsonb) on commit drop;

create function pg_temp.nid(p_n integer) returns uuid language sql immutable as
$fn$ select ('00000000-0000-7000-9250-' || lpad(p_n::text, 12, '0'))::uuid $fn$;
create function pg_temp.opid(p_n integer) returns uuid language sql immutable as
$fn$ select ('00000000-0000-7000-8250-' || lpad(p_n::text, 12, '0'))::uuid $fn$;

-- p_base is jsonb so that strings, floats, booleans ... can be sent
create function pg_temp.op(p_n integer, p_table text, p_id uuid, p_base jsonb, p_fields jsonb, p_kind text default 'upsert')
returns jsonb language sql immutable as
$fn$
  select jsonb_build_object('op_id', pg_temp.opid(p_n), 'table', p_table, 'id', p_id, 'kind', p_kind,
                            'base_version', p_base, 'fields', coalesce(p_fields, '{}'::jsonb));
$fn$;

-- push as an end user; a whole-call error comes back as {"error": sqlstate, "message": ...}
create function pg_temp.push(p_user uuid, p_device text, p_ops jsonb, p_aal text default 'aal1')
returns jsonb language plpgsql as
$fn$
declare
  r jsonb;
begin
  perform tests.login_as(p_user, p_aal, p_device);
  begin
    r := public.sync_push(p_ops, p_device);
  exception when others then
    r := jsonb_build_object('error', sqlstate, 'message', sqlerrm);
  end;
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
  perform tests.login_as(p_user, p_aal, 'dev-r');
  begin
    r := public.resolve_conflict(p_conflict, p_choice);
  exception when others then
    r := jsonb_build_object('error', sqlstate, 'message', sqlerrm);
  end;
  perform tests.logout();
  return r;
end;
$fn$;

-- result i of a stored push
create function pg_temp.r(p_k text, p_i integer default 0) returns jsonb language sql stable as
$fn$ select res.v -> 'results' -> p_i from res where res.k = p_k $fn$;

create function pg_temp.ver(p_id uuid) returns integer language sql stable as
$fn$ select p.version from public.projects p where p.id = p_id $fn$;

insert into public.devices (user_id, device_id, label)
values (tests.id('u_col_pemba'), 'dev-a', 'phone A'), (tests.id('u_col_pemba'), 'dev-b', 'phone B');

-- the project of this file, created on dev-a (branch Pemba from the collector's scope)
insert into res
select 'p0', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(1, 'projects', pg_temp.nid(1), '0', jsonb_build_object(
    'name_ar', U&'\0645\0633\062C\062F', 'type', 'mosque', 'status', 'active',
    'lon', 39.71, 'lat', -5.01, 'builder', 'orig'))));
select is(pg_temp.r('p0') ->> 'status', 'applied', 'setup: the project of this file is created');

-- =============================================================================
-- A. base_version games
-- =============================================================================
insert into res
select 'a1', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(10, 'projects', pg_temp.nid(1), '"abc"', '{"name_latin": "x"}'),
  pg_temp.op(11, 'projects', pg_temp.nid(1), '1.5', '{"name_latin": "x"}'),
  pg_temp.op(12, 'projects', pg_temp.nid(1), 'true', '{"name_latin": "x"}'),
  pg_temp.op(13, 'projects', pg_temp.nid(1), '-1', '{"name_latin": "x"}'),
  pg_temp.op(14, 'projects', pg_temp.nid(1), '{}', '{"name_latin": "x"}'),
  pg_temp.op(15, 'projects', pg_temp.nid(1), '99999999999', '{"name_latin": "x"}'),
  pg_temp.op(16, 'projects', pg_temp.nid(1), '"-3"', '{"name_latin": "x"}')));
select is(
  (select array_agg(e ->> 'status' || ':' || coalesce(e #>> '{error,code}', '')) from jsonb_array_elements((select v -> 'results' from res where k = 'a1')) e),
  array_fill('rejected:invalid_base_version'::text, array[7]),
  'base_version that is not a non-negative int4 ("abc", 1.5, true, -1, {}, > int4, "-3"): invalid_base_version');
select is(pg_temp.ver(pg_temp.nid(1)), 1, 'nothing of the invalid operations was written');

insert into res
select 'a2', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(17, 'projects', pg_temp.nid(1), '"1"', '{"name_latin": "A"}'),
  pg_temp.op(18, 'projects', pg_temp.nid(1), 'null', '{"name_latin": "B"}')));
select is(
  (select array_agg(e ->> 'status') from jsonb_array_elements((select v -> 'results' from res where k = 'a2')) e),
  array['applied', 'applied'],
  'a digit string and null (= 0, own row, own device) are still accepted');

-- =============================================================================
-- B. Idempotency, retries, malformed calls
-- =============================================================================
insert into res
select 'b1', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(20, 'project_maintenance', pg_temp.nid(20), '0', jsonb_build_object('project_id', pg_temp.nid(1), 'description', 'roof')),
  pg_temp.op(20, 'project_maintenance', pg_temp.nid(20), '0', jsonb_build_object('project_id', pg_temp.nid(1), 'description', 'roof'))));
select is(
  array[pg_temp.r('b1', 0) ->> 'status', pg_temp.r('b1', 1) ->> 'status', pg_temp.r('b1', 1) ->> 'original_status'],
  array['applied', 'duplicate', 'applied'],
  'the same op twice in one batch: applied once, the second is a duplicate');
select is((select count(*)::int from public.project_maintenance m where m.id = pg_temp.nid(20)), 1,
  'one row only');

insert into res
select 'b2', pg_temp.push(tests.id('u_col_pemba'), 'dev-a',
  (select jsonb_agg(pg_temp.op(100 + g, 'projects', pg_temp.nid(1), '3', '{}')) from generate_series(1, 51) g));
select is(res.v ->> 'error', 'PT422', '51 operations: the whole call is refused (too_many_ops)') from res where k = 'b2';

insert into res
select 'b3', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  '1'::jsonb, '"x"'::jsonb, 'null'::jsonb, '{}'::jsonb,
  jsonb_build_object('op_id', 'not-a-uuid'),
  jsonb_build_object('op_id', pg_temp.opid(30)),
  jsonb_build_object('op_id', pg_temp.opid(31), 'table', 'projects', 'id', 'zzz'),
  jsonb_build_object('op_id', pg_temp.opid(32), 'table', 'projects', 'id', pg_temp.nid(32), 'fields', '[]'::jsonb),
  jsonb_build_object('op_id', pg_temp.opid(33), 'table', 'projects', 'id', pg_temp.nid(33), 'kind', 'merge'),
  jsonb_build_object('op_id', pg_temp.opid(34), 'table', 'nope', 'id', pg_temp.nid(34))));
select is(
  (select array_agg(coalesce(e #>> '{error,code}', e ->> 'status')) from jsonb_array_elements((select v -> 'results' from res where k = 'b3')) e),
  array['invalid_op', 'invalid_op', 'invalid_op', 'invalid_op', 'invalid_op', 'missing_table', 'invalid_value',
        'invalid_fields', 'invalid_kind', 'unknown_table'],
  'malformed operations are rejected one by one, in input order, without failing the call');

-- child before parent in one batch, then the same op_id again after the parent arrived
insert into res
select 'b4', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(40, 'project_maintenance', pg_temp.nid(40), '0', jsonb_build_object('project_id', pg_temp.nid(41), 'description', 'c')),
  pg_temp.op(41, 'projects', pg_temp.nid(41), '0', jsonb_build_object(
    'name_ar', U&'\0645\0633\062C\062F', 'type', 'mosque', 'status', 'active', 'lon', 39.712, 'lat', -5.012))));
insert into res
select 'b5', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(40, 'project_maintenance', pg_temp.nid(40), '0', jsonb_build_object('project_id', pg_temp.nid(41), 'description', 'c'))));
select is(
  array[pg_temp.r('b4', 0) #>> '{error,code}', pg_temp.r('b4', 1) ->> 'status', pg_temp.r('b5', 0) ->> 'status'],
  array['parent_missing', 'applied', 'applied'],
  'child before parent: parent_missing (not in the ledger), the same op_id is applied on retry');

-- =============================================================================
-- C. A base_version above the row version (restore to an older state)
-- =============================================================================
insert into res
select 'c1', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(50, 'projects', pg_temp.nid(1), to_jsonb(pg_temp.ver(pg_temp.nid(1))), '{"name_latin": "from A"}')));
insert into res
select 'c2', pg_temp.push(tests.id('u_col_pemba'), 'dev-b', jsonb_build_array(
  pg_temp.op(51, 'projects', pg_temp.nid(1), '9999', '{"name_latin": "from B"}')));
select is(
  array[pg_temp.r('c1') ->> 'status', pg_temp.r('c2') ->> 'status', pg_temp.r('c2') #>> '{conflict_fields,0}'],
  array['applied', 'conflict', 'name_latin'],
  'future base_version: treated as unknown, the field another device wrote becomes a conflict');
select is((select p.name_latin from public.projects p where p.id = pg_temp.nid(1)), 'from A',
  'future base_version no longer overwrites the other device''s value silently');

-- =============================================================================
-- D. A field CLEARED by another device: null is kept in server_values
-- =============================================================================
select set_config('t.v', pg_temp.ver(pg_temp.nid(1))::text, true);
insert into res
select 'd1', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(60, 'projects', pg_temp.nid(1), to_jsonb(current_setting('t.v')::int), '{"builder": null}')));
insert into res
select 'd2', pg_temp.push(tests.id('u_col_pemba'), 'dev-b', jsonb_build_array(
  pg_temp.op(61, 'projects', pg_temp.nid(1), to_jsonb(current_setting('t.v')::int), '{"builder": "Q"}')));
select is(pg_temp.r('d2') -> 'server_values', '{"builder": null}'::jsonb,
  'server_values keeps a cleared server value as null');

-- an insert elsewhere counts only the fields it filled in (1:1 child on two devices)
insert into res
select 'd3', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(62, 'project_land', pg_temp.nid(62), '0', jsonb_build_object('project_id', pg_temp.nid(1), 'area_m2', 100))));
insert into res
select 'd4', pg_temp.push(tests.id('u_col_pemba'), 'dev-b', jsonb_build_array(
  pg_temp.op(63, 'project_land', pg_temp.nid(63), '0', jsonb_build_object('project_id', pg_temp.nid(1), 'area_m2', 200, 'notes', 'n'))));
select is(
  array[pg_temp.r('d4') ->> 'status', pg_temp.r('d4') ->> 'row_id', (pg_temp.r('d4') -> 'conflict_fields')::text,
        (select l.notes || '/' || l.area_m2::int::text from public.project_land l where l.id = pg_temp.nid(62))],
  array['conflict', pg_temp.nid(62)::text, '["area_m2"]', 'n/100'],
  'natural key on two devices: only the filled-in field conflicts, the empty one is written');

-- =============================================================================
-- E. Own superseded conflicts are withdrawn, other users'' stay open
-- =============================================================================
select set_config('t.v', pg_temp.ver(pg_temp.nid(1))::text, true);
insert into res
select 'e1', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(70, 'projects', pg_temp.nid(1), to_jsonb(current_setting('t.v')::int), '{"build_year": 2001}')));
insert into res
select 'e2', pg_temp.push(tests.id('u_sup_pemba'), 'dev-s', jsonb_build_array(
  pg_temp.op(71, 'projects', pg_temp.nid(1), to_jsonb(current_setting('t.v')::int), '{"build_year": 2002}')));
insert into res
select 'e3', pg_temp.push(tests.id('u_col_pemba'), 'dev-b', jsonb_build_array(
  pg_temp.op(72, 'projects', pg_temp.nid(1), to_jsonb(current_setting('t.v')::int), '{"build_year": 2003}')));
-- dev-b saw server_values and decides anew on the returned version
insert into res
select 'e4', pg_temp.push(tests.id('u_col_pemba'), 'dev-b', jsonb_build_array(
  pg_temp.op(73, 'projects', pg_temp.nid(1), to_jsonb((pg_temp.r('e3') ->> 'version')::int), '{"build_year": 2004}')));
select is(
  array[pg_temp.r('e1') ->> 'status', pg_temp.r('e2') ->> 'status', pg_temp.r('e3') ->> 'status', pg_temp.r('e4') ->> 'status'],
  array['applied', 'conflict', 'conflict', 'applied'],
  'two stale writers conflict; the re-decided value on the returned version is applied');
select is(
  (select array_agg(c.client_value::text || ':' || (c.deleted_at is null)::text order by c.client_value::text)
   from public.sync_conflicts c where c.row_id = pg_temp.nid(1) and c.field = 'build_year'),
  array['2002:true', '2003:false'],
  'the writer''s own superseded conflict is withdrawn; the supervisor''s stays open');
select is(
  (pg_temp.resolve(tests.id('u_sup_pemba'), (pg_temp.r('e2') #>> '{conflict_ids,0}')::uuid, 'server')) ->> 'state',
  'resolved_server', 'resolve "server" on the remaining conflict');
insert into res
select 'e5', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(74, 'projects', pg_temp.nid(1), to_jsonb(pg_temp.ver(pg_temp.nid(1))), '{"build_year": 2005}')));
select is(pg_temp.r('e5') ->> 'status', 'applied', 'after a resolution, an edit on the current version applies normally');

-- =============================================================================
-- F. project_photos.upload_state only moves forward
-- =============================================================================
insert into res
select 'f1', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(80, 'project_photos', pg_temp.nid(80), '0', jsonb_build_object('project_id', pg_temp.nid(1))),
  pg_temp.op(81, 'project_photos', pg_temp.nid(80), '1', '{"upload_state": "uploaded"}'),
  pg_temp.op(82, 'project_photos', pg_temp.nid(80), '2', '{"upload_state": "pending"}'),
  pg_temp.op(83, 'project_photos', pg_temp.nid(80), '2', '{"upload_state": "uploaded", "caption": "c"}')));
select is(
  array[pg_temp.r('f1', 0) ->> 'status', pg_temp.r('f1', 1) ->> 'status',
        pg_temp.r('f1', 2) #>> '{error,code}', pg_temp.r('f1', 3) ->> 'status'],
  array['applied', 'applied', 'invalid_transition', 'applied'],
  'upload_state: pending -> uploaded applies, uploaded -> pending is refused, uploaded again is fine');
select is((select ph.upload_state from public.project_photos ph where ph.id = pg_temp.nid(80)), 'uploaded',
  'the photo stays uploaded');

-- at most 10 live photos also through sync_push
insert into res
select 'f2', pg_temp.push(tests.id('u_col_pemba'), 'dev-a',
  (select jsonb_agg(pg_temp.op(900 + g, 'project_photos', pg_temp.nid(900 + g), '0', jsonb_build_object('project_id', pg_temp.nid(1)))
                    order by g) from generate_series(1, 11) g));
select is(
  (select array[count(*) filter (where e ->> 'status' = 'applied'),
                count(*) filter (where e #>> '{error,code}' = 'photo_limit_exceeded')]::int[]
   from jsonb_array_elements((select v -> 'results' from res where k = 'f2')) e),
  array[9, 2], 'photo limit: 1 + 9 applied, the 11th and 12th photo are refused (photo_limit_exceeded)');

-- =============================================================================
-- G. resolve_conflict "client": the stored row must stay in the reviewer''s scope
-- =============================================================================
select set_config('t.v', pg_temp.ver(pg_temp.nid(1))::text, true);
insert into res
select 'g1', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(90, 'projects', pg_temp.nid(1), to_jsonb(current_setting('t.v')::int), '{"lon": 39.72, "lat": -5.02}')));
insert into res   -- a point in Kenya (ke_mombasa), proposed on a stale base
select 'g2', pg_temp.push(tests.id('u_col_pemba'), 'dev-b', jsonb_build_array(
  pg_temp.op(91, 'projects', pg_temp.nid(1), to_jsonb(current_setting('t.v')::int), '{"lon": 39.67, "lat": -4.05}')));
select is(array[pg_temp.r('g1') ->> 'status', pg_temp.r('g2') ->> 'status', pg_temp.r('g2') #>> '{conflict_fields,0}'],
  array['applied', 'conflict', 'geom'], 'setup: a location conflict that points into Kenya');

insert into res
select 'g3', pg_temp.resolve(tests.id('u_sup_pemba'), (pg_temp.r('g2') #>> '{conflict_ids,0}')::uuid, 'client');
-- (his branch scope still matches br_pemba, so the branch/country rule refuses it)
select is(res.v ->> 'message', 'branch_country_mismatch',
  'a Pemba supervisor cannot move the record to Kenya by choosing "client"') from res where k = 'g3';
insert into res
select 'g3m', pg_temp.resolve(tests.id('u_mgr_tz'), (pg_temp.r('g2') #>> '{conflict_ids,0}')::uuid, 'client', 'aal2');
select ok((select res.v ->> 'error' = 'PT403' and res.v ->> 'message' = 'out_of_scope' from res where k = 'g3m'),
  'the Tanzanian country manager cannot move it to Kenya either (out_of_scope: the stored row would leave his country)');
select is(
  (select p.country_id = tests.id('tz') and p.branch_id = tests.id('br_pemba') from public.projects p where p.id = pg_temp.nid(1))
  and (select c.state = 'open' from public.sync_conflicts c where c.id = (pg_temp.r('g2') #>> '{conflict_ids,0}')::uuid),
  true, 'the record stays in Tanzania / Pemba and the conflict stays open');

insert into res
select 'g4', pg_temp.resolve(tests.id('u_hq'), (pg_temp.r('g2') #>> '{conflict_ids,0}')::uuid, 'client', 'aal2');
select ok((select res.v ->> 'error' = 'PT422' and res.v ->> 'message' = 'branch_country_mismatch' from res where k = 'g4'),
  'HQ choosing "client" would leave a Pemba branch on a Kenyan record: branch_country_mismatch');
select is(
  (pg_temp.resolve(tests.id('u_sup_pemba'), (pg_temp.r('g2') #>> '{conflict_ids,0}')::uuid, 'server')) ->> 'state',
  'resolved_server', '"server" closes it');

-- conflicts recorded on fields a supervisor cannot assign (branch, locality of another country)
insert into public.sync_conflicts
  (id, table_name, row_id, project_id, field, base_version, server_value, client_value,
   client_user_id, client_device_id, client_op_id, state)
values
  (pg_temp.nid(95), 'projects', pg_temp.nid(1), pg_temp.nid(1), 'branch_id', 1,
   to_jsonb(tests.id('br_pemba')), to_jsonb(tests.id('br_tanga')), tests.id('u_col_pemba'), 'dev-b', pg_temp.opid(95), 'open'),
  (pg_temp.nid(96), 'projects', pg_temp.nid(1), pg_temp.nid(1), 'locality_id', 1,
   'null'::jsonb, to_jsonb(tests.id('loc:ke_mombasa')), tests.id('u_col_pemba'), 'dev-b', pg_temp.opid(96), 'open'),
  (pg_temp.nid(97), 'projects', pg_temp.nid(1), pg_temp.nid(1), 'name_latin', 1,
   '"from A"'::jsonb, '"from C"'::jsonb, tests.id('u_col_pemba'), 'dev-b', pg_temp.opid(97), 'open');
select ok(
  (pg_temp.resolve(tests.id('u_sup_pemba'), pg_temp.nid(95), 'client')) ->> 'error' = 'PT403'
  and (select p.branch_id = tests.id('br_pemba') from public.projects p where p.id = pg_temp.nid(1)),
  'a branch conflict cannot move the record to a branch outside the reviewer''s scope');
select ok(
  (pg_temp.resolve(tests.id('u_sup_pemba'), pg_temp.nid(96), 'client')) ->> 'message' = 'locality_country_mismatch'
  and (select p.locality_id is null from public.projects p where p.id = pg_temp.nid(1)),
  'a locality conflict cannot attach a locality of another country');
select is(
  (pg_temp.resolve(tests.id('u_sup_pemba'), pg_temp.nid(97), 'client')) ->> 'state', 'resolved_client',
  'an ordinary field is still resolved with "client"');
select is((select p.name_latin from public.projects p where p.id = pg_temp.nid(1)), 'from C',
  'and the client value is written');

-- =============================================================================
-- H. sync_rebase without session_replication_role (managed Supabase)
-- =============================================================================
create temp table before_rebase on commit drop as
select p.id, p.version, p.updated_at from public.projects p;
do $$
begin
  perform pg_temp.clock(500);
  perform set_config('app.sync_rebase_mode', 'alter', true);
  perform set_config('t.rebase', private.sync_rebase()::text, true);
  perform set_config('app.sync_rebase_mode', '', true);
end $$;
select is(current_setting('t.rebase')::jsonb ->> 'mode', 'alter_table',
  'fallback: triggers disabled with ALTER TABLE instead of session_replication_role');
select is(
  (select array[min(p.sync_xid), max(p.sync_xid)] from public.projects p),
  array[current_setting('test.base')::bigint + 500, current_setting('test.base')::bigint + 500],
  'fallback: every row is re-stamped with the current transaction id');
select is(
  (select count(*)::int from public.projects p join before_rebase b on b.id = p.id
   where p.version <> b.version or p.updated_at <> b.updated_at), 0,
  'fallback: version / updated_at untouched (std trigger was off)');
select is(
  (select count(*)::int
   from pg_trigger t join private.sync_tables s on t.tgrelid = format('public.%I', s.table_name)::regclass
   where not t.tgisinternal and t.tgenabled <> 'O'), 0,
  'fallback: every user trigger is enabled again afterwards');

-- =============================================================================
-- I. Pull paging: every visible row exactly once, whatever the page size
-- =============================================================================
create function pg_temp.pull_all(p_user uuid, p_limit integer, p_cursor jsonb, p_aal text)
returns jsonb language plpgsql as
$fn$
declare
  r jsonb; ch jsonb; v_cursor jsonb := p_cursor; v_ids jsonb := '{}'; v_pages int := 0; v_max int := 0; v_page int;
begin
  perform tests.login_as(p_user, p_aal, 'dev-pull');
  loop
    r := public.sync_pull(v_cursor, p_limit);
    v_pages := v_pages + 1; v_page := 0;
    for ch in select value from jsonb_array_elements(r -> 'changes') loop
      v_ids := jsonb_set(v_ids, array[ch ->> 'table'], coalesce(v_ids -> (ch ->> 'table'), '[]')
               || (select coalesce(jsonb_agg(x -> 'id'), '[]') from jsonb_array_elements(ch -> 'rows') x));
      v_page := v_page + jsonb_array_length(ch -> 'rows');
    end loop;
    v_max := greatest(v_max, v_page);
    v_cursor := r -> 'cursor';
    exit when (r ->> 'done')::boolean or v_pages >= 5000;
  end loop;
  perform tests.logout();
  return jsonb_build_object('max', v_max, 'cursor', v_cursor, 'ids', v_ids);
end;
$fn$;
-- ids per table, sorted (order of delivery does not matter, duplicates do)
create function pg_temp.norm(p jsonb) returns jsonb language sql immutable as
$fn$ select coalesce(jsonb_object_agg(k, (select jsonb_agg(x order by x) from jsonb_array_elements_text(v) x)), '{}')
     from jsonb_each(p) e(k, v) $fn$;
create function pg_temp.dups(p jsonb) returns int language sql immutable as
$fn$ select (count(*) - count(distinct (k, x)))::int from jsonb_each(p) e(k, v), jsonb_array_elements_text(v) x $fn$;

create temp table pulls (u text, aal text, lim int, v jsonb) on commit drop;
do $$ begin perform pg_temp.clock(600); end $$;
insert into pulls
select u.k, u.aal, l, pg_temp.pull_all(tests.id(u.k), l, null, u.aal)
from (values ('u_col_pemba', 'aal1'), ('u_mgr_tz', 'aal2'), ('u_viewer_tz', 'aal1'), ('u_hq', 'aal2')) u(k, aal),
     unnest(array[1000, 1, 2, 7, 13]) l;
select is(
  (select count(*)::int from pulls r join pulls b on b.u = r.u and b.lim = 1000
   where r.lim <> 1000
     and pg_temp.norm(r.v -> 'ids') = pg_temp.norm(b.v -> 'ids')
     and pg_temp.dups(r.v -> 'ids') = 0
     and (r.v ->> 'max')::int <= r.lim),
  16, 'first round, limits 1/2/7/13 for collector, manager, viewer, HQ: the same rows as one big page, none twice');

-- incremental round with edits, a tombstone and a restricted change
do $$
begin
  perform pg_temp.clock(700);
  update public.projects set capacity = 77 where id = tests.id('p_pemba_2');
  update public.project_maintenance set deleted_at = now() where id = tests.id('maint:p_pemba_1');
  update public.project_photos set caption = 'c' where id = tests.id('photo:p_pemba_1');
  update public.persons set graduated_from = 'Z' where id = tests.id('person:p_pemba_1');
  update public.staff_compensation set monthly_amount = 1 where id = tests.id('comp:p_pemba_1');
  update public.donors set name_ar = U&'\0645' where id = tests.id('donor:p_pemba_1');
  perform pg_temp.clock(710);
end $$;
create temp table incs (u text, lim int, v jsonb) on commit drop;
insert into incs
select p.u, l, pg_temp.pull_all(tests.id(p.u), l, p.v -> 'cursor', p.aal)
from pulls p, unnest(array[1000, 1, 3]) l
where p.lim = 1000;
select is(
  (select count(*)::int from incs r join incs b on b.u = r.u and b.lim = 1000
   where r.lim <> 1000
     and pg_temp.norm(r.v -> 'ids') = pg_temp.norm(b.v -> 'ids')
     and pg_temp.dups(r.v -> 'ids') = 0),
  8, 'incremental round, limits 1/3: the same rows as one big page, none twice');
select is(
  (select pg_temp.norm(v -> 'ids') from incs where u = 'u_col_pemba' and lim = 1000),
  pg_temp.norm(jsonb_build_object(
    'projects', jsonb_build_array(tests.id('p_pemba_2')),
    'project_maintenance', jsonb_build_array(tests.id('maint:p_pemba_1')),
    'project_photos', jsonb_build_array(tests.id('photo:p_pemba_1')),
    'persons', jsonb_build_array(tests.id('person:p_pemba_1')),
    'donors', jsonb_build_array(tests.id('donor:p_pemba_1')))),
  'collector: exactly the changed rows in scope (tombstone included, no salary)');
select ok(
  (select pg_temp.norm(v -> 'ids') -> 'staff_compensation' = jsonb_build_array(tests.id('comp:p_pemba_1'))
   from incs where u = 'u_mgr_tz' and lim = 1)
  and (select not (v -> 'ids' ? 'persons') and not (v -> 'ids' ? 'staff_compensation')
       from incs where u = 'u_viewer_tz' and lim = 1),
  'manager gets the restricted change page by page; the viewer gets neither people nor salaries');

-- =============================================================================
-- J. Completeness bumps from another device never cause a conflict
-- =============================================================================
insert into res
select 'j0', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(5000, 'projects', pg_temp.nid(5000), '0', jsonb_build_object(
    'name_ar', U&'\0645\0633\062C\062F', 'type', 'mosque', 'status', 'active', 'lon', 39.714, 'lat', -5.014))));
insert into res   -- children from another device re-compute projects.completeness (version + 3)
select 'j1', pg_temp.push(tests.id('u_col_pemba'), 'dev-b', jsonb_build_array(
  pg_temp.op(5001, 'project_facilities', pg_temp.nid(5001), '0', jsonb_build_object('project_id', pg_temp.nid(5000), 'library', true)),
  pg_temp.op(5002, 'project_land', pg_temp.nid(5002), '0', jsonb_build_object('project_id', pg_temp.nid(5000), 'area_m2', 5)),
  pg_temp.op(5003, 'project_photos', pg_temp.nid(5003), '0', jsonb_build_object('project_id', pg_temp.nid(5000)))));
insert into res   -- dev-a still holds version 1
select 'j2', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(
  pg_temp.op(5004, 'projects', pg_temp.nid(5000), '1', '{"builder": "late", "capacity": 5}')));
select ok(
  pg_temp.ver(pg_temp.nid(5000)) = 5 and pg_temp.r('j2') ->> 'status' = 'merged'
  and not (pg_temp.r('j2') ? 'conflict_fields')
  and (select p.builder = 'late' and p.capacity = 5 from public.projects p where p.id = pg_temp.nid(5000)),
  'version bumps from completeness (other device) end as merged, never as a conflict');

select * from finish();
rollback;

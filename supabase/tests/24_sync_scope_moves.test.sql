-- =============================================================================
-- 24  Scope moves ("gone" lists, children travel with a re-scoped project)
--     and sync housekeeping (migration 0025; docs/contracts/sync.md)
-- =============================================================================
begin;
set local search_path = public, extensions, tests;

select plan(22);

-- Deterministic transaction-id clock, see 23_sync_pull.test.sql.
create or replace function private.current_xid() returns bigint language sql stable as
$fn$ select current_setting('test.xid')::bigint $fn$;
create or replace function private.safe_xid() returns bigint language sql stable as
$fn$ select current_setting('test.safe')::bigint $fn$;

create function pg_temp.clock(p_xid integer) returns void language plpgsql as
$fn$
declare
  b bigint := current_setting('test.base')::bigint;
begin
  perform set_config('test.xid', (b + p_xid)::text, true);
  perform set_config('test.safe', (b + p_xid + 1)::text, true);
end;
$fn$;

do $$
begin
  perform set_config('test.base', (pg_current_xact_id()::text::bigint + 1000000)::text, true);
  perform set_config('app.rate_limit', 'off', true);
  perform pg_temp.clock(100);
  perform tests.fixture_extra();
end $$;

create temp table res (k text primary key, v jsonb) on commit drop;

-- Pages until done: {cursor, ids: {table: [...]}, gone: {table: [...]}}
create function pg_temp.pull_all(p_user uuid, p_cursor jsonb default null, p_aal text default 'aal1', p_limit integer default 1000)
returns jsonb language plpgsql as
$fn$
declare
  r        jsonb;
  ch       jsonb;
  v_cursor jsonb := p_cursor;
  v_ids    jsonb := '{}'::jsonb;
  v_gone   jsonb := '{}'::jsonb;
  v_pages  integer := 0;
begin
  perform tests.login_as(p_user, p_aal, 'dev-move');
  loop
    r := public.sync_pull(v_cursor, p_limit);
    v_pages := v_pages + 1;
    for ch in select value from jsonb_array_elements(r -> 'changes') loop
      if jsonb_array_length(ch -> 'rows') > 0 then
        v_ids := jsonb_set(v_ids, array[ch ->> 'table'],
          coalesce(v_ids -> (ch ->> 'table'), '[]'::jsonb)
          || (select jsonb_agg(x -> 'id') from jsonb_array_elements(ch -> 'rows') x));
      end if;
      if ch ? 'gone' then
        v_gone := jsonb_set(v_gone, array[ch ->> 'table'],
          coalesce(v_gone -> (ch ->> 'table'), '[]'::jsonb) || (ch -> 'gone'));
      end if;
    end loop;
    v_cursor := r -> 'cursor';
    exit when (r ->> 'done')::boolean or v_pages >= 2000;
  end loop;
  perform tests.logout();
  return jsonb_build_object('cursor', v_cursor, 'ids', v_ids, 'gone', v_gone);
end;
$fn$;

create function pg_temp.t(p_k text, p_table text, p_what text default 'ids') returns uuid[] language sql stable as
$fn$
  select coalesce(array_agg(x::uuid order by x::uuid), '{}'::uuid[])
  from res, jsonb_array_elements_text(coalesce(res.v -> p_what -> p_table, '[]'::jsonb)) x
  where res.k = p_k;
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

-- everybody is in sync at clock 100
insert into res select 'pemba0', pg_temp.pull_all(tests.id('u_col_pemba'));
insert into res select 'tanga0', pg_temp.pull_all(tests.id('u_col_tanga'));
insert into res select 'mgr0', pg_temp.pull_all(tests.id('u_mgr_tz'), null, 'aal2');
insert into res select 'ke0', pg_temp.pull_all(tests.id('u_mgr_ke'), null, 'aal2');

select ok(
  not (array[tests.id('p_pemba_2')] && pg_temp.t('tanga0', 'projects'))
  and not (pg_temp.t('tanga0', 'project_photos') && array[tests.id('photo:p_pemba_2')])
  and pg_temp.t('tanga0', 'donors') = array[tests.id('donor:p_tanga_1')],
  'before the move: the Tanga collector has neither the project nor its children nor its donor');

insert into res
select 'audit0', to_jsonb((select count(*) from public.audit_log a
                           where a.table_name = 'project_land' and a.row_id = tests.id('land:p_pemba_2')));
insert into res
select 'landv0', to_jsonb((select l.version from public.project_land l where l.id = tests.id('land:p_pemba_2')));

-- =============================================================================
-- 1. A project is re-assigned from branch Pemba to branch Tanga
-- =============================================================================
do $$
begin
  perform pg_temp.clock(200);
  update public.projects set branch_id = tests.id('br_tanga') where id = tests.id('p_pemba_2');
end $$;

insert into res select 'tanga1', pg_temp.pull_all(tests.id('u_col_tanga'), (select v -> 'cursor' from res where k = 'tanga0'), 'aal1', 2);

select is(pg_temp.t('tanga1', 'projects'), array[tests.id('p_pemba_2')],
  'new scope: the project arrives');
select is(
  array[pg_temp.t('tanga1', 'project_land'), pg_temp.t('tanga1', 'project_facilities'),
        pg_temp.t('tanga1', 'project_maintenance'), pg_temp.t('tanga1', 'project_photos'),
        pg_temp.t('tanga1', 'project_donors'), pg_temp.t('tanga1', 'project_staff'),
        pg_temp.t('tanga1', 'community_profiles')],
  array[array[tests.id('land:p_pemba_2')], array[tests.id('fac:p_pemba_2')],
        array[tests.id('maint:p_pemba_2')], array[tests.id('photo:p_pemba_2')],
        array[tests.id('pdonor:p_pemba_2')], array[tests.id('staff:p_pemba_2')],
        array[tests.id('community:p_pemba_2')]],
  'new scope: all children of the project arrive with it (re-stamped, small pages)');
select is(pg_temp.t('tanga1', 'donors'), array[tests.id('donor:p_pemba_2')],
  'new scope: the donor of the project arrives with its (re-stamped) link although the donor row did not change');
select is((select v -> 'gone' from res where k = 'tanga1'), '{}'::jsonb, 'new scope: nothing is gone');

insert into res select 'pemba1', pg_temp.pull_all(tests.id('u_col_pemba'), (select v -> 'cursor' from res where k = 'pemba0'));

select is(pg_temp.t('pemba1', 'projects', 'gone'), array[tests.id('p_pemba_2')],
  'old scope: the project is reported as gone');
select is((select v -> 'ids' from res where k = 'pemba1'), '{}'::jsonb,
  'old scope: no row of the project (or of its children) is sent any more');

insert into res select 'mgr1', pg_temp.pull_all(tests.id('u_mgr_tz'), (select v -> 'cursor' from res where k = 'mgr0'), 'aal2');

select ok(
  pg_temp.t('mgr1', 'projects') = array[tests.id('p_pemba_2')]
  and pg_temp.t('mgr1', 'staff_compensation') = array[tests.id('comp:p_pemba_2')]
  and pg_temp.t('mgr1', 'community_sensitive') = array[tests.id('sens:p_pemba_2')],
  'country manager (still in scope): project and restricted children are re-delivered');
select is((select v -> 'gone' from res where k = 'mgr1'), '{}'::jsonb,
  'country manager: the project did not leave his scope');

insert into res select 'ke1', pg_temp.pull_all(tests.id('u_mgr_ke'), (select v -> 'cursor' from res where k = 'ke0'), 'aal2');
select is((select (v -> 'ids') || (v -> 'gone') from res where k = 'ke1'), '{}'::jsonb,
  'another country hears nothing about the move');

select is(
  (select count(*) from public.audit_log a
   where a.table_name = 'project_land' and a.row_id = tests.id('land:p_pemba_2')),
  (select (v #>> '{}')::bigint from res where k = 'audit0'),
  're-stamping children writes no audit rows (no data changed)');
select is(
  (select l.version from public.project_land l where l.id = tests.id('land:p_pemba_2')),
  (select (v #>> '{}')::int + 1 from res where k = 'landv0'),
  're-stamped children get a new version');

-- a later edit of a re-stamped child from a device with the old version is not a conflict
insert into res
select 'edit', pg_temp.push(tests.id('u_sup_pemba'), 'dev-s', jsonb_build_array(jsonb_build_object(
  'op_id', '00000000-0000-7000-8000-000000000001', 'table', 'project_maintenance',
  'id', tests.id('maint:p_pemba_1'), 'kind', 'upsert',
  'base_version', (select m.version from public.project_maintenance m where m.id = tests.id('maint:p_pemba_1')),
  'fields', jsonb_build_object('priority', 'low'))));
select is((select v #>> '{results,0,status}' from res where k = 'edit'), 'applied', 'sanity: supervisor edit applies');

-- =============================================================================
-- 2. A person is moved to another branch
-- =============================================================================
do $$
begin
  perform pg_temp.clock(300);
  update public.persons set branch_id = tests.id('br_tanga') where id = tests.id('person2:p_pemba_1');
end $$;

insert into res select 'pemba2', pg_temp.pull_all(tests.id('u_col_pemba'), (select v -> 'cursor' from res where k = 'pemba1'));
insert into res select 'tanga2', pg_temp.pull_all(tests.id('u_col_tanga'), (select v -> 'cursor' from res where k = 'tanga1'));

select is(pg_temp.t('pemba2', 'persons', 'gone'), array[tests.id('person2:p_pemba_1')],
  'old scope: the person is reported as gone');
select is(pg_temp.t('tanga2', 'persons'), array[tests.id('person2:p_pemba_1')],
  'new scope: the person arrives');

-- a viewer never had persons: no gone list for them either
insert into res select 'view', pg_temp.pull_all(tests.id('u_viewer_tz'), null);
select ok(not ((select v -> 'gone' from res where k = 'view') ? 'persons'), 'viewers get no gone list for persons');

-- =============================================================================
-- 3. Moves through sync_push
-- =============================================================================
insert into res
select 'mv1', pg_temp.push(tests.id('u_col_pemba'), 'dev-a', jsonb_build_array(jsonb_build_object(
  'op_id', '00000000-0000-7000-8000-000000000002', 'table', 'projects',
  'id', tests.id('p_pemba_1'), 'kind', 'upsert',
  'base_version', (select version from public.projects where id = tests.id('p_pemba_1')),
  'fields', jsonb_build_object('branch_id', tests.id('br_tanga')))));
select is((select v #>> '{results,0,error,code}' from res where k = 'mv1'), 'out_of_scope',
  'a collector cannot move his project into a branch outside his scope');

insert into res
select 'mv2', pg_temp.push(tests.id('u_mgr_tz'), 'dev-m', jsonb_build_array(jsonb_build_object(
  'op_id', '00000000-0000-7000-8000-000000000003', 'table', 'projects',
  'id', tests.id('p_pemba_1'), 'kind', 'upsert',
  'base_version', (select version from public.projects where id = tests.id('p_pemba_1')),
  'fields', jsonb_build_object('branch_id', tests.id('br_tanga')))), 'aal2');
select is((select v #>> '{results,0,status}' from res where k = 'mv2'), 'applied',
  'the country manager moves a project between branches of his country');
select is(
  (select count(*)::int from private.sync_scope_moves m
   where m.table_name = 'projects' and m.row_id = tests.id('p_pemba_1') and m.old_branch_id = tests.id('br_pemba')),
  1, 'the move is logged with the old scope');

insert into res
select 'mv3', pg_temp.push(tests.id('u_mgr_tz'), 'dev-m', jsonb_build_array(jsonb_build_object(
  'op_id', '00000000-0000-7000-8000-000000000004', 'table', 'projects',
  'id', tests.id('p_tanga_1'), 'kind', 'upsert',
  'base_version', (select version from public.projects where id = tests.id('p_tanga_1')),
  'fields', jsonb_build_object('branch_id', tests.id('br_mombasa')))), 'aal2');
select is((select v #>> '{results,0,error,code}' from res where k = 'mv3'), 'branch_country_mismatch',
  'a project cannot be attached to a branch of another country');

-- =============================================================================
-- 4. Housekeeping
-- =============================================================================
insert into public.sync_applied_ops (op_id, user_id, device_id, result, applied_at)
values ('00000000-0000-7000-8000-00000000aaaa', tests.id('u_col_pemba'), 'dev-old', '{"status": "applied"}',
        now() - interval '400 days');
insert into private.sync_scope_moves (table_name, row_id, old_branch_id, sync_xid, moved_at)
values ('projects', tests.id('p_ke_1'), tests.id('br_mombasa'), 1, now() - interval '400 days');

select is(private.sync_prune(), '{"applied_ops": 1, "scope_moves": 1}'::jsonb,
  'sync_prune() removes ledger rows and scope moves older than the retention');
select ok(
  exists (select 1 from public.sync_applied_ops o where o.op_id = '00000000-0000-7000-8000-000000000003')
  and exists (select 1 from private.sync_scope_moves m where m.row_id = tests.id('p_pemba_1')),
  'recent ledger rows and moves are kept');

select * from finish();
rollback;

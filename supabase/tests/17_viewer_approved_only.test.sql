-- =============================================================================
-- 17  Viewers see approved projects only (owner decision ح, interim — see
--     docs/OWNER_DECISIONS.md "أسئلة فرعية"; migrations 0013, 0015, 0022, 0025,
--     0032-0036, 0050-0054)
--
--   A viewer serves donor relations ("public reports", brief §3). Draft,
--   submitted and returned projects — and every row below them — are visible
--   only inside the caller's PEOPLE scope (every role except viewer). A user
--   with a viewer grant AND another role sees unreviewed projects where the
--   other role reaches.
--
--   Here: RLS, sync_pull (also "gone" when a project leaves 'approved' and the
--   children re-stamped when it enters it), search, projects_page,
--   project_duplicates, dashboard, report_country, report_project and
--   report_donor. Elsewhere: tiles (file 34), export (51), storage (15), the
--   per-role RLS lists (10, 11), the first pull (23).
-- =============================================================================
begin;
set local search_path = public, extensions, tests;

select plan(28);

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

-- -----------------------------------------------------------------------------
-- Extra data: a global viewer who is also a Pemba field collector; a Kenyan
-- draft (k17001); two Pemba projects sharing the made-up word "zubeirqx", one
-- approved (k17002) and one returned (k17003); a donor "faraqx" (k17101)
-- linked to the returned project only (k17102).
-- -----------------------------------------------------------------------------
select tests.create_user('u_mixed17@example.org', 'viewer', 'global', null) as u_mixed \gset
select tests.create_user('u_mixed17@example.org', 'field_collector', 'branch', tests.id('br_pemba')) as u_mixed2 \gset

insert into public.projects
  (id, created_by, name_ar, name_latin, type, status, capacity, geom, country_id, branch_id, record_state)
values
  ('00000000-0000-4000-8000-000000017001', tests.id('u_col_ke'), 'مسودة كينية', 'Kenya draft', 'mosque', 'active', 50,
   st_setsrid(st_makepoint(39.60, -4.10), 4326), tests.id('ke'), tests.id('br_mombasa'), 'draft'),
  ('00000000-0000-4000-8000-000000017002', tests.id('u_col_pemba'), 'مسجد زبيركس', 'Masjid Zubeirqx', 'mosque', 'active', 70,
   st_setsrid(st_makepoint(39.76, -5.06), 4326), tests.id('tz'), tests.id('br_pemba'), 'approved'),
  ('00000000-0000-4000-8000-000000017003', tests.id('u_col_pemba'), 'مدرسة زبيركس', 'Shule Zubeirqx', 'school', 'active', 30,
   st_setsrid(st_makepoint(39.77, -5.07), 4326), tests.id('tz'), tests.id('br_pemba'), 'returned');
insert into public.donors (id, created_by, name_ar, name_latin)
values ('00000000-0000-4000-8000-000000017101', tests.id('u_col_pemba'), 'وقف فاراكس', 'Faraqx Trust');
insert into public.project_donors (id, created_by, project_id, donor_id, amount, currency, year)
values ('00000000-0000-4000-8000-000000017102', tests.id('u_col_pemba'), '00000000-0000-4000-8000-000000017003',
        '00000000-0000-4000-8000-000000017101', 100, 'USD', 2024);

create temp table res (k text primary key, v jsonb) on commit drop;

-- Pages until done: {cursor, ids: {table: [...]}, gone: {table: [...]}}
create function pg_temp.pull_all(p_user uuid, p_cursor jsonb default null, p_aal text default 'aal1')
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
  perform tests.login_as(p_user, p_aal, 'dev-17');
  loop
    r := public.sync_pull(v_cursor, 1000);
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

-- =============================================================================
-- A. RLS
-- =============================================================================
select tests.login_as(:'u_mixed'::uuid, 'aal1');
select is(
  tests.visible('projects', tests.fixture_projects() || '00000000-0000-4000-8000-000000017001'::uuid),
  tests.ids('p_pemba_1', 'p_pemba_2', 'p_tanga_1', 'p_ke_1'),
  'global viewer + Pemba collector: the draft of his branch and every approved project, not the Kenyan draft');
select is(
  tests.visible('project_photos', tests.kind_ids('photo')),
  tests.ids('photo:p_pemba_1', 'photo:p_pemba_2', 'photo:p_tanga_1', 'photo:p_ke_1'),
  'global viewer + Pemba collector: the children of his branch''s draft as well');

select tests.login_as(tests.id('u_viewer_tz'), 'aal1');
select ok(
  tests.visible('projects', array['00000000-0000-4000-8000-000000017002', '00000000-0000-4000-8000-000000017003']::uuid[])
    = array['00000000-0000-4000-8000-000000017002'::uuid]
  and tests.visible('project_donors', array['00000000-0000-4000-8000-000000017102'::uuid]) = '{}'::uuid[]
  and tests.visible('donors', array['00000000-0000-4000-8000-000000017101'::uuid]) = '{}'::uuid[],
  'country viewer: a returned project, its donor link and a donor linked to it only are invisible');

select tests.login_as(tests.id('u_viewer_global'), 'aal1');
select ok(
  tests.visible('donors', array['00000000-0000-4000-8000-000000017101'::uuid]) = array['00000000-0000-4000-8000-000000017101'::uuid]
  and tests.visible('project_donors', array['00000000-0000-4000-8000-000000017102'::uuid]) = '{}'::uuid[],
  'global viewer: every donor (global reader, donor relations) but not the link to an unreviewed project');
select tests.logout();

-- =============================================================================
-- B. sync_pull: first pull, approval (children re-stamped), leaving 'approved' ("gone")
-- =============================================================================
insert into res select 'v0', pg_temp.pull_all(tests.id('u_viewer_tz'));
insert into res select 'g0', pg_temp.pull_all(tests.id('u_viewer_global'));
insert into res select 'c0', pg_temp.pull_all(tests.id('u_col_pemba'));
insert into res select 'm0', pg_temp.pull_all(:'u_mixed'::uuid);

select ok(
  pg_temp.t('m0', 'projects') @> array[tests.id('p_pemba_2'), '00000000-0000-4000-8000-000000017003'::uuid, tests.id('p_ke_1')]
  and not (pg_temp.t('m0', 'projects') && array['00000000-0000-4000-8000-000000017001'::uuid])
  and pg_temp.t('m0', 'project_staff') @> array[tests.id('staff:p_pemba_2')],
  'global viewer + Pemba collector, first pull: the unreviewed projects of his branch (with staff), no other draft');
select ok(
  not (pg_temp.t('v0', 'projects') && array[tests.id('p_pemba_2'), '00000000-0000-4000-8000-000000017003'::uuid])
  and not (pg_temp.t('g0', 'projects')
           && array[tests.id('p_pemba_2'), '00000000-0000-4000-8000-000000017001'::uuid, '00000000-0000-4000-8000-000000017003'::uuid])
  and pg_temp.t('g0', 'projects') @> array[tests.id('p_pemba_1'), tests.id('p_ke_1'), '00000000-0000-4000-8000-000000017002'::uuid]
  and not (pg_temp.t('v0', 'project_donors') && array['00000000-0000-4000-8000-000000017102'::uuid]),
  'viewers, first pull: approved projects only, no link to an unreviewed project');

-- the reviewer approves p_pemba_2
do $$
begin
  perform pg_temp.clock(200);
  update public.projects set record_state = 'approved' where id = tests.id('p_pemba_2');
end $$;

insert into res select 'v1', pg_temp.pull_all(tests.id('u_viewer_tz'), (select v -> 'cursor' from res where k = 'v0'));

select is(pg_temp.t('v1', 'projects'), array[tests.id('p_pemba_2')],
  'approval: the project reaches the viewer');
select is(
  array[pg_temp.t('v1', 'project_land'), pg_temp.t('v1', 'project_facilities'),
        pg_temp.t('v1', 'project_maintenance'), pg_temp.t('v1', 'project_photos'),
        pg_temp.t('v1', 'project_donors'), pg_temp.t('v1', 'community_profiles')],
  array[array[tests.id('land:p_pemba_2')], array[tests.id('fac:p_pemba_2')],
        array[tests.id('maint:p_pemba_2')], array[tests.id('photo:p_pemba_2')],
        array[tests.id('pdonor:p_pemba_2')], array[tests.id('community:p_pemba_2')]],
  'approval: its public children travel with it (re-stamped, the rows themselves did not change)');
select ok(
  pg_temp.t('v1', 'donors') = array[tests.id('donor:p_pemba_2')]
  and not ((select v -> 'ids' from res where k = 'v1') ?| array['project_staff', 'persons', 'staff_compensation'])
  and (select v -> 'gone' from res where k = 'v1') = '{}'::jsonb,
  'approval: the donor arrives with its link; still no people data; nothing is gone');

-- a collector's edit sends it back for review
do $$
begin
  perform pg_temp.clock(300);
  update public.projects set record_state = 'submitted' where id = tests.id('p_pemba_2');
end $$;

insert into res select 'v2', pg_temp.pull_all(tests.id('u_viewer_tz'), (select v -> 'cursor' from res where k = 'v1'));
insert into res select 'g1', pg_temp.pull_all(tests.id('u_viewer_global'), (select v -> 'cursor' from res where k = 'g0'));
insert into res select 'c1', pg_temp.pull_all(tests.id('u_col_pemba'), (select v -> 'cursor' from res where k = 'c0'));
insert into res select 'm1', pg_temp.pull_all(:'u_mixed'::uuid, (select v -> 'cursor' from res where k = 'm0'));

select ok(
  pg_temp.t('v2', 'projects', 'gone') = array[tests.id('p_pemba_2')]
  and pg_temp.t('v2', 'projects') = '{}'::uuid[]
  and pg_temp.t('v2', 'project_photos') = '{}'::uuid[],
  'leaving approved: listed under "gone" for the country viewer; neither the row nor a child is sent');
select is(pg_temp.t('g1', 'projects', 'gone'), array[tests.id('p_pemba_2')],
  'leaving approved: a global viewer gets it under "gone" as well');
select ok(
  pg_temp.t('c1', 'projects') = array[tests.id('p_pemba_2')]
  and not ((select v -> 'gone' from res where k = 'c1') ? 'projects')
  and pg_temp.t('m1', 'projects') @> array[tests.id('p_pemba_2')]
  and not ((select v -> 'gone' from res where k = 'm1') ? 'projects'),
  'leaving approved: the collector and the viewer + collector (people scope) get the row, nothing is gone');
select is(
  (select count(*)::int from private.sync_scope_moves m
   where m.table_name = 'projects' and m.row_id = tests.id('p_pemba_2')
     and m.old_branch_id = tests.id('br_pemba') and m.old_country_id = tests.id('tz')),
  1, 'only the leave is logged as a move (unchanged country / branch); the approval is not');

-- =============================================================================
-- C. search
-- =============================================================================
select tests.login_as(tests.id('u_viewer_tz'), 'aal1');
select is(
  (select coalesce(array_agg((h ->> 'id')::uuid order by h ->> 'id'), '{}'::uuid[])
   from jsonb_array_elements(public.search('zubeirqx')) h where h ->> 'kind' = 'project'),
  array['00000000-0000-4000-8000-000000017002'::uuid],
  'search (country viewer): the approved project, not the returned one');
select ok(
  not exists (select 1 from jsonb_array_elements(public.search('faraqx')) h where h ->> 'kind' = 'donor'),
  'search (country viewer): a donor of an unreviewed project only is not found');
select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select ok(
  (select count(*) from jsonb_array_elements(public.search('zubeirqx')) h where h ->> 'kind' = 'project') = 2
  and exists (select 1 from jsonb_array_elements(public.search('faraqx')) h
              where h ->> 'kind' = 'donor' and h ->> 'id' = '00000000-0000-4000-8000-000000017101'),
  'search (collector): both projects and the donor');

-- =============================================================================
-- D. projects_page / project_duplicates
-- =============================================================================
create function pg_temp.page_ids(p_filters jsonb) returns text language sql as
$fn$
  select coalesce(string_agg(r ->> 'id', ',' order by r ->> 'id'), '') || ' total=' || (x.p ->> 'total')
  from (select public.projects_page(p_filters, null, 50) as p) x
  left join lateral jsonb_array_elements(x.p -> 'rows') r on true
  group by x.p ->> 'total';
$fn$;

select tests.login_as(tests.id('u_viewer_tz'), 'aal1');
select is(pg_temp.page_ids('{"q": "zubeirqx"}'::jsonb),
  '00000000-0000-4000-8000-000000017002 total=1',
  'projects_page (country viewer): the approved project only, total counts it alone');
select tests.login_as(:'u_mixed'::uuid, 'aal1');
select is(pg_temp.page_ids('{"q": "zubeirqx"}'::jsonb),
  '00000000-0000-4000-8000-000000017002,00000000-0000-4000-8000-000000017003 total=2',
  'projects_page (global viewer + Pemba collector): the returned project of his branch as well');

-- p_pemba_2 (now submitted) is a school at 39.70 / -4.95
select tests.login_as(tests.id('u_viewer_tz'), 'aal1');
select set_config('t.dup_v', public.project_duplicates('school', 39.70, -4.95, null, null)::text, true);
select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select set_config('t.dup_c', public.project_duplicates('school', 39.70, -4.95, null, null)::text, true);
select ok(
  not jsonb_path_exists(current_setting('t.dup_v')::jsonb, '$[*] ? (@.id == $id)', jsonb_build_object('id', tests.id('p_pemba_2')))
  and jsonb_path_exists(current_setting('t.dup_c')::jsonb, '$[*] ? (@.id == $id)', jsonb_build_object('id', tests.id('p_pemba_2'))),
  'project_duplicates: an unreviewed neighbour is offered to the collector, never to a viewer');
select tests.logout();

-- =============================================================================
-- E. dashboard / report_country / report_project / report_donor
-- =============================================================================
do $$ begin perform public.refresh_reports(); end $$;

select
  (select count(*) from public.projects p where p.deleted_at is null and p.record_state = 'approved')::int as n_approved,
  (select count(*) from public.projects p where p.deleted_at is null and p.record_state = 'approved'
                                            and p.country_id = tests.id('tz'))::int as n_tz_approved,
  (select count(*) from public.projects p where p.deleted_at is null and p.record_state = 'approved'
                                            and p.branch_id = tests.id('br_pemba'))::int as n_pemba_approved,
  (select count(*) from public.projects p where p.deleted_at is null and p.branch_id = tests.id('br_pemba'))::int as n_pemba_all,
  (select count(*) from public.project_maintenance m join public.projects p on p.id = m.project_id
   where m.deleted_at is null and p.deleted_at is null and m.state in ('open', 'in_progress')
     and p.record_state = 'approved' and p.branch_id = tests.id('br_pemba'))::int as n_pemba_maint_approved \gset

select tests.login_as(tests.id('u_viewer_global'), 'aal1');
select set_config('t.d', public.dashboard('global', null)::text, true);
select ok(
  (current_setting('t.d')::jsonb #>> '{totals,projects}')::int = :n_approved
  and current_setting('t.d')::jsonb #> '{totals,by_record_state}' = '{"draft": 0, "submitted": 0, "approved": 0, "returned": 0}'::jsonb
                                                                 || jsonb_build_object('approved', :n_approved),
  'dashboard (global viewer): totals of the approved projects only');

select tests.login_as(tests.id('u_viewer_tz'), 'aal1');
select set_config('t.d', public.dashboard('branch', tests.id('br_pemba'))::text, true);
select ok(
  (current_setting('t.d')::jsonb #>> '{totals,projects}')::int = :n_pemba_approved
  and (current_setting('t.d')::jsonb #>> '{maintenance,open_total}')::int = :n_pemba_maint_approved
  and not jsonb_path_exists(current_setting('t.d')::jsonb, '$.maintenance.items[*] ? (@.project_id == $id)',
                            jsonb_build_object('id', tests.id('p_pemba_2'))),
  'dashboard (country viewer, branch scope): projects and open maintenance of approved projects only');

select tests.login_as(:'u_mixed'::uuid, 'aal1');
select is((public.dashboard('branch', tests.id('br_pemba')) #>> '{totals,projects}')::int, :n_pemba_all,
  'dashboard (viewer + collector of the branch): people scope on the branch, every record state counts');

select tests.login_as(tests.id('u_viewer_tz'), 'aal1');
select set_config('t.r', public.report_country(tests.id('tz'))::text, true);
select ok(
  (current_setting('t.r')::jsonb #>> '{totals,projects}')::int = :n_tz_approved
  and (select (b ->> 'projects')::int from jsonb_array_elements(current_setting('t.r')::jsonb -> 'branches') b
       where b ->> 'branch_id' = tests.id('br_pemba')::text) = :n_pemba_approved
  and (select count(*) = count(distinct coalesce(b ->> 'branch_id', 'nil'))
       from jsonb_array_elements(current_setting('t.r')::jsonb -> 'branches') b),
  'report_country (country viewer): totals and branch rows of approved projects only, one row per branch');

select tests.login_as(tests.id('u_mgr_tz'), 'aal2');
select set_config('t.r', public.report_country(tests.id('tz'))::text, true);
select ok(
  (select (b ->> 'projects')::int from jsonb_array_elements(current_setting('t.r')::jsonb -> 'branches') b
   where b ->> 'branch_id' = tests.id('br_pemba')::text) = :n_pemba_all
  and (select count(*) = count(distinct coalesce(b ->> 'branch_id', 'nil'))
       from jsonb_array_elements(current_setting('t.r')::jsonb -> 'branches') b),
  'report_country (country manager): every record state, still one row per branch');

select tests.login_as(tests.id('u_viewer_tz'), 'aal1');
select throws_ok(format('select public.report_project(%L)', tests.id('p_pemba_2')), 'PT404', 'project not found',
  'report_project: an unreviewed project does not exist for a viewer');
select throws_ok(format('select public.report_donor(%L)', '00000000-0000-4000-8000-000000017101'), 'PT404', 'donor not found',
  'report_donor: a donor linked to unreviewed projects only does not exist for a country viewer');

select tests.login_as(tests.id('u_viewer_global'), 'aal1');
select set_config('t.r', public.report_donor('00000000-0000-4000-8000-000000017101')::text, true);
select ok(
  (current_setting('t.r')::jsonb ->> 'projects_total')::int = 0
  and jsonb_array_length(current_setting('t.r')::jsonb -> 'projects') = 0,
  'report_donor (global viewer): the donor, without its unreviewed project');

select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select ok(
  (public.report_project(tests.id('p_pemba_2')) #>> '{project,id}')::uuid = tests.id('p_pemba_2')
  and (public.report_donor('00000000-0000-4000-8000-000000017101') ->> 'projects_total')::int = 1,
  'report_project / report_donor (collector): the unreviewed project is there');

select tests.logout();
select * from finish();
rollback;

-- =============================================================================
-- 23  sync_pull: scope, restricted data, paging, tombstones, xmin cursor
--     (docs/contracts/sync.md; migration 0022; brief §3, §4, acceptance 5)
--
-- THE TRANSACTION-ID CLOCK IN THIS FILE
--
-- sync_pull returns rows with lo <= sync_xid < hi where hi = private.safe_xid()
-- (xmin of the snapshot = the oldest transaction still running). A pgTAP file
-- is ONE transaction: everything it writes carries the id of that still-open
-- transaction, which by definition is >= hi. The real function would therefore
-- (correctly!) return none of the rows written by the test itself.
--
-- To test the protocol in one session the two clock functions are replaced,
-- inside this transaction only, by versions that read two settings:
--     private.current_xid() -> test.xid   "id of the transaction that writes now"
--     private.safe_xid()    -> test.safe  "oldest transaction still running"
-- pg_temp.clock(n) moves the clock. This makes it possible to replay, step by
-- step, what several concurrent transactions would do (section 7 below).
-- What cannot be shown in one session is PostgreSQL's own guarantee that
-- pg_snapshot_xmin() never exceeds the id of a transaction that is still in
-- progress; the protocol relies on exactly that documented property.
-- =============================================================================
begin;
set local search_path = public, extensions, tests;

select plan(97);

create or replace function private.current_xid() returns bigint language sql stable as
$fn$ select current_setting('test.xid')::bigint $fn$;
create or replace function private.safe_xid() returns bigint language sql stable as
$fn$ select current_setting('test.safe')::bigint $fn$;

-- The clock starts far above every real transaction id, so rows that already
-- exist in the database (reference data, staging seed) lie in the past.
create function pg_temp.clock(p_xid integer, p_safe integer default null) returns void language plpgsql as
$fn$
declare
  b bigint := current_setting('test.base')::bigint;
begin
  perform set_config('test.xid', (b + p_xid)::text, true);
  perform set_config('test.safe', (b + coalesce(p_safe, p_xid + 1))::text, true);
end;
$fn$;

create function pg_temp.base() returns bigint language sql stable as
$fn$ select current_setting('test.base')::bigint $fn$;

do $$
begin
  perform set_config('test.base', (pg_current_xact_id()::text::bigint + 1000000)::text, true);
  perform set_config('app.rate_limit', 'off', true);   -- many small pages below
  perform pg_temp.clock(100);
  perform tests.fixture_extra();
end $$;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------
create temp table res (k text primary key, v jsonb) on commit drop;

create function pg_temp.pull(
  p_user uuid, p_cursor jsonb, p_limit integer, p_aal text default 'aal1', p_device text default 'dev-pull')
returns jsonb language plpgsql as
$fn$
declare
  r jsonb;
begin
  perform tests.login_as(p_user, p_aal, p_device);
  r := public.sync_pull(p_cursor, p_limit);
  perform tests.logout();
  return r;
end;
$fn$;

-- Pages until done and collects the ids per table:
-- {pages, rows, max_page, reset, cursor, scope_epoch, ids: {table: [id, ...]}}
create function pg_temp.pull_all(
  p_user uuid, p_limit integer, p_cursor jsonb default null, p_aal text default 'aal1',
  p_device text default 'dev-pull')
returns jsonb language plpgsql as
$fn$
declare
  r        jsonb;
  ch       jsonb;
  v_cursor jsonb := p_cursor;
  v_ids    jsonb := '{}'::jsonb;
  v_pages  integer := 0;
  v_rows   integer := 0;
  v_max    integer := 0;
  v_page   integer;
  v_reset  boolean := false;
begin
  perform tests.login_as(p_user, p_aal, p_device);
  loop
    r := public.sync_pull(v_cursor, p_limit);
    v_pages := v_pages + 1;
    v_page := 0;
    for ch in select value from jsonb_array_elements(r -> 'changes') loop
      v_ids := jsonb_set(v_ids, array[ch ->> 'table'],
        coalesce(v_ids -> (ch ->> 'table'), '[]'::jsonb)
        || (select coalesce(jsonb_agg(x -> 'id'), '[]'::jsonb) from jsonb_array_elements(ch -> 'rows') x));
      v_page := v_page + jsonb_array_length(ch -> 'rows');
    end loop;
    v_rows := v_rows + v_page;
    v_max := greatest(v_max, v_page);
    v_reset := v_reset or (r ->> 'reset')::boolean;
    v_cursor := r -> 'cursor';
    exit when (r ->> 'done')::boolean or v_pages >= 5000;
  end loop;
  perform tests.logout();
  return jsonb_build_object('pages', v_pages, 'rows', v_rows, 'max_page', v_max, 'reset', v_reset,
                            'cursor', v_cursor, 'scope_epoch', r -> 'scope_epoch', 'ids', v_ids);
end;
$fn$;

-- sorted ids of one table in a stored pull_all result
create function pg_temp.t(p_k text, p_table text) returns uuid[] language sql stable as
$fn$
  select coalesce(array_agg(x::uuid order by x::uuid), '{}'::uuid[])
  from res, jsonb_array_elements_text(coalesce(res.v -> 'ids' -> p_table, '[]'::jsonb)) x
  where res.k = p_k;
$fn$;

create function pg_temp.tables(p_k text) returns text[] language sql stable as
$fn$
  select coalesce(array_agg(key order by key), '{}'::text[])
  from res, jsonb_object_keys(res.v -> 'ids') key
  where res.k = p_k;
$fn$;

-- number of ids delivered more than once in a stored pull_all result
create function pg_temp.dups(p_k text) returns integer language sql stable as
$fn$
  select (count(*) - count(distinct (t.key, x)))::integer
  from res, jsonb_each(res.v -> 'ids') t, jsonb_array_elements_text(t.value) x
  where res.k = p_k;
$fn$;

-- one row of a single-page pull result
create function pg_temp.row_of(p_r jsonb, p_table text, p_id uuid) returns jsonb language sql stable as
$fn$
  select x
  from jsonb_array_elements(p_r -> 'changes') ch, jsonb_array_elements(ch -> 'rows') x
  where ch ->> 'table' = p_table and (x ->> 'id')::uuid = p_id;
$fn$;

-- sorted ids of the live donors p_user can read with direct SQL (RLS policy
-- donors_select): the reference for what sync_pull may send
create function pg_temp.rls_donors(p_user uuid, p_aal text default 'aal1') returns uuid[] language plpgsql as
$fn$
declare
  v uuid[];
begin
  perform tests.login_as(p_user, p_aal, 'dev-pull');
  select coalesce(array_agg(d.id order by d.id), '{}'::uuid[]) into v
  from public.donors d
  where d.deleted_at is null;
  perform tests.logout();
  return v;
end;
$fn$;

-- ids of project_donors rows created by this file
create function pg_temp.lid(p_n integer) returns uuid language sql immutable as
$fn$ select ('00000000-0000-7000-9100-' || lpad(p_n::text, 12, '0'))::uuid $fn$;

insert into public.devices (user_id, device_id, label)
values (tests.id('u_col_pemba'), 'dev-pull', 'Collector phone');

-- =============================================================================
-- 1. Field collector (branch Pemba): own scope only, never restricted data
-- =============================================================================
insert into res select 'col', pg_temp.pull_all(tests.id('u_col_pemba'), 1000);

select is(pg_temp.t('col', 'projects'), tests.ids('p_pemba_1', 'p_pemba_2'),
  'collector: only the projects of his branch (no other branch, no other country)');
select is(pg_temp.t('col', 'persons'),
  tests.ids('person:p_pemba_1', 'person:p_pemba_2', 'person2:p_pemba_1'),
  'collector: only the persons of his branch');
select is(pg_temp.t('col', 'project_staff'), tests.ids('staff:p_pemba_1', 'staff:p_pemba_2'),
  'collector: staff rows of his projects');
select is(
  array[pg_temp.t('col', 'project_land'), pg_temp.t('col', 'project_facilities'),
        pg_temp.t('col', 'project_maintenance'), pg_temp.t('col', 'project_photos'),
        pg_temp.t('col', 'project_donors'), pg_temp.t('col', 'community_profiles')],
  array[tests.ids('land:p_pemba_1', 'land:p_pemba_2'), tests.ids('fac:p_pemba_1', 'fac:p_pemba_2'),
        tests.ids('maint:p_pemba_1', 'maint:p_pemba_2'), tests.ids('photo:p_pemba_1', 'photo:p_pemba_2'),
        tests.ids('pdonor:p_pemba_1', 'pdonor:p_pemba_2'), tests.ids('community:p_pemba_1', 'community:p_pemba_2')],
  'collector: children of his projects only');
select ok(
  not (pg_temp.tables('col') && array['staff_compensation', 'community_sensitive']),
  'collector: restricted tables are never sent (no salary, no sensitive data)');
select ok(
  not (pg_temp.tables('col') && array['sync_conflicts', 'person_merge_requests']),
  'collector: reviewer-only tables are not sent');
select ok(
  tests.ids('tz', 'ke') <@ pg_temp.t('col', 'countries')
  and tests.ids('br_pemba', 'br_tanga', 'br_mombasa') <@ pg_temp.t('col', 'branches')
  and array[tests.id('option_value')] <@ pg_temp.t('col', 'option_values')
  and array[tests.id('fx_rate')] <@ pg_temp.t('col', 'fx_rates')
  and array[tests.id('map_pack')] <@ pg_temp.t('col', 'map_packs'),
  'collector: global reference tables are sent');
select is(pg_temp.t('col', 'donors'), tests.ids('donor:p_pemba_1', 'donor:p_pemba_2', 'donor_unlinked'),
  'collector: the donors of his projects and the donor he created, no donor of another branch or country');
select ok(
  tests.ids('tz_pemba_north', 'tz_tanga') <@ pg_temp.t('col', 'admin_areas')
  and not (array[tests.id('ke_mombasa')] && pg_temp.t('col', 'admin_areas')),
  'collector: admin areas of his country only');
select ok(
  tests.ids('loc:tz_pemba_north', 'loc:tz_tanga') <@ pg_temp.t('col', 'localities')
  and not (array[tests.id('loc:ke_mombasa')] && pg_temp.t('col', 'localities')),
  'collector: localities of his country only');
select is(pg_temp.t('col', 'notifications'), array[tests.id('notif:u_col_pemba')],
  'collector: only his own notifications');
select is(pg_temp.dups('col'), 0, 'no row is delivered twice');
select ok((select (v ->> 'reset')::boolean = false from res where k = 'col'), 'a first pull is not a reset');

-- a Kenyan collector reads nothing of Tanzania (acceptance criterion 5)
insert into res select 'colke', pg_temp.pull_all(tests.id('u_col_ke'), 1000);
select is(pg_temp.t('colke', 'projects'), array[tests.id('p_ke_1')],
  'Kenyan collector: no Tanzanian project');
select ok(
  not (pg_temp.t('colke', 'persons') && tests.ids('person:p_pemba_1', 'person:p_pemba_2', 'person:p_tanga_1'))
  and not (pg_temp.t('colke', 'project_photos') && tests.ids('photo:p_pemba_1', 'photo:p_tanga_1'))
  and not (pg_temp.tables('colke') && array['staff_compensation', 'community_sensitive']),
  'Kenyan collector: no Tanzanian person or child row, and no salary at all');
select is(pg_temp.t('colke', 'donors'), array[tests.id('donor:p_ke_1')],
  'Kenyan collector: only the donor linked to his project, no Tanzanian donor name');

-- =============================================================================
-- 2. Branch supervisor: review tables, still no restricted data
-- =============================================================================
insert into res select 'sup', pg_temp.pull_all(tests.id('u_sup_pemba'), 1000);

select ok(
  not (pg_temp.tables('sup') && array['staff_compensation', 'community_sensitive']),
  'supervisor: restricted tables are never sent');
select is(pg_temp.t('sup', 'sync_conflicts'),
  tests.ids('conflict:p_pemba_1', 'conflict:p_pemba_2', 'pconflict:p_pemba_1',
            'lconflict:tz_pemba_north', 'lconflict:tz_tanga'),
  'supervisor: conflicts of his branch (projects, persons) and of his country''s localities');
select is(pg_temp.t('sup', 'person_merge_requests'), array[tests.id('merge:p_pemba_1')],
  'supervisor: merge requests of his branch');
select is(pg_temp.t('sup', 'projects'), tests.ids('p_pemba_1', 'p_pemba_2'), 'supervisor: projects of his branch');

-- =============================================================================
-- 3. Country manager: everything in the country incl. restricted, logged
-- =============================================================================
insert into res select 'mgr', pg_temp.pull_all(tests.id('u_mgr_tz'), 1000, null, 'aal2');

select ok(
  tests.ids('p_pemba_1', 'p_pemba_2', 'p_tanga_1') <@ pg_temp.t('mgr', 'projects')
  and not (array[tests.id('p_ke_1')] && pg_temp.t('mgr', 'projects')),
  'manager: all projects of his country, none of another country');
select ok(
  tests.ids('comp:p_pemba_1', 'comp:p_pemba_2', 'comp:p_tanga_1') <@ pg_temp.t('mgr', 'staff_compensation')
  and not (array[tests.id('comp:p_ke_1')] && pg_temp.t('mgr', 'staff_compensation')),
  'manager: salaries of his country are sent, not those of another country');
select ok(
  tests.ids('sens:p_pemba_1', 'sens:p_pemba_2', 'sens:p_tanga_1') <@ pg_temp.t('mgr', 'community_sensitive')
  and not (array[tests.id('sens:p_ke_1')] && pg_temp.t('mgr', 'community_sensitive')),
  'manager: sensitive community rows of his country only');
select ok(
  exists (select 1 from public.restricted_access_log l
          where l.user_id = tests.id('u_mgr_tz') and l.table_name = 'staff_compensation'
            and l.context = 'sync_pull' and l.device_id = 'dev-pull'
            and l.row_ids @> tests.ids('comp:p_pemba_1', 'comp:p_pemba_2', 'comp:p_tanga_1'))
  and exists (select 1 from public.restricted_access_log l
              where l.user_id = tests.id('u_mgr_tz') and l.table_name = 'community_sensitive'
                and l.context = 'sync_pull'
                and l.row_ids @> tests.ids('sens:p_pemba_1', 'sens:p_pemba_2', 'sens:p_tanga_1')),
  'every page of restricted rows is written to restricted_access_log (who, device, which rows)');
select is(
  (select count(*)::int from public.restricted_access_log l
   where l.context like 'sync_pull%' and l.user_id <> tests.id('u_mgr_tz')),
  0, 'nobody else caused a restricted read so far');
select ok(
  not (pg_temp.t('mgr', 'persons') && tests.ids('person:p_ke_1', 'person2:p_ke_1'))
  and not (pg_temp.t('mgr', 'sync_conflicts') && tests.ids('conflict:p_ke_1', 'pconflict:p_ke_1', 'lconflict:ke_mombasa')),
  'manager: no person and no conflict of another country');

-- without MFA the manager role is not effective: nothing is sent
insert into res select 'mgr1', pg_temp.pull_all(tests.id('u_mgr_tz'), 1000, null, 'aal1');
select is((select v -> 'ids' from res where k = 'mgr1'), '{}'::jsonb, 'manager at aal1 (no MFA): empty pull');
select isnt(
  (select v ->> 'scope_epoch' from res where k = 'mgr1'), (select v ->> 'scope_epoch' from res where k = 'mgr'),
  'scope_epoch differs between aal1 and aal2 for a manager');

-- =============================================================================
-- 4. Viewer: projects and public children, never people or restricted data
-- =============================================================================
insert into res select 'view', pg_temp.pull_all(tests.id('u_viewer_tz'), 1000);

-- approved projects only (owner decision ح, migration 0013): the draft
-- p_pemba_2 and its children are not sent to a viewer
select ok(
  tests.ids('p_pemba_1', 'p_tanga_1') <@ pg_temp.t('view', 'projects')
  and not (tests.ids('p_ke_1', 'p_pemba_2') && pg_temp.t('view', 'projects')),
  'viewer: approved projects of his country (no draft, no other country)');
select ok(
  not (pg_temp.tables('view') && array['persons', 'project_staff', 'staff_compensation', 'community_sensitive',
                                       'sync_conflicts', 'person_merge_requests']),
  'viewer: no persons, no staff, no restricted data, no review tables');
select ok(
  tests.ids('photo:p_pemba_1', 'photo:p_tanga_1') <@ pg_temp.t('view', 'project_photos')
  and tests.ids('community:p_pemba_1', 'community:p_tanga_1') <@ pg_temp.t('view', 'community_profiles')
  and not (pg_temp.t('view', 'project_photos') && tests.ids('photo:p_pemba_2'))
  and not (pg_temp.t('view', 'project_maintenance') && tests.ids('maint:p_pemba_2'))
  and not (pg_temp.t('view', 'community_profiles') && tests.ids('community:p_pemba_2'))
  and not (pg_temp.t('view', 'project_donors') && tests.ids('pdonor:p_pemba_2')),
  'viewer: public children of the approved projects are sent, none of the draft');

insert into res select 'viewg', pg_temp.pull_all(tests.id('u_viewer_global'), 1000);
select ok(
  tests.ids('p_pemba_1', 'p_tanga_1', 'p_ke_1') <@ pg_temp.t('viewg', 'projects')
  and not (tests.ids('p_pemba_2') && pg_temp.t('viewg', 'projects'))
  and not (tests.ids('photo:p_pemba_2') && pg_temp.t('viewg', 'project_photos'))
  and not (pg_temp.tables('viewg') && array['persons', 'project_staff', 'staff_compensation', 'community_sensitive']),
  'global viewer: approved projects of all countries, still no people and no restricted data');

-- =============================================================================
-- 5. HQ: everything
-- =============================================================================
insert into res select 'hq', pg_temp.pull_all(tests.id('u_hq'), 1000, null, 'aal2');
select ok(
  tests.ids('p_pemba_1', 'p_tanga_1', 'p_ke_1') <@ pg_temp.t('hq', 'projects')
  and tests.ids('comp:p_pemba_1', 'comp:p_ke_1') <@ pg_temp.t('hq', 'staff_compensation')
  and tests.ids('person:p_pemba_1', 'person:p_ke_1') <@ pg_temp.t('hq', 'persons')
  and tests.ids('conflict:p_ke_1', 'lconflict:ke_mombasa') <@ pg_temp.t('hq', 'sync_conflicts')
  and tests.ids('ke_mombasa', 'tz_tanga') <@ pg_temp.t('hq', 'admin_areas'),
  'hq_admin at aal2: every country, restricted tables and review tables');

-- =============================================================================
-- 5b. Donors: sync_pull sends exactly the donors the RLS policy shows
-- =============================================================================
insert into res select 'col2', pg_temp.pull_all(tests.id('u_col_pemba2'), 1000);
insert into res select 'tanga', pg_temp.pull_all(tests.id('u_col_tanga'), 1000);

select is(pg_temp.t('col2', 'donors'), tests.ids('donor:p_pemba_1', 'donor:p_pemba_2'),
  'second Pemba collector: the donors of the branch projects, not the unlinked donor of a colleague');
select ok(
  tests.ids('donor:p_pemba_1', 'donor:p_tanga_1') <@ pg_temp.t('view', 'donors')
  and not (pg_temp.t('view', 'donors') && tests.ids('donor:p_ke_1', 'donor:p_pemba_2', 'donor_unlinked')),
  'country viewer: donors linked to approved projects of his country only');
select ok(
  tests.ids('donor:p_pemba_1', 'donor:p_tanga_1', 'donor:p_ke_1', 'donor_unlinked') <@ pg_temp.t('viewg', 'donors')
  and tests.ids('donor:p_pemba_1', 'donor:p_tanga_1', 'donor:p_ke_1', 'donor_unlinked') <@ pg_temp.t('hq', 'donors'),
  'global readers (global viewer, hq_admin): every donor, linked or not');
select is(
  (select coalesce(array_agg(x.k order by x.k), '{}'::text[])
   from (values ('col', 'u_col_pemba', 'aal1'), ('col2', 'u_col_pemba2', 'aal1'), ('tanga', 'u_col_tanga', 'aal1'),
                ('colke', 'u_col_ke', 'aal1'), ('sup', 'u_sup_pemba', 'aal1'), ('mgr', 'u_mgr_tz', 'aal2'),
                ('mgr1', 'u_mgr_tz', 'aal1'), ('view', 'u_viewer_tz', 'aal1'), ('viewg', 'u_viewer_global', 'aal1'),
                ('hq', 'u_hq', 'aal2')) as x (k, u, aal)
   where pg_temp.t(x.k, 'donors') is distinct from pg_temp.rls_donors(tests.id(x.u), x.aal)),
  '{}'::text[],
  'for every role and assurance level the donors of a first pull are exactly the donors RLS shows');

-- =============================================================================
-- 6. Row shape, lon/lat round trip, paging, limits, cursor
-- =============================================================================
insert into res select 'page', pg_temp.pull(tests.id('u_col_pemba'), null, 1000);

select is(
  (select array[(x ->> 'lon')::float8, (x ->> 'lat')::float8]
   from pg_temp.row_of((select v from res where k = 'page'), 'projects', tests.id('p_pemba_1')) x),
  array[39.75, -5.05]::float8[], 'projects travel with lon/lat');
select ok(
  (select not (x ? 'geom') and not (x ? 'sync_xid') and x ? 'version' and x ? 'deleted_at' and x ? 'code'
          and (x ->> 'version')::int >= 1
   from pg_temp.row_of((select v from res where k = 'page'), 'projects', tests.id('p_pemba_1')) x),
  'project rows: no geom, no sync_xid; version and deleted_at present');
select ok(
  (select not (x ? 'geom') and not (x ? 'geom_simple') and not (x ? 'lon') and x ? 'name_en'
   from pg_temp.row_of((select v from res where k = 'page'), 'admin_areas', tests.id('tz_pemba_north')) x),
  'admin_areas rows are sent without their shapes');
select is(
  (select array[(x ->> 'lon')::float8, (x ->> 'lat')::float8]
   from pg_temp.row_of((select v from res where k = 'page'), 'localities', tests.id('loc:tz_pemba_north')) x),
  array[39.74, -5.00]::float8[], 'localities travel with lon/lat');
select is(
  (select array_agg(ch ->> 'table' order by ord)
   from res, jsonb_array_elements(res.v -> 'changes') with ordinality as c(ch, ord)
   where res.k = 'page')
  ,
  (select array_agg(r.table_name order by r.pull_order)
   from private.sync_tables r
   where r.table_name = any (pg_temp.tables('col'))),
  'tables arrive in registry order (parents before children)');

-- paging with a small limit returns every row exactly once
insert into res select 'p7', pg_temp.pull_all(tests.id('u_col_pemba'), 7);
select is((select v -> 'ids' from res where k = 'p7'), (select v -> 'ids' from res where k = 'col'),
  'limit 7: the same rows, table by table and in the same order, as one big page');
select is(pg_temp.dups('p7'), 0, 'limit 7: no row twice');
select ok(
  (select (v ->> 'max_page')::int <= 7 and (v ->> 'pages')::int >= (v ->> 'rows')::int / 7 from res where k = 'p7'),
  'limit 7: no page exceeds the limit and several pages were needed');

insert into res select 'p3', pg_temp.pull_all(tests.id('u_mgr_tz'), 3, null, 'aal2');
select is((select v -> 'ids' from res where k = 'p3'), (select v -> 'ids' from res where k = 'mgr'),
  'limit 3 across all tables (incl. restricted) for the manager: identical result');
select is(pg_temp.dups('p3'), 0, 'limit 3: no row twice');

select is(
  (select sum(jsonb_array_length(ch -> 'rows'))::int
   from jsonb_array_elements(pg_temp.pull(tests.id('u_col_pemba'), null, 0) -> 'changes') ch),
  1, 'p_limit below 1 is raised to 1');
select ok(
  (select coalesce(sum(jsonb_array_length(ch -> 'rows')), 0)::int <= 1000
   from jsonb_array_elements(pg_temp.pull(tests.id('u_hq'), null, 100000, 'aal2') -> 'changes') ch),
  'p_limit above 1000 is capped at 1000');

-- the cursor of a finished round
select is(
  (select array[(v #>> '{cursor,lo}')::bigint, (v #>> '{cursor,hi}')::bigint] from res where k = 'col'),
  array[pg_temp.base() + 101, null]::bigint[],
  'a finished round hands out lo = hi of the round and no upper bound');
select is(
  (select (pg_temp.pull(tests.id('u_col_pemba'), v -> 'cursor', 500) -> 'changes') from res where k = 'col'),
  '[]'::jsonb, 'nothing changed: the next round is empty');
select ok(
  (select (pg_temp.pull(tests.id('u_col_pemba'), v -> 'cursor', 500) ->> 'done')::boolean from res where k = 'col'),
  '... and done');
select ok(
  (select d.last_pull_at is not null from public.devices d
   where d.user_id = tests.id('u_col_pemba') and d.device_id = 'dev-pull'),
  'devices.last_pull_at is stamped when a round completes');

-- =============================================================================
-- 7. Incremental rounds, tombstones, paging across tables with limit 1
-- =============================================================================
do $$
begin
  perform pg_temp.clock(200);
  update public.projects set capacity = 101 where id = tests.id('p_pemba_2');
  update public.project_land set notes = 'changed' where id = tests.id('land:p_pemba_2');
  update public.project_maintenance set deleted_at = now() where id = tests.id('maint:p_pemba_1');
  update public.persons set graduated_from = 'Zanzibar' where id = tests.id('person:p_pemba_1');
  -- outside the collector's scope
  update public.projects set capacity = 102 where id = tests.id('p_tanga_1');
  update public.persons set graduated_from = 'Mombasa' where id = tests.id('person:p_ke_1');
  update public.staff_compensation set monthly_amount = 260000 where id = tests.id('comp:p_pemba_1');
end $$;

insert into res
select 'inc', pg_temp.pull_all(tests.id('u_col_pemba'), 1, (select v -> 'cursor' from res where k = 'col'));

select is((select v -> 'ids' from res where k = 'inc'),
  jsonb_build_object(
    'projects', jsonb_build_array(tests.id('p_pemba_2')),
    'project_land', jsonb_build_array(tests.id('land:p_pemba_2')),
    'project_maintenance', jsonb_build_array(tests.id('maint:p_pemba_1')),
    'persons', jsonb_build_array(tests.id('person:p_pemba_1'))),
  'incremental round: exactly the rows changed in scope since the last round, each once');
select is(
  (select array[(v ->> 'pages')::int, (v ->> 'max_page')::int, (v ->> 'rows')::int] from res where k = 'inc'),
  array[5, 1, 4], 'limit 1: one row per page, the cursor walks from table to table');

-- sync_pull asks the generated private.sync_changed_tables() which tables have
-- rows in the window. A function that is older than the registry must not hide
-- tables: it is detected and every table is queried instead.
create or replace function private.sync_changed_tables(p_lo bigint, p_hi bigint) returns text[]
language sql stable as $fn$ select array['#0']::text[] $fn$;
insert into res
select 'stale', pg_temp.pull_all(tests.id('u_col_pemba'), 500, (select v -> 'cursor' from res where k = 'col'));
select is((select v -> 'ids' from res where k = 'stale'), (select v -> 'ids' from res where k = 'inc'),
  'a stale sync_changed_tables() is detected: the round still returns every changed row');
do $$ begin perform private.sync_refresh(); end $$;

insert into res
select 'inc1', pg_temp.pull(tests.id('u_col_pemba'), (select v -> 'cursor' from res where k = 'col'), 500);
select ok(
  (select (x ->> 'deleted_at') is not null and (x ->> 'version')::int = 2
   from pg_temp.row_of((select v from res where k = 'inc1'), 'project_maintenance', tests.id('maint:p_pemba_1')) x),
  'a soft-deleted row arrives as a tombstone (deleted_at set)');
select is(
  (select (x ->> 'capacity')::int
   from pg_temp.row_of((select v from res where k = 'inc1'), 'projects', tests.id('p_pemba_2')) x),
  101, 'changed rows carry their new values');

insert into res
select 'incm', pg_temp.pull_all(tests.id('u_mgr_tz'), 500, (select v -> 'cursor' from res where k = 'mgr'), 'aal2');
select ok(
  pg_temp.t('incm', 'staff_compensation') = array[tests.id('comp:p_pemba_1')]
  and pg_temp.t('incm', 'projects') = tests.ids('p_pemba_2', 'p_tanga_1')
  and not (array[tests.id('person:p_ke_1')] && pg_temp.t('incm', 'persons')),
  'incremental round of the manager: restricted change included, other country excluded');

-- a device that starts from scratch does not need tombstones
insert into res select 'fresh', pg_temp.pull_all(tests.id('u_col_pemba'), 1000, null, 'aal1', 'dev-new');
select is(pg_temp.t('fresh', 'project_maintenance'), array[tests.id('maint:p_pemba_2')],
  'first pull of a new device: live rows only, no tombstones');

-- =============================================================================
-- 8. Rows of a transaction that is still open are never skipped
--
--   T300 commits a change to p_pemba_1
--   T301 changes p_pemba_2 and stays OPEN
--   T302 commits a change to maint:p_pemba_2 (after T301 started, before it ends)
--
-- While T301 runs, xmin = 301: the round stops below 301 and delivers only
-- T300's row, although T302 has already committed. A cursor based on "highest
-- value seen" (timestamp, sequence) would now stand at 302 and T301's row
-- would be lost for ever once it commits. The xmin cursor stays at 301, and the
-- next round (after T301 finished: xmin = 303) delivers both remaining rows.
-- =============================================================================
do $$
begin
  perform pg_temp.clock(300);
  update public.projects set capacity = 300 where id = tests.id('p_pemba_1');
  perform pg_temp.clock(301);
  update public.projects set capacity = 301 where id = tests.id('p_pemba_2');
  perform pg_temp.clock(302);
  update public.project_maintenance set priority = 'urgent' where id = tests.id('maint:p_pemba_2');
  -- oldest transaction still running: 301
  perform pg_temp.clock(302, 301);
end $$;

insert into res
select 'x1', pg_temp.pull_all(tests.id('u_col_pemba'), 500, (select v -> 'cursor' from res where k = 'inc'));

select is((select v -> 'ids' from res where k = 'x1'),
  jsonb_build_object('projects', jsonb_build_array(tests.id('p_pemba_1'))),
  'while transaction 301 is open only rows below it are delivered (302 waits although it committed)');
select is((select (v #>> '{cursor,lo}')::bigint from res where k = 'x1'), pg_temp.base() + 301,
  'the cursor does not advance past the oldest open transaction');

do $$ begin perform pg_temp.clock(302, 303); end $$;   -- 301 finished, nothing else is running

insert into res
select 'x2', pg_temp.pull_all(tests.id('u_col_pemba'), 500, (select v -> 'cursor' from res where k = 'x1'));

select is((select v -> 'ids' from res where k = 'x2'),
  jsonb_build_object(
    'projects', jsonb_build_array(tests.id('p_pemba_2')),
    'project_maintenance', jsonb_build_array(tests.id('maint:p_pemba_2'))),
  'after it finished, the next round delivers the delayed rows: nothing was skipped');

-- a row that changes again while a round is being paged is delivered by the next round
do $$
begin
  perform pg_temp.clock(400);
  update public.projects set capacity = 400 where id in (tests.id('p_pemba_1'), tests.id('p_pemba_2'));
  update public.project_photos set caption = 'a' where project_id = tests.id('p_pemba_1');
end $$;
insert into res
select 'y1', pg_temp.pull(tests.id('u_col_pemba'), (select v -> 'cursor' from res where k = 'x2'), 1);
do $$
begin
  -- between two pages of the same round another transaction rewrites a row that
  -- was not sent yet and one that was already sent
  perform pg_temp.clock(401, 401);
  update public.projects set capacity = 401 where id in (tests.id('p_pemba_1'), tests.id('p_pemba_2'));
  perform pg_temp.clock(401, 402);
end $$;
insert into res
select 'y2', pg_temp.pull_all(tests.id('u_col_pemba'), 1, (select v -> 'cursor' from res where k = 'y1'));
insert into res
select 'y3', pg_temp.pull_all(tests.id('u_col_pemba'), 500, (select v -> 'cursor' from res where k = 'y2'));

select is(pg_temp.t('y2', 'projects'), '{}'::uuid[],
  'rows rewritten during a round leave its window (they are not sent with a stale position)');
select is(pg_temp.t('y2', 'project_photos'), array[tests.id('photo:p_pemba_1')],
  '... the rest of the round is still delivered');
select is(pg_temp.t('y3', 'projects'), tests.ids('p_pemba_1', 'p_pemba_2'),
  '... and the rewritten rows arrive in the next round');

-- =============================================================================
-- 8b. Donors in incremental rounds
--
-- A donor becomes visible when somebody links it to a project of the caller.
-- The donor row itself is not written (its sync_xid is old): the link row is
-- the change signal, and the donor must arrive in the same round, before it.
-- =============================================================================
insert into res select 'dke0', pg_temp.pull_all(tests.id('u_col_ke'), 1000);
insert into res select 'dp20', pg_temp.pull_all(tests.id('u_col_pemba2'), 1000);
insert into res select 'dtg0', pg_temp.pull_all(tests.id('u_col_tanga'), 1000);
insert into res select 'dhq0', pg_temp.pull_all(tests.id('u_hq'), 1000, null, 'aal2');

do $$
begin
  perform pg_temp.clock(450);
  -- the Tanga donor is linked to the Kenyan project
  insert into public.project_donors (id, created_by, project_id, donor_id, year)
  values (pg_temp.lid(1), tests.id('u_col_ke'), tests.id('p_ke_1'), tests.id('donor:p_tanga_1'), 2021);
  -- a Pemba donor and the donor nobody linked yet are renamed
  update public.donors set name_latin = 'Renamed ' || name_latin
  where id in (tests.id('donor:p_pemba_1'), tests.id('donor_unlinked'));
end $$;

insert into res
select 'dke1', pg_temp.pull_all(tests.id('u_col_ke'), 1, (select v -> 'cursor' from res where k = 'dke0'));
select is((select v -> 'ids' from res where k = 'dke1'),
  jsonb_build_object('donors', jsonb_build_array(tests.id('donor:p_tanga_1')),
                     'project_donors', jsonb_build_array(pg_temp.lid(1))),
  'a donor linked to a project in scope arrives with the new link although the donor row did not change (and no other donor does)');
select is(
  (select array_agg(ch ->> 'table' order by ord)
   from jsonb_array_elements(
          pg_temp.pull(tests.id('u_col_ke'), (select v -> 'cursor' from res where k = 'dke0'), 500) -> 'changes')
        with ordinality as c(ch, ord)),
  array['donors', 'project_donors'], '... in the same response, the donor before the link that needs it');

insert into res
select 'dp21', pg_temp.pull_all(tests.id('u_col_pemba2'), 500, (select v -> 'cursor' from res where k = 'dp20'));
select is((select v -> 'ids' from res where k = 'dp21'),
  jsonb_build_object('donors', jsonb_build_array(tests.id('donor:p_pemba_1'))),
  'a renamed donor reaches the readers of its projects; the unlinked donor of a colleague stays invisible');

insert into res
select 'dcol1', pg_temp.pull_all(tests.id('u_col_pemba'), 1, (select v -> 'cursor' from res where k = 'y3'));
select is((select v -> 'ids' from res where k = 'dcol1'),
  jsonb_build_object('donors', to_jsonb(tests.ids('donor:p_pemba_1', 'donor_unlinked'))),
  'the creator of an unlinked donor receives its changes (paged by id, one row per page)');

insert into res
select 'dtg1', pg_temp.pull_all(tests.id('u_col_tanga'), 500, (select v -> 'cursor' from res where k = 'dtg0'));
select is((select v -> 'ids' from res where k = 'dtg1'), '{}'::jsonb,
  'a link added to a project outside the caller''s scope sends him nothing (neither the link nor his own donor again)');

insert into res
select 'dhq1', pg_temp.pull_all(tests.id('u_hq'), 500, (select v -> 'cursor' from res where k = 'dhq0'), 'aal2');
select ok(
  pg_temp.t('dhq1', 'donors') = tests.ids('donor:p_pemba_1', 'donor_unlinked')
  and pg_temp.t('dhq1', 'project_donors') = array[pg_temp.lid(1)],
  'a global reader already has every donor: only donors that really changed are sent');

-- a window that contains nothing but a link
do $$
begin
  perform pg_temp.clock(460);
  insert into public.project_donors (id, created_by, project_id, donor_id, year)
  values (pg_temp.lid(2), tests.id('u_col_pemba'), tests.id('p_pemba_1'), tests.id('donor:p_ke_1'), 2022);
end $$;

select is(private.sync_changed_tables(pg_temp.base() + 460, pg_temp.base() + 461),
  array['#22', 'donors', 'project_donors'],
  'sync_changed_tables(): a written link marks donors as changed too');

insert into res
select 'dp22', pg_temp.pull_all(tests.id('u_col_pemba2'), 500, (select v -> 'cursor' from res where k = 'dp21'));
select is((select v -> 'ids' from res where k = 'dp22'),
  jsonb_build_object('donors', jsonb_build_array(tests.id('donor:p_ke_1')),
                     'project_donors', jsonb_build_array(pg_temp.lid(2))),
  'a round whose window contains only the link still delivers the donor');

insert into res
select 'dke2', pg_temp.pull_all(tests.id('u_col_ke'), 500, (select v -> 'cursor' from res where k = 'dke1'));
select is((select v -> 'ids' from res where k = 'dke2'), '{}'::jsonb,
  'the Kenyan collector hears nothing about his donor being linked in Tanzania');

-- a soft-deleted donor arrives as a tombstone for those who had it
do $$
begin
  perform pg_temp.clock(470);
  update public.donors set deleted_at = now() where id = tests.id('donor:p_pemba_2');
end $$;
insert into res
select 'dp23', pg_temp.pull(tests.id('u_col_pemba2'), (select v -> 'cursor' from res where k = 'dp22'), 500);
select ok(
  (select (x ->> 'deleted_at') is not null
   from pg_temp.row_of((select v from res where k = 'dp23'), 'donors', tests.id('donor:p_pemba_2')) x),
  'a soft-deleted donor arrives as a tombstone');

-- after all of this a fresh device gets, again, exactly what RLS shows
insert into res select 'dfresh_ke', pg_temp.pull_all(tests.id('u_col_ke'), 2, null, 'aal1', 'dev-new');
insert into res select 'dfresh_p2', pg_temp.pull_all(tests.id('u_col_pemba2'), 2, null, 'aal1', 'dev-new');
select is(pg_temp.t('dfresh_ke', 'donors'), tests.ids('donor:p_ke_1', 'donor:p_tanga_1'),
  'first pull of a new device: the donor linked later is included');
select is(pg_temp.t('dfresh_p2', 'donors'), tests.ids('donor:p_pemba_1', 'donor:p_ke_1'),
  'first pull of a new device: linked donors without tombstones, small pages');
select ok(
  pg_temp.t('dfresh_ke', 'donors') = pg_temp.rls_donors(tests.id('u_col_ke'))
  and pg_temp.t('dfresh_p2', 'donors') = pg_temp.rls_donors(tests.id('u_col_pemba2'))
  and pg_temp.dups('dfresh_ke') = 0 and pg_temp.dups('dfresh_p2') = 0,
  '... which is again exactly the set RLS shows, every donor once');

-- A soft-deleted link. The RLS policy decides whether such a link still makes
-- the donor visible; sync_pull must send exactly what the policy shows.
do $$
begin
  perform pg_temp.clock(475);
  update public.project_donors set deleted_at = now() where id = pg_temp.lid(1);
end $$;
insert into res
select 'dke3', pg_temp.pull_all(tests.id('u_col_ke'), 500, (select v -> 'cursor' from res where k = 'dke2'));
insert into res select 'dfresh_ke2', pg_temp.pull_all(tests.id('u_col_ke'), 1000, null, 'aal1', 'dev-new');
select ok(
  pg_temp.t('dke3', 'project_donors') = array[pg_temp.lid(1)]
  and pg_temp.t('dfresh_ke2', 'donors') = pg_temp.rls_donors(tests.id('u_col_ke')),
  'a soft-deleted link arrives as a tombstone, and a fresh pull afterwards still sends exactly the donors RLS shows');

-- =============================================================================
-- 9. Cursor validation, scope changes, revoked sessions
-- =============================================================================
select throws_ok(
  format($q$select pg_temp.pull(%L::uuid, '{"lo": "abc"}'::jsonb, 10)$q$, tests.id('u_col_pemba')),
  'PT422', 'invalid_cursor', 'a malformed cursor is refused');
select throws_ok(
  format($q$select pg_temp.pull(%L::uuid, '[1, 2]'::jsonb, 10)$q$, tests.id('u_col_pemba')),
  'PT422', 'invalid_cursor', 'a cursor must be an object');

-- a cursor issued for another scope (here: the supervisor's) restarts from scratch
insert into res
select 'foreign', pg_temp.pull_all(tests.id('u_col_pemba'), 1000, (select v -> 'cursor' from res where k = 'sup'));
select ok((select (v ->> 'reset')::boolean from res where k = 'foreign'),
  'a cursor of another scope_epoch is discarded: reset = true');
select is(pg_temp.t('foreign', 'projects'), tests.ids('p_pemba_1', 'p_pemba_2'),
  '... and the pull starts again from the beginning');

-- a cursor from "the future" (another cluster after a restore) is discarded as well
insert into res
select 'future', pg_temp.pull(tests.id('u_col_pemba'),
  jsonb_build_object('lo', pg_temp.base() + 999999, 'hi', null,
                     'e', (select v ->> 'scope_epoch' from res where k = 'col')), 1000);
select ok((select (v ->> 'reset')::boolean from res where k = 'future'),
  'a cursor ahead of the server''s transaction clock is discarded: reset = true');

-- a new role changes the scope_epoch and the data set
insert into public.user_roles (user_id, role, scope_type, scope_id)
values (tests.id('u_col_pemba'), 'field_collector', 'branch', tests.id('br_tanga'));

insert into res
select 'wider', pg_temp.pull_all(tests.id('u_col_pemba'), 1000, (select v -> 'cursor' from res where k = 'y3'));
select isnt(
  (select v ->> 'scope_epoch' from res where k = 'wider'), (select v ->> 'scope_epoch' from res where k = 'col'),
  'granting a role changes scope_epoch');
select ok(
  (select (v ->> 'reset')::boolean from res where k = 'wider')
  and pg_temp.t('wider', 'projects') = tests.ids('p_pemba_1', 'p_pemba_2', 'p_tanga_1'),
  'the old cursor is reset and the wider scope (two branches) is pulled in full');
select is(pg_temp.t('wider', 'donors'), pg_temp.rls_donors(tests.id('u_col_pemba')),
  'two branch scopes: the donors of the full pull are again exactly the donors RLS shows');

do $$
begin
  perform pg_temp.clock(480);
  insert into public.project_donors (id, created_by, project_id, donor_id, year)
  values (pg_temp.lid(3), tests.id('u_col_tanga'), tests.id('p_tanga_1'), tests.id('donor:p_ke_1'), 2023);
end $$;
insert into res
select 'wider2', pg_temp.pull_all(tests.id('u_col_pemba'), 500, (select v -> 'cursor' from res where k = 'wider'));
select is((select v -> 'ids' from res where k = 'wider2'),
  jsonb_build_object('donors', jsonb_build_array(tests.id('donor:p_ke_1')),
                     'project_donors', jsonb_build_array(pg_temp.lid(3))),
  'two branch scopes, incremental round: the donor of a new link in the second branch arrives');

-- unknown user without any role: nothing but his own rows
insert into res select 'norole', pg_temp.pull_all(tests.create_user('norole@example.org', null, null, null), 1000);
select is((select v -> 'ids' from res where k = 'norole'), '{}'::jsonb, 'a user without roles receives nothing');

-- ... except, like under RLS, the donors he created himself (e.g. before his role was removed)
insert into public.donors (id, created_by, name_latin)
values (pg_temp.lid(9), tests._uuid('user:norole@example.org'), 'Donor of a user without role');
insert into res select 'norole2', pg_temp.pull_all(tests._uuid('user:norole@example.org'), 1000);
select ok(
  (select v -> 'ids' from res where k = 'norole2') = jsonb_build_object('donors', jsonb_build_array(pg_temp.lid(9)))
  and pg_temp.rls_donors(tests._uuid('user:norole@example.org')) = array[pg_temp.lid(9)],
  'a user without roles still gets the donors he created, exactly as RLS shows them');

-- sync epoch rotation = full resync for everybody
do $$ begin perform private.sync_rotate_epoch(); end $$;
insert into res
select 'rot', pg_temp.pull(tests.id('u_col_ke'), (select v -> 'cursor' from res where k = 'colke'), 1000);
select ok((select (v ->> 'reset')::boolean from res where k = 'rot'),
  'after private.sync_rotate_epoch() every old cursor is reset');

-- revoked device / session
update public.devices set revoked_at = now()
where user_id = tests.id('u_col_pemba') and device_id = 'dev-pull';
select throws_ok(
  format($q$select pg_temp.pull(%L::uuid, null, 10)$q$, tests.id('u_col_pemba')),
  'PT403', 'session_revoked', 'a revoked device cannot pull');

update public.profiles set active = false where id = tests.id('u_col_ke');
select throws_ok(
  format($q$select pg_temp.pull(%L::uuid, null, 10)$q$, tests.id('u_col_ke')),
  'PT403', 'session_revoked', 'a deactivated account cannot pull');

-- =============================================================================
-- 10. Maintenance: rebase after a logical restore
-- =============================================================================
insert into res
select 'before_rebase', jsonb_build_object('version', p.version, 'updated_at', p.updated_at)
from public.projects p where p.id = tests.id('p_tanga_1');
insert into res select 'tanga_before', pg_temp.pull(tests.id('u_col_tanga'), null, 10);

do $$
begin
  perform pg_temp.clock(500);
  perform set_config('t.rebase', private.sync_rebase()::text, true);
end $$;
select is(
  (select array[min(p.sync_xid), max(p.sync_xid)] from public.projects p),
  array[pg_temp.base() + 500, pg_temp.base() + 500],
  'sync_rebase() stamps every row with the current transaction id');
select is(
  (select jsonb_build_object('version', p.version, 'updated_at', p.updated_at)
   from public.projects p where p.id = tests.id('p_tanga_1')),
  (select v from res where k = 'before_rebase'),
  'sync_rebase() does not touch version / updated_at (triggers are bypassed)');
select isnt(
  (pg_temp.pull(tests.id('u_col_tanga'), null, 10) ->> 'scope_epoch'),
  (select v ->> 'scope_epoch' from res where k = 'tanga_before'),
  'sync_rebase() rotates the sync epoch (every client resyncs)');

select * from finish();
rollback;

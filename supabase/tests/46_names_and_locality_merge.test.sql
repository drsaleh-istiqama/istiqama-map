-- =============================================================================
-- 46  user_display_names / merge_localities / revert_locality_merge
--     (migration 0071; docs/contracts/people-admin.md §10, §11)
--
-- Users of the fixture: u_col_pemba entered p_pemba_1 / p_pemba_2, u_col_tanga
-- p_tanga_1, u_col_ke p_ke_1. Localities (ids ...f0NN): f001 Pemba village,
-- f002 its duplicate (proposed), f003 another Pemba village, f004 Kenya.
-- =============================================================================
begin;
set local search_path = public, extensions, tests;

select plan(31);

select tests.fixture();

-- a conflict raised by u_col_pemba2 on a Pemba project, resolved by u_sup_pemba
insert into public.sync_conflicts
  (id, table_name, row_id, project_id, field, base_version, server_value, client_value,
   client_user_id, client_device_id, state, resolved_by, resolved_at)
values
  ('00000000-0000-4000-8000-00000000a001', 'projects', tests.id('p_pemba_1'), tests.id('p_pemba_1'), 'capacity', 1,
   '100'::jsonb, '120'::jsonb, tests.id('u_col_pemba2'), 'dev-x', 'resolved_server', tests.id('u_sup_pemba'), now()),
  -- a conflict on a restricted Pemba row (its author is otherwise unknown in
  -- Tanzania): named to restricted readers of the country only
  ('00000000-0000-4000-8000-00000000a002', 'staff_compensation', tests.id('comp:p_pemba_1'), tests.id('p_pemba_1'),
   'monthly_amount', 1, '1'::jsonb, '2'::jsonb, tests.id('u_col_ke'), 'dev-y', 'open', null, null);

create function pg_temp.names(p_user uuid, p_aal text, p_ids uuid[]) returns text[]
language plpgsql as
$fn$
declare
  r text[];
begin
  perform tests.login_as(p_user, p_aal);
  select coalesce(array_agg(e.value ->> 'id' order by e.value ->> 'id'), '{}'::text[]) into r
  from jsonb_array_elements(public.user_display_names(p_ids)) e;
  perform tests.logout();
  return r;
end;
$fn$;

create function pg_temp.sorted(variadic p_keys text[]) returns text[]
language sql stable as
$fn$ select coalesce(array_agg(tests.id(k)::text order by tests.id(k)::text), '{}'::text[]) from unnest(p_keys) k $fn$;

-- ---------------------------------------------------------------------------
-- user_display_names
-- ---------------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.user_display_names(uuid[])', 'execute')
  and has_function_privilege('authenticated', 'public.user_display_names(uuid[])', 'execute')
  and not has_function_privilege('authenticated', 'private.conflict_visible_to(private.sync_ctx, text, uuid, uuid)', 'execute'),
  'user_display_names: authenticated only; the visibility helper is internal');

select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select is(
  (select array_agg(k order by k) from (
     select jsonb_object_keys(e.value) as k
     from jsonb_array_elements(public.user_display_names(array[tests.id('u_col_pemba')])) e) x),
  array['full_name', 'id'],
  'user_display_names: rows carry exactly id and full_name');
select tests.logout();

select is(
  pg_temp.names(tests.id('u_col_pemba'), 'aal1',
                array[tests.id('u_col_pemba'), tests.id('u_col_tanga'), tests.id('u_col_ke'), tests.id('u_col_pemba2'),
                      tests.id('u_hq'), '00000000-0000-4000-8000-0000000000ff'::uuid]),
  pg_temp.sorted('u_col_pemba'),
  'a collector names himself (and the creators of projects of his branch) only: other branches, countries, unknown ids are left out');

select is(
  pg_temp.names(tests.id('u_sup_pemba'), 'aal1',
                array[tests.id('u_col_pemba'), tests.id('u_col_pemba2'), tests.id('u_col_tanga'), tests.id('u_sup_pemba')]),
  pg_temp.sorted('u_col_pemba', 'u_col_pemba2', 'u_sup_pemba'),
  'a supervisor names who entered his branch''s projects and who raised conflicts there, not Tanga''s collector');

select is(
  pg_temp.names(tests.id('u_col_pemba2'), 'aal1', array[tests.id('u_col_pemba'), tests.id('u_sup_pemba')]),
  pg_temp.sorted('u_col_pemba'),
  'conflict authors / resolvers are named to reviewers only (a collector does not get the supervisor''s name)');

select is(
  pg_temp.names(tests.id('u_mgr_tz'), 'aal2',
                array[tests.id('u_col_pemba'), tests.id('u_col_tanga'), tests.id('u_viewer_tz'), tests.id('u_mgr_ke')]),
  pg_temp.sorted('u_col_pemba', 'u_col_tanga', 'u_viewer_tz'),
  'a country manager (aal2) names the users with roles in his country, never Kenya''s');

select is(
  pg_temp.names(tests.id('u_mgr_tz'), 'aal1', array[tests.id('u_col_pemba'), tests.id('u_mgr_tz')]),
  pg_temp.sorted('u_mgr_tz'),
  'a country manager without MFA has no effective role: own name only');

select is(
  pg_temp.names(tests.id('u_viewer_global'), 'aal1',
                array[tests.id('u_col_pemba'), tests.id('u_hq'), tests.id('u_viewer_global')]),
  pg_temp.sorted('u_viewer_global'),
  'a viewer gets no names but his own (names are people data, brief §3)');

select is(
  pg_temp.names(tests.id('u_hq'), 'aal2', array[tests.id('u_col_ke'), tests.id('u_viewer_global'), tests.id('u_mgr_tz')]),
  pg_temp.sorted('u_col_ke', 'u_mgr_tz', 'u_viewer_global'),
  'hq_admin (aal2) names everybody');

-- the author of a conflict on a restricted row (u_col_ke, conflict a002 on a
-- Pemba salary): the TZ manager (restricted reader) gets the name, the Pemba
-- supervisor (reviewer without restricted access) does not
select ok(
  pg_temp.names(tests.id('u_mgr_tz'), 'aal2', array[tests.id('u_col_ke')]) = pg_temp.sorted('u_col_ke')
  and pg_temp.names(tests.id('u_sup_pemba'), 'aal1', array[tests.id('u_col_ke')]) = '{}'::text[],
  'the author of a restricted conflict is named to a restricted reader of the country only');

select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select throws_ok(
  $$ select public.user_display_names(array(select gen_random_uuid() from generate_series(1, 201))) $$,
  'PT422', 'too_many_ids', 'more than 200 ids: PT422 too_many_ids');
select is(public.user_display_names(null), '[]'::jsonb, 'null or empty input: empty array');
select tests.logout();

select tests.login_anon();
select throws_ok($$ select public.user_display_names(array[gen_random_uuid()]) $$, '42501', null,
  'anon cannot call user_display_names');
select tests.logout();

-- ---------------------------------------------------------------------------
-- merge_localities / revert_locality_merge
-- ---------------------------------------------------------------------------
insert into public.localities (id, created_by, country_id, admin_area_id, name_ar, name_latin, geom, status)
values
  ('00000000-0000-4000-8000-00000000f001', tests.id('u_col_pemba'), tests.id('tz'), tests.id('tz_pemba_north'),
   'قرية الأصل', 'Kijiji Asili', st_setsrid(st_makepoint(39.74, -5.00), 4326), 'approved'),
  ('00000000-0000-4000-8000-00000000f002', tests.id('u_col_pemba'), tests.id('tz'), tests.id('tz_pemba_north'),
   'قريه الاصل', 'Kijiji Asli', st_setsrid(st_makepoint(39.741, -5.001), 4326), 'proposed'),
  ('00000000-0000-4000-8000-00000000f003', tests.id('u_col_pemba'), tests.id('tz'), tests.id('tz_pemba_north'),
   'قرية أخرى', 'Kijiji Kingine', st_setsrid(st_makepoint(39.70, -4.95), 4326), 'approved'),
  ('00000000-0000-4000-8000-00000000f004', tests.id('u_col_ke'), tests.id('ke'), tests.id('ke_mombasa'),
   'قرية كينية', 'Kijiji Kenya', st_setsrid(st_makepoint(39.65, -4.00), 4326), 'approved');

update public.projects set locality_id = '00000000-0000-4000-8000-00000000f002'
where id in (tests.id('p_pemba_1'), tests.id('p_pemba_2'));

create temp table t46 (k text primary key, v jsonb) on commit drop;
grant all on t46 to authenticated;

select ok(
  not has_function_privilege('anon', 'public.merge_localities(uuid, uuid)', 'execute')
  and not has_function_privilege('anon', 'public.revert_locality_merge(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.merge_localities(uuid, uuid)', 'execute'),
  'merge_localities / revert_locality_merge: authenticated only');

select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select throws_ok(
  $$ select public.merge_localities('00000000-0000-4000-8000-00000000f002', '00000000-0000-4000-8000-00000000f001') $$,
  'PT403', 'forbidden', 'a field collector cannot merge localities');
select tests.login_as(tests.id('u_viewer_tz'), 'aal1');
select throws_ok(
  $$ select public.merge_localities('00000000-0000-4000-8000-00000000f002', '00000000-0000-4000-8000-00000000f001') $$,
  'PT403', 'forbidden', 'a viewer cannot merge localities');
select tests.login_as(tests.id('u_mgr_ke'), 'aal2');
select throws_ok(
  $$ select public.merge_localities('00000000-0000-4000-8000-00000000f002', '00000000-0000-4000-8000-00000000f001') $$,
  'PT404', 'locality_not_found', 'the Kenya manager: a Tanzanian locality is answered like a missing one');
select tests.login_as(tests.id('u_sup_pemba'), 'aal1');
select throws_ok(
  $$ select public.merge_localities('00000000-0000-4000-8000-00000000f002', '00000000-0000-4000-8000-00000000f002') $$,
  'PT422', 'invalid_argument', 'a locality cannot be merged into itself');
select throws_ok(
  $$ select public.merge_localities('00000000-0000-4000-8000-00000000f002', '00000000-0000-4000-8000-00000000f004') $$,
  'PT404', 'locality_not_found', 'a target in a country outside the caller''s scope is answered like a missing one');
select tests.logout();

select tests.login_as(tests.id('u_hq'), 'aal2');
select throws_ok(
  $$ select public.merge_localities('00000000-0000-4000-8000-00000000f002', '00000000-0000-4000-8000-00000000f004') $$,
  'PT422', 'locality_country_mismatch', 'both localities must be of the same country');
select tests.logout();

-- the branch supervisor reviews localities of his branch's country
select tests.login_as(tests.id('u_sup_pemba'), 'aal1');
insert into t46 select 'm1', public.merge_localities(
  '00000000-0000-4000-8000-00000000f002', '00000000-0000-4000-8000-00000000f001');
select tests.logout();

select is(
  (select v - 'merge_id' from t46 where k = 'm1'),
  jsonb_build_object('source_id', '00000000-0000-4000-8000-00000000f002', 'target_id', '00000000-0000-4000-8000-00000000f001',
                     'projects_moved', 2, 'source_deleted', true),
  'merge_localities: counts in the answer');
select ok(
  (select bool_and(p.locality_id = '00000000-0000-4000-8000-00000000f001')
   from public.projects p where p.id in (tests.id('p_pemba_1'), tests.id('p_pemba_2')))
  and (select l.deleted_at is not null from public.localities l where l.id = '00000000-0000-4000-8000-00000000f002')
  and (select p.search_norm like '%' || private.norm('Kijiji Asili') || '%' from public.projects p where p.id = tests.id('p_pemba_1')),
  'merge_localities: projects re-pointed (search text follows), the duplicate soft-deleted');
select ok(
  (select a.changed_fields @> array['locality_id'] and a.user_id = tests.id('u_sup_pemba')
   from public.audit_log a
   where a.table_name = 'projects' and a.row_id = tests.id('p_pemba_1')
   order by a.row_version desc limit 1),
  'merge_localities: the re-pointing is an ordinary audited update (devices get it through pull)');
select is(
  (select row(lm.source_id, lm.target_id, lm.project_ids, lm.merged_by, lm.reverted_at)::text
   from private.locality_merges lm where lm.id = (select (v ->> 'merge_id')::uuid from t46 where k = 'm1')),
  row('00000000-0000-4000-8000-00000000f002'::uuid, '00000000-0000-4000-8000-00000000f001'::uuid,
      tests.ids('p_pemba_1', 'p_pemba_2'), tests.id('u_sup_pemba'), null::timestamptz)::text,
  'merge_localities: the undo record keeps the moved projects');

select tests.login_as(tests.id('u_sup_pemba'), 'aal1');
select throws_ok(
  $$ select public.merge_localities('00000000-0000-4000-8000-00000000f002', '00000000-0000-4000-8000-00000000f003') $$,
  'PT404', 'locality_not_found', 'a merged (deleted) locality cannot be merged again');
select tests.logout();

-- a project entered offline with the merged locality (pushed after the merge)
-- is pointed at the surviving one
select tests.login_as(tests.id('u_col_pemba'), 'aal1', 'dev-46');
insert into t46 select 'push', public.sync_push(jsonb_build_array(jsonb_build_object(
  'op_id', '00000000-0000-7000-8000-00000000c046', 'table', 'projects',
  'id', '00000000-0000-4000-8000-00000000c047', 'kind', 'upsert', 'base_version', 0,
  'fields', jsonb_build_object('name_ar', 'مسجد القرية المدمجة', 'type', 'mosque', 'status', 'active',
                               'lon', 39.7405, 'lat', -5.0005,
                               'locality_id', '00000000-0000-4000-8000-00000000f002'))), 'dev-46');
select tests.logout();
select ok(
  (select v #>> '{results,0,status}' from t46 where k = 'push') = 'applied'
  and (select p.locality_id from public.projects p where p.id = '00000000-0000-4000-8000-00000000c047')
      = '00000000-0000-4000-8000-00000000f001',
  'sync_push: a project naming the merged locality is stored with the surviving one');

-- a project re-pointed by hand after the merge keeps its newer value on revert
update public.projects set locality_id = '00000000-0000-4000-8000-00000000f003' where id = tests.id('p_pemba_2');

select tests.login_as(tests.id('u_mgr_ke'), 'aal2');
select throws_ok(
  format('select public.revert_locality_merge(%L)', (select (v ->> 'merge_id') from t46 where k = 'm1')),
  'PT404', 'locality_merge_not_found', 'revert: outside the review scope the merge does not exist');
select tests.login_as(tests.id('u_mgr_tz'), 'aal2');
insert into t46 select 'r1', public.revert_locality_merge((select (v ->> 'merge_id')::uuid from t46 where k = 'm1'));
select throws_ok(
  format('select public.revert_locality_merge(%L)', (select (v ->> 'merge_id') from t46 where k = 'm1')),
  'PT409', 'merge_not_revertible', 'revert: a merge is undone once');
select tests.logout();

select is((select (v ->> 'projects_restored')::int from t46 where k = 'r1'), 1,
  'revert: only the projects that still name the target go back');
select ok(
  (select l.deleted_at is null from public.localities l where l.id = '00000000-0000-4000-8000-00000000f002')
  and (select p.locality_id from public.projects p where p.id = tests.id('p_pemba_1')) = '00000000-0000-4000-8000-00000000f002'
  and (select p.locality_id from public.projects p where p.id = tests.id('p_pemba_2')) = '00000000-0000-4000-8000-00000000f003',
  'revert: the source is live again with its project; the hand-edited project keeps its newer locality');

select ok(
  exists (select 1 from pg_indexes i
          where i.schemaname = 'public' and i.tablename = 'localities'
            and i.indexdef ilike '%(country_id, status)%'),
  'localities has an index on (country_id, status)');

select * from finish();
rollback;

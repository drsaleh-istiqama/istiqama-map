-- =============================================================================
-- 54  Unit 5 follow-ups (migration 20261003007300)
--     A. export "all fields": staff sheet (export_staff_rows), new project columns,
--        dictionaries in three languages, filters.dataset
--     B. last-hq_admin guard on the direct UPDATE path takes the guard lock
--        (the two-session race itself: supabase/tests/concurrency/hq_admin_race.sh)
--     C. projects.migration_note: the v2 migration flag survives sync_push
-- =============================================================================
begin;
set local search_path = public, extensions, tests;

select plan(47);

select tests.fixture_extra();

insert into public.fx_rates (currency, usd_per_unit, effective_date)
values ('TZS', 0.0004, current_date)
on conflict (currency, effective_date) do update set usd_per_unit = excluded.usd_per_unit;

-- Extra rows: a closed maintenance entry, a review stamp, a migration note, a home area,
-- an ended assignment (not exported) and one ending in the future (exported).
insert into public.project_maintenance (id, project_id, reported_on, description, priority, state, resolved_on)
values (tests._uuid('u5:maint_done'), tests.id('p_pemba_1'), date '2024-03-01', 'Old leak', 'low', 'done', date '2024-04-01'),
       (tests._uuid('u5:maint_cancel'), tests.id('p_pemba_1'), date '2024-05-01', 'Duplicate', 'low', 'cancelled', null);
update public.projects
   set reviewed_by = tests.id('u_sup_pemba'), reviewed_at = timestamptz '2026-01-02 03:04:05+00',
       migration_note = 'check salary currency (TZS)'
 where id = tests.id('p_pemba_1');
update public.persons
   set home_admin_area_id = tests.id('tz_pemba_north'), education_level = 'Diploma', graduated_from = 'Zanzibar',
       birth_date = date '1980-05-06', home_area_text = 'Chake'
 where id = tests.id('person:p_pemba_1');
insert into public.persons (id, name_ar, name_latin, phone_e164, country_id, branch_id)
values (tests._uuid('u5:ended'), 'منتهي', 'Ended Teacher', '+255711000101', tests.id('tz'), tests.id('br_pemba')),
       (tests._uuid('u5:future'), 'مستمر', 'Future Teacher', '+255711000102', tests.id('tz'), tests.id('br_pemba'));
insert into public.project_staff (id, project_id, person_id, role, start_date, end_date)
values (tests._uuid('u5:staff_ended'), tests.id('p_pemba_1'), tests._uuid('u5:ended'), 'teacher', date '2019-01-01', current_date - 1),
       (tests._uuid('u5:staff_future'), tests.id('p_pemba_1'), tests._uuid('u5:future'), 'teacher', date '2019-01-01', current_date + 30);

-- =============================================================================
-- A. Export
-- =============================================================================
select tests.login_anon();
select throws_ok($$select public.export_staff_rows(gen_random_uuid(), null, 10)$$, '42501', null,
                 'anon cannot call export_staff_rows()');
select tests.logout();

-- Dictionaries ------------------------------------------------------------------------------------
select tests.login_as(tests.id('u_mgr_tz'));
select set_config('t.cols_ar', public.export_columns('ar')::text, true);
select set_config('t.cols_sw', public.export_columns('sw')::text, true);
select set_config('t.cols_en', public.export_columns('en')::text, true);
select is(jsonb_build_array(
            jsonb_path_query_first(current_setting('t.cols_ar')::jsonb, '$.staff_columns[*] ? (@.key == "role")') ->> 'header',
            jsonb_path_query_first(current_setting('t.cols_sw')::jsonb, '$.staff_columns[*] ? (@.key == "role")') ->> 'header',
            jsonb_path_query_first(current_setting('t.cols_en')::jsonb, '$.staff_columns[*] ? (@.key == "role")') ->> 'header'),
          '["الدور", "Wadhifa", "Role"]'::jsonb, 'staff sheet headers in ar / sw / en');
select is(jsonb_build_array(current_setting('t.cols_ar')::jsonb #>> '{enums,gender,male}',
                            current_setting('t.cols_sw')::jsonb #>> '{enums,gender,female}',
                            current_setting('t.cols_en')::jsonb #>> '{enums,gender,female}'),
          '["ذكر", "Mwanamke", "Female"]'::jsonb, 'gender labels in three languages');
select ok(jsonb_path_exists(current_setting('t.cols_ar')::jsonb, '$.staff_columns[*] ? (@.key == "salary_amount")')
          and jsonb_path_exists(current_setting('t.cols_ar')::jsonb, '$.staff_columns[*] ? (@.key == "salary_usd")')
          and jsonb_path_exists(current_setting('t.cols_ar')::jsonb, '$.staff_columns[*] ? (@.key == "phone")'),
          'manager: staff sheet with phone and salary columns');
select is(jsonb_path_query_first(current_setting('t.cols_ar')::jsonb, '$.staff_columns[*] ? (@.key == "gender")') ->> 'enum',
          'gender', 'staff column gender is translated through enums.gender');
select ok(jsonb_path_exists(current_setting('t.cols_en')::jsonb, '$.columns[*] ? (@.key == "maintenance_closed")')
          and jsonb_path_exists(current_setting('t.cols_en')::jsonb, '$.columns[*] ? (@.key == "reviewed_at")')
          and jsonb_path_exists(current_setting('t.cols_en')::jsonb, '$.columns[*] ? (@.key == "reviewed_by")')
          and jsonb_path_exists(current_setting('t.cols_en')::jsonb, '$.columns[*] ? (@.key == "migration_note")'),
          'projects sheet: closed maintenance count, reviewer, review date, migration note');
select is((current_setting('t.cols_en')::jsonb #>> '{capabilities,staff}')::boolean, true, 'manager: staff capability');
select tests.logout();
select is((select count(*)::int from (
             select d.key from private.export_staff_column_defs d
             where btrim(d.ar) = '' or btrim(d.sw) = '' or btrim(d.en) = '') s), 0,
          'every staff column has three non-empty headers');

select tests.login_as(tests.id('u_col_ke'), 'aal1');
select ok(jsonb_path_exists(public.export_columns('sw'), '$.staff_columns[*] ? (@.key == "person_name_ar")')
          and not jsonb_path_exists(public.export_columns('sw'), '$.staff_columns[*] ? (@.key like_regex "^salary_")'),
          'collector: staff sheet without salary columns');
select tests.logout();

select tests.login_as(tests.id('u_viewer_tz'), 'aal1');
select is(public.export_columns('en') -> 'staff_columns', '[]'::jsonb, 'viewer: no staff sheet');
select ok(not jsonb_path_exists(public.export_columns('en'), '$.columns[*] ? (@.key == "reviewed_by")')
          and jsonb_path_exists(public.export_columns('en'), '$.columns[*] ? (@.key == "maintenance_closed")'),
          'viewer: no reviewer name (people column), closed maintenance count yes');
select throws_ok($$select public.export_request('csv', 'en', '{"dataset": "staff"}'::jsonb)$$, 'PT403', null,
                 'viewer: a staff export is refused');
select set_config('t.job_v', public.export_request('xlsx', 'en', '{}'::jsonb) ->> 'id', true);
select is(public.export_staff_rows(current_setting('t.job_v')::uuid, null, 100),
          jsonb_build_object('job_id', current_setting('t.job_v')::uuid, 'rows', '[]'::jsonb, 'count', 0, 'next', null, 'done', true),
          'viewer: export_staff_rows returns nothing');
select tests.logout();

-- Manager: staff rows with person fields and salary ---------------------------------------------------
select tests.login_as(tests.id('u_mgr_tz'));
select throws_ok($$select public.export_request('csv', 'en', '{"dataset": "people"}'::jsonb)$$, 'PT422', null,
                 'unknown dataset is rejected');
select throws_ok($$select public.export_request('csv', 'en', '{"dataset": 1}'::jsonb)$$, 'PT422', null,
                 'dataset must be a string');
select set_config('t.job_m', public.export_request('csv', 'en', '{"dataset": "staff"}'::jsonb) ->> 'id', true);
select set_config('t.srows', public.export_staff_rows(current_setting('t.job_m')::uuid, null, 1000)::text, true);
select ok((current_setting('t.srows')::jsonb ->> 'done')::boolean, 'manager staff export: one page');
select set_config('t.imam', jsonb_path_query_first(current_setting('t.srows')::jsonb, '$.rows[*] ? (@.staff_id == $id)',
                                                   jsonb_build_object('id', tests.id('staff:p_pemba_1')))::text, true);
select is(current_setting('t.imam')::jsonb - 'project_id' - 'person_id' - 'staff_id' - 'project_name' - 'branch' - 'country',
          jsonb_build_object(
            'project_code', (select code from public.projects where id = tests.id('p_pemba_1')),
            'person_name_ar', 'إمام p_pemba_1', 'person_name_latin', 'Imam p_pemba_1',
            'role', 'imam', 'start_date', '2020-01-01', 'end_date', null,
            'gender', 'male', 'birth_year', 1980, 'birth_date', '1980-05-06',
            'education_level', 'Diploma', 'graduated_from', 'Zanzibar',
            'home_area_level1', (select coalesce(name_en, name_sw, name_ar) from public.admin_areas where id = tests.id('tz_pemba_north')),
            'home_area_level2', null, 'home_area_level3', null, 'home_area_text', 'Chake',
            'phone', '+255700000001',
            'salary_amount', 250000, 'salary_currency', 'TZS', 'salary_effective_from', '2024-01-01',
            'salary_usd', 100),
          'manager staff export: every person field, role, dates and the current salary with USD');
select is(current_setting('t.imam')::jsonb ->> 'person_id', tests.id('person:p_pemba_1')::text,
          'manager staff export: person id for re-import');
select ok(not jsonb_path_exists(current_setting('t.srows')::jsonb, '$.rows[*] ? (@.project_id == $id)',
            jsonb_build_object('id', tests.id('p_ke_1'))),
          'Tanzania manager staff export: no Kenya assignments');
select ok(not jsonb_path_exists(current_setting('t.srows')::jsonb, '$.rows[*] ? (@.staff_id == $id)',
            jsonb_build_object('id', tests._uuid('u5:staff_ended')))
          and jsonb_path_exists(current_setting('t.srows')::jsonb, '$.rows[*] ? (@.staff_id == $id)',
            jsonb_build_object('id', tests._uuid('u5:staff_future'))),
          'current assignments only: an ended one is left out, one ending in the future is kept');
select is((current_setting('t.srows')::jsonb ->> 'count')::int,
          (select count(*)::int from public.project_staff s
             join public.projects p on p.id = s.project_id and p.deleted_at is null and p.country_id = tests.id('tz')
             join public.persons pe on pe.id = s.person_id and pe.deleted_at is null
            where s.deleted_at is null and (s.end_date is null or s.end_date >= current_date)),
          'manager staff export: one row per current assignment in Tanzania');

-- keyset paging with one row per page visits every assignment once
create temp table u5_pages (n int, page jsonb) on commit drop;
do $$
declare
  v_after jsonb := null;
  v_page jsonb;
  i int := 0;
begin
  loop
    i := i + 1;
    v_page := public.export_staff_rows(current_setting('t.job_m')::uuid, v_after, 1);
    insert into u5_pages values (i, v_page);
    exit when (v_page ->> 'done')::boolean or i > 50;
    v_after := v_page -> 'next';
  end loop;
end $$;
select is((select array_agg(r ->> 'staff_id' order by r ->> 'staff_id')
             from u5_pages, jsonb_array_elements(page -> 'rows') r),
          (select array_agg(r ->> 'staff_id' order by r ->> 'staff_id')
             from jsonb_array_elements(current_setting('t.srows')::jsonb -> 'rows') r),
          'keyset paging (limit 1): every assignment exactly once');
select ok((select bool_and(jsonb_array_length(page -> 'rows') <= 1) from u5_pages)
          and (select count(*) from u5_pages) > 1,
          'keyset paging (limit 1): pages respect the limit');

-- projects sheet: new columns
select set_config('t.job_p', public.export_request('xlsx', 'en', jsonb_build_object('ids', jsonb_build_array(tests.id('p_pemba_1')))) ->> 'id', true);
select set_config('t.prow', (public.export_rows(current_setting('t.job_p')::uuid, null, 10) #> '{rows,0}')::text, true);
select is(jsonb_build_object(
            'closed', current_setting('t.prow')::jsonb -> 'maintenance_closed',
            'open', current_setting('t.prow')::jsonb -> 'maintenance_open',
            'by', current_setting('t.prow')::jsonb -> 'reviewed_by',
            'note', current_setting('t.prow')::jsonb -> 'migration_note',
            'at', (current_setting('t.prow')::jsonb ->> 'reviewed_at')::timestamptz = timestamptz '2026-01-02 03:04:05+00'),
          jsonb_build_object('closed', 2, 'open', 1, 'by', 'u_sup_pemba', 'note', 'check salary currency (TZS)', 'at', true),
          'projects sheet: closed maintenance history, reviewer and review date, migration note');
-- the staff sheet of a filtered job follows the job filters
select is((select array_agg(distinct r ->> 'project_id')
             from jsonb_array_elements(public.export_staff_rows(current_setting('t.job_p')::uuid, null, 100) -> 'rows') r),
          array[tests.id('p_pemba_1')::text], 'staff sheet follows the job filters (ids)');
select tests.logout();

select ok((select count(*) from public.restricted_access_log l
            where l.user_id = tests.id('u_mgr_tz') and l.context = 'export:' || current_setting('t.job_m')
              and l.table_name = 'staff_compensation' and tests.id('comp:p_pemba_1') = any (l.row_ids)) >= 1,
          'salaries in the staff sheet are written to restricted_access_log');

-- Collector (Kenya): own assignments, no salary keys, nothing logged ---------------------------------
select tests.login_as(tests.id('u_col_ke'), 'aal1');
select set_config('t.job_k', public.export_request('xlsx', 'sw', '{}'::jsonb) ->> 'id', true);
select set_config('t.krows', public.export_staff_rows(current_setting('t.job_k')::uuid, null, 1000)::text, true);
select ok(jsonb_path_exists(current_setting('t.krows')::jsonb, '$.rows[*] ? (@.staff_id == $id)',
            jsonb_build_object('id', tests.id('staff:p_ke_1')))
          and not jsonb_path_exists(current_setting('t.krows')::jsonb, '$.rows[*] ? (@.project_id == $id)',
            jsonb_build_object('id', tests.id('p_pemba_1'))),
          'Kenya collector staff export: own branch only');
select ok(not exists (select 1 from jsonb_array_elements(current_setting('t.krows')::jsonb -> 'rows') r
                       where r ? 'salary_amount' or r ? 'salary_currency' or r ? 'salary_usd' or r ? 'salary_effective_from'),
          'Kenya collector staff export: salary columns are omitted, not null-filled');
select is(jsonb_path_query_first(current_setting('t.krows')::jsonb, '$.rows[*] ? (@.staff_id == $id)',
            jsonb_build_object('id', tests.id('staff:p_ke_1'))) ->> 'project_name',
          'Test project p_ke_1', 'sw job: Latin project name first');
select throws_ok(format('select public.export_staff_rows(%L, null, 10)', current_setting('t.job_m')), 'PT404', null,
                 'a job of another user cannot be read');
select tests.logout();
select is((select count(*)::int from public.restricted_access_log l
            where l.context = 'export:' || current_setting('t.job_k')), 0,
          'collector staff export: nothing restricted, nothing logged');

-- Moved project: person outside the people scope -> "?", masked phone, no person fields ------------
update public.projects set branch_id = tests.id('br_tanga') where id = tests.id('p_pemba_2');
select tests.login_as(tests.id('u_col_tanga'), 'aal1');
select set_config('t.job_t', public.export_request('csv', 'en',
         jsonb_build_object('dataset', 'staff', 'ids', jsonb_build_array(tests.id('p_pemba_2')))) ->> 'id', true);
select set_config('t.trow', jsonb_path_query_first(public.export_staff_rows(current_setting('t.job_t')::uuid, null, 10),
         '$.rows[*] ? (@.staff_id == $id)', jsonb_build_object('id', tests.id('staff:p_pemba_2')))::text, true);
select tests.logout();
select is(jsonb_build_object(
            'n', current_setting('t.trow')::jsonb -> 'person_name_ar',
            'l', current_setting('t.trow')::jsonb -> 'person_name_latin',
            'g', current_setting('t.trow')::jsonb -> 'gender',
            'y', current_setting('t.trow')::jsonb -> 'birth_year',
            'id', current_setting('t.trow')::jsonb -> 'person_id',
            'role', current_setting('t.trow')::jsonb -> 'role'),
          '{"n": "?", "l": null, "g": null, "y": null, "id": null, "role": "imam"}'::jsonb,
          'moved project: a person outside the people scope keeps only the role');
select is(current_setting('t.trow')::jsonb ->> 'phone', private.mask_phone('+255700000002'),
          'moved project: the phone of a person outside the people scope is masked');

-- Job states ---------------------------------------------------------------------------------------
select lives_ok(format('select public.export_finish(%L, %L, %L, 1, null)', current_setting('t.job_k'), 'done',
                       tests.id('u_col_ke')::text || '/x.xlsx'), 'finish the collector job');
select tests.login_as(tests.id('u_col_ke'), 'aal1');
select throws_ok(format('select public.export_staff_rows(%L, null, 10)', current_setting('t.job_k')), 'PT409', null,
                 'export_staff_rows: a finished job yields no more rows');
select tests.logout();

-- =============================================================================
-- B. Last-hq_admin guard: the direct UPDATE path takes the guard lock
-- =============================================================================
select is((select count(*)::int from pg_trigger t
            where t.tgname = 't84_lock_hq_admins' and not t.tgisinternal
              and t.tgrelid in ('public.user_roles'::regclass, 'public.profiles'::regclass)
              and (t.tgtype & 1) = 0      -- statement level
              and (t.tgtype & 2) = 2),    -- before
          2, 'BEFORE UPDATE statement triggers t84_lock_hq_admins on user_roles and profiles');
select ok(pg_get_functiondef('private.tg_keep_hq_admin()'::regprocedure) ~ 'perform private\.lock_hq_admins\(\)',
          'the AFTER ROW guard takes private.lock_hq_admins() before checking');

select (hashtextextended('istiqama:last_hq_admin', 0) >> 32)::int::oid as lk_class,
       (hashtextextended('istiqama:last_hq_admin', 0) & 4294967295)::oid as lk_obj \gset
\set lk_held 'exists (select 1 from pg_locks l where l.locktype = ''advisory'' and l.pid = pg_backend_pid() and l.granted and l.objsubid = 1 and l.classid = ' :lk_class ' and l.objid = ' :lk_obj ')'

select tests.login_as(tests.id('u_hq'), 'aal2');
savepoint t54_lock;
update public.profiles set full_name = full_name where id = tests.id('u_col_tanga');
select :lk_held as lk_name \gset
rollback to savepoint t54_lock;
savepoint t54_lock;
update public.profiles set active = false where id = tests.id('u_col_tanga');
select :lk_held as lk_deact \gset
rollback to savepoint t54_lock;
savepoint t54_lock;
update public.user_roles set deleted_at = now() where user_id = tests.id('u_col_tanga');
select :lk_held as lk_role \gset
rollback to savepoint t54_lock;
select :lk_held as lk_after \gset
-- a single-session removal of the last hq_admin is still refused (with the lock taken)
select throws_ok(format($$update public.user_roles set deleted_at = now()
                          where user_id = %L and role = 'hq_admin' and deleted_at is null$$, tests.id('u_hq')),
                 'PT409', 'last_hq_admin', 'direct UPDATE: the last hq_admin grant still cannot be removed');
select tests.logout();

select is(:'lk_name'::boolean, false, 'editing a profile name does not take the guard lock');
select is(:'lk_deact'::boolean, true, 'a direct deactivation holds the guard lock until commit');
select is(:'lk_role'::boolean, true, 'a direct UPDATE of user_roles holds the guard lock until commit');
select is(:'lk_after'::boolean, false, '(transaction-scoped: released by the rollback)');

-- =============================================================================
-- C. projects.migration_note through sync_push
-- =============================================================================
insert into public.devices (user_id, device_id, label)
values (tests.id('u_col_pemba'), 'dev-u5', 'Collector phone U5')
on conflict do nothing;

create function pg_temp.u5op(p_n integer, p_id uuid, p_base integer, p_fields jsonb)
returns jsonb language sql immutable as
$fn$
  select jsonb_build_object(
    'op_id', ('00000000-0000-7000-8054-' || lpad(p_n::text, 12, '0'))::uuid,
    'table', 'projects', 'id', p_id, 'kind', 'upsert', 'base_version', p_base,
    'fields', p_fields, 'client_ts', '2026-10-04T10:00:00Z');
$fn$;

select tests.login_as(tests.id('u_col_pemba'), 'aal1', 'dev-u5');
select set_config('t.push1', public.sync_push(jsonb_build_array(
  pg_temp.u5op(1, '00000000-0000-7000-9054-000000000001', 0, jsonb_build_object(
    'name_ar', 'مسجد مرحّل', 'name_latin', 'Migrated mosque', 'type', 'mosque', 'status', 'active',
    'lon', 39.71, 'lat', -5.01, 'location_source', 'map', 'country_id', tests.id('tz'),
    'review_note', 'v2: salaries assumed TZS — check'))), 'dev-u5')::text, true);
select set_config('t.push2', public.sync_push(jsonb_build_array(
  pg_temp.u5op(2, '00000000-0000-7000-9054-000000000002', 0, jsonb_build_object(
    'name_ar', 'مسجد ثان', 'name_latin', 'Second mosque', 'type', 'mosque', 'status', 'active',
    'lon', 39.72, 'lat', -5.02, 'location_source', 'map', 'country_id', tests.id('tz'),
    'migration_note', 'explicit note', 'review_note', 'ignored'))), 'dev-u5')::text, true);
select tests.logout();

select is(current_setting('t.push1')::jsonb #>> '{results,0,status}', 'applied', 'collector insert with a v2 flag is applied');
select is((select row(p.review_note, p.migration_note)::text from public.projects p
            where p.id = '00000000-0000-7000-9054-000000000001'),
          row(null::text, 'v2: salaries assumed TZS — check'::text)::text,
          'a collector''s review_note on insert is kept as migration_note (review_note stays a reviewer field)');
select is((select row(p.review_note, p.migration_note)::text from public.projects p
            where p.id = '00000000-0000-7000-9054-000000000002'),
          row(null::text, 'explicit note'::text)::text,
          'migration_note is client-writable; an explicit value wins over the alias');

-- a reviewer can clear the flag once checked
select tests.login_as(tests.id('u_sup_pemba'), 'aal1', 'dev-u5s');
select set_config('t.push3', public.sync_push(jsonb_build_array(
  pg_temp.u5op(3, '00000000-0000-7000-9054-000000000001',
               (select version from public.projects where id = '00000000-0000-7000-9054-000000000001'),
               jsonb_build_object('migration_note', null))), 'dev-u5s')::text, true);
select tests.logout();
select is((select p.migration_note from public.projects p where p.id = '00000000-0000-7000-9054-000000000001'),
          null, 'a reviewer clears migration_note');
select ok(private.sync_writable_columns('projects') @> array['migration_note']
          and not private.sync_writable_columns('projects') @> array['reviewed_by'],
          'migration_note is in the sync_push whitelist (reviewed_by stays server-managed)');

select * from finish();
rollback;

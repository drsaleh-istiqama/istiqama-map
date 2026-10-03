-- =============================================================================
-- 43  restricted_read (migration 0043; brief §2.4, §2.5, §3, §11)
--     salaries and sensitive community data: country managers of that country
--     and hq_admin only, every read logged, USD conversion, no mixed sums.
--
-- Extra rows (ids ...f0NN persons, ...f1NN staff, ...f2NN compensation):
--   p_pemba_1  fixture imam      250000 TZS from 2024-01-01 (current)   + f203 200000 TZS from 2023-01-01 (old)
--              f101 teacher      f201 100 USD (current)
--              f102 agent        f202 50 OMR (current, no fx rate)
--   p_tanga_1  fixture imam      250000 TZS (current)                   + f204 999999 TZS from today+30 (future)
--              f103 teacher, ended 2024-12-31   f205 70000 TZS (assignment ended)
--   p_ke_1     fixture imam      250000 KES (current)
-- =============================================================================
begin;
set local search_path = public, extensions, tests;

select plan(40);

select tests.fixture();

-- fx: the rate in force today is the latest one on or before today
update public.fx_rates set deleted_at = now() where currency = 'OMR' and deleted_at is null;
insert into public.fx_rates (currency, usd_per_unit, effective_date)
values
  ('TZS', 0.0004,  date '2025-01-01'),
  ('TZS', 0.00039, current_date),
  ('TZS', 0.5,     current_date + 10),     -- future rate: must be ignored
  ('KES', 0.0077,  current_date)
on conflict (currency, effective_date)
do update set usd_per_unit = excluded.usd_per_unit, deleted_at = null;

insert into public.persons (id, created_by, name_ar, name_latin, country_id, branch_id)
values
  ('00000000-0000-4000-8000-00000000f001', tests.id('u_col_pemba'), 'معلم بالدولار', 'Teacher USD', tests.id('tz'), tests.id('br_pemba')),
  ('00000000-0000-4000-8000-00000000f002', tests.id('u_col_pemba'), 'وكيل بالريال', 'Agent OMR', tests.id('tz'), tests.id('br_pemba')),
  ('00000000-0000-4000-8000-00000000f003', tests.id('u_col_tanga'), 'معلم سابق', 'Former teacher', tests.id('tz'), tests.id('br_tanga'));

insert into public.project_staff (id, created_by, project_id, person_id, role, start_date, end_date)
values
  ('00000000-0000-4000-8000-00000000f101', tests.id('u_col_pemba'), tests.id('p_pemba_1'), '00000000-0000-4000-8000-00000000f001', 'teacher', null, null),
  ('00000000-0000-4000-8000-00000000f102', tests.id('u_col_pemba'), tests.id('p_pemba_1'), '00000000-0000-4000-8000-00000000f002', 'agent', null, null),
  ('00000000-0000-4000-8000-00000000f103', tests.id('u_col_tanga'), tests.id('p_tanga_1'), '00000000-0000-4000-8000-00000000f003', 'teacher', date '2022-01-01', date '2024-12-31');

insert into public.staff_compensation (id, created_by, project_staff_id, monthly_amount, currency, effective_from)
values
  ('00000000-0000-4000-8000-00000000f201', tests.id('u_col_pemba'), '00000000-0000-4000-8000-00000000f101', 100, 'USD', date '2025-06-01'),
  ('00000000-0000-4000-8000-00000000f202', tests.id('u_col_pemba'), '00000000-0000-4000-8000-00000000f102', 50, 'OMR', date '2025-06-01'),
  ('00000000-0000-4000-8000-00000000f203', tests.id('u_col_pemba'), tests.id('staff:p_pemba_1'), 200000, 'TZS', date '2023-01-01'),
  ('00000000-0000-4000-8000-00000000f204', tests.id('u_col_tanga'), tests.id('staff:p_tanga_1'), 999999, 'TZS', current_date + 30),
  ('00000000-0000-4000-8000-00000000f205', tests.id('u_col_tanga'), '00000000-0000-4000-8000-00000000f103', 70000, 'TZS', date '2024-01-01');

create temp table t43_log as select coalesce(max(l.id), 0) as last_id from public.restricted_access_log l;

-- ---------------------------------------------------------------------------
-- Refused callers
-- ---------------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'public.restricted_read(text, uuid[])', 'execute'),
  'anon cannot execute restricted_read');

select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select throws_ok(
  $$ select public.restricted_read('staff_compensation', array[tests.id('p_pemba_1')]) $$,
  'PT403', 'forbidden', 'field collector: salaries refused (even for an own project)');
select throws_ok(
  $$ select public.restricted_read('community_sensitive', array[tests.id('p_pemba_1')]) $$,
  'PT403', 'forbidden', 'field collector: sensitive community data refused');

select tests.login_as(tests.id('u_sup_pemba'), 'aal1');
select throws_ok(
  $$ select public.restricted_read('staff_compensation', array[tests.id('p_pemba_1')]) $$,
  'PT403', 'forbidden', 'branch supervisor: refused');

select tests.login_as(tests.id('u_viewer_tz'), 'aal1');
select throws_ok(
  $$ select public.restricted_read('staff_compensation', array[tests.id('p_pemba_1')]) $$,
  'PT403', 'forbidden', 'viewer (country): refused');

select tests.login_as(tests.id('u_viewer_global'), 'aal2');
select throws_ok(
  $$ select public.restricted_read('community_sensitive', array[tests.id('p_pemba_1')]) $$,
  'PT403', 'forbidden', 'viewer (global): refused');

select tests.login_as(tests.id('u_mgr_tz'), 'aal1');
select throws_ok(
  $$ select public.restricted_read('staff_compensation', array[tests.id('p_pemba_1')]) $$,
  'PT403', 'forbidden', 'country manager without MFA (aal1): refused');

-- the tables themselves stay unreachable for a manager with MFA
select tests.login_as(tests.id('u_mgr_tz'), 'aal2');
select throws_ok('select count(*) from public.staff_compensation', '42501', null,
  'no direct SELECT on staff_compensation, even for the country manager');
select throws_ok('select count(*) from public.community_sensitive', '42501', null,
  'no direct SELECT on community_sensitive, even for the country manager');
select tests.logout();

select is(
  (select count(*)::int from public.restricted_access_log l where l.id > (select last_id from t43_log)),
  0, 'refused calls return nothing and therefore log nothing');

-- ---------------------------------------------------------------------------
-- Kenya manager: Tanzanian projects are dropped silently
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('u_mgr_ke'), 'aal2');
select public.restricted_read('staff_compensation', array[tests.id('p_pemba_1'), tests.id('p_tanga_1')]) as k1 \gset
select is(
  jsonb_build_object('rows', :'k1'::jsonb -> 'rows', 'project_ids', :'k1'::jsonb -> 'project_ids'),
  '{"rows": [], "project_ids": []}'::jsonb,
  'Kenya manager on Tanzanian projects: no rows, no project accepted');

select public.restricted_read('staff_compensation', array[tests.id('p_pemba_1'), tests.id('p_ke_1')]) as k2 \gset
select is(
  (select array_agg(e ->> 'id') from jsonb_array_elements(:'k2'::jsonb -> 'rows') e),
  array[tests.id('comp:p_ke_1')::text],
  'Kenya manager with a mixed list: only the Kenyan salary');
select is(
  (select jsonb_build_object('monthly_amount', e -> 'monthly_amount', 'currency', e -> 'currency',
                             'usd_per_unit', e -> 'usd_per_unit', 'usd_amount', e -> 'usd_amount')
   from jsonb_array_elements(:'k2'::jsonb -> 'rows') e),
  '{"monthly_amount": 250000, "currency": "KES", "usd_per_unit": 0.0077, "usd_amount": 1925}'::jsonb,
  'KES salary with its USD equivalent (250000 x 0.0077 = 1925.00)');

select public.restricted_read('community_sensitive', array[tests.id('p_tanga_1')]) as k3 \gset
select is(:'k3'::jsonb -> 'rows', '[]'::jsonb, 'Kenya manager: no Tanzanian sensitive community rows');
select tests.logout();

select is(
  (select array_agg(row(l.user_id, l.table_name, l.row_count, cardinality(l.row_ids))::text order by l.id)
   from public.restricted_access_log l where l.id > (select last_id from t43_log)),
  array[
    row(tests.id('u_mgr_ke'), 'staff_compensation'::text, 0, 0)::text,
    row(tests.id('u_mgr_ke'), 'staff_compensation'::text, 1, 1)::text,
    row(tests.id('u_mgr_ke'), 'community_sensitive'::text, 0, 0)::text],
  'each of the three calls wrote exactly one access-log entry (also the empty ones)');

-- ---------------------------------------------------------------------------
-- Tanzania manager
-- ---------------------------------------------------------------------------
update t43_log set last_id = (select coalesce(max(l.id), 0) from public.restricted_access_log l);

select tests.login_as(tests.id('u_mgr_tz'), 'aal2', 'dev-mgr-tz');
select public.restricted_read(
  'staff_compensation', array[tests.id('p_pemba_1'), tests.id('p_tanga_1'), tests.id('p_ke_1'), tests.id('p_pemba_1')]) as t1 \gset
select tests.logout();

select is(
  (select array_agg(x order by x) from jsonb_array_elements_text(:'t1'::jsonb -> 'project_ids') x),
  (select array_agg(x::text order by x::text) from unnest(array[tests.id('p_pemba_1'), tests.id('p_tanga_1')]) x),
  'Tanzania manager: the two Tanzanian projects are accepted, the Kenyan one is dropped');
select is(
  (select array_agg(e ->> 'id' order by e ->> 'id') from jsonb_array_elements(:'t1'::jsonb -> 'rows') e),
  (select array_agg(x::text order by x::text) from unnest(array[
      tests.id('comp:p_pemba_1'), tests.id('comp:p_tanga_1'),
      '00000000-0000-4000-8000-00000000f201'::uuid, '00000000-0000-4000-8000-00000000f202'::uuid,
      '00000000-0000-4000-8000-00000000f203'::uuid, '00000000-0000-4000-8000-00000000f204'::uuid,
      '00000000-0000-4000-8000-00000000f205'::uuid]) x),
  'all seven Tanzanian salary rows are returned, nothing from Kenya');

select is(
  (select jsonb_build_object(
            'project_id', e -> 'project_id', 'project_staff_id', e -> 'project_staff_id',
            'person_id', e -> 'person_id', 'person_name_ar', e -> 'person_name_ar',
            'person_name_latin', e -> 'person_name_latin', 'role', e -> 'role',
            'currency', e -> 'currency', 'effective_from', e -> 'effective_from',
            'is_current', e -> 'is_current', 'fx_date', e -> 'fx_date')
   from jsonb_array_elements(:'t1'::jsonb -> 'rows') e
   where e ->> 'id' = tests.id('comp:p_pemba_1')::text),
  jsonb_build_object(
    'project_id', tests.id('p_pemba_1'), 'project_staff_id', tests.id('staff:p_pemba_1'),
    'person_id', tests.id('person:p_pemba_1'), 'person_name_ar', 'إمام p_pemba_1',
    'person_name_latin', 'Imam p_pemba_1', 'role', 'imam',
    'currency', 'TZS', 'effective_from', '2024-01-01',
    'is_current', true, 'fx_date', current_date),
  'a salary row carries assignment, person name, role, currency, effective date and the fx date used');
select is(
  (select jsonb_build_object('monthly_amount', e -> 'monthly_amount', 'usd_per_unit', e -> 'usd_per_unit',
                             'usd_amount', e -> 'usd_amount')
   from jsonb_array_elements(:'t1'::jsonb -> 'rows') e
   where e ->> 'id' = tests.id('comp:p_pemba_1')::text),
  '{"monthly_amount": 250000, "usd_per_unit": 0.00039, "usd_amount": 97.5}'::jsonb,
  'USD equivalent uses the latest rate on or before today (0.00039), not the older or the future one');
select is(
  (select jsonb_build_object('monthly_amount', e -> 'monthly_amount', 'usd_per_unit', e -> 'usd_per_unit',
                             'usd_amount', e -> 'usd_amount', 'fx_date', e -> 'fx_date')
   from jsonb_array_elements(:'t1'::jsonb -> 'rows') e
   where e ->> 'id' = '00000000-0000-4000-8000-00000000f201'),
  '{"monthly_amount": 100, "usd_per_unit": 1, "usd_amount": 100, "fx_date": null}'::jsonb,
  'a USD salary converts 1:1');
select is(
  (select jsonb_build_object('monthly_amount', e -> 'monthly_amount', 'currency', e -> 'currency',
                             'usd_per_unit', e -> 'usd_per_unit', 'usd_amount', e -> 'usd_amount')
   from jsonb_array_elements(:'t1'::jsonb -> 'rows') e
   where e ->> 'id' = '00000000-0000-4000-8000-00000000f202'),
  '{"monthly_amount": 50, "currency": "OMR", "usd_per_unit": null, "usd_amount": null}'::jsonb,
  'a currency without a rate has no USD equivalent (null, never a guess)');
select is(
  (select jsonb_object_agg(e ->> 'id', e -> 'is_current')
   from jsonb_array_elements(:'t1'::jsonb -> 'rows') e
   where e ->> 'id' in ('00000000-0000-4000-8000-00000000f203', '00000000-0000-4000-8000-00000000f204',
                        '00000000-0000-4000-8000-00000000f205')),
  '{"00000000-0000-4000-8000-00000000f203": false, "00000000-0000-4000-8000-00000000f204": false, "00000000-0000-4000-8000-00000000f205": false}'::jsonb,
  'superseded, future-dated and ended-assignment salaries are returned but not current');

-- totals: per currency, USD only through conversion
select is(
  (select jsonb_agg(
            jsonb_build_object('currency', b -> 'currency', 'staff_count', b -> 'staff_count',
                               'monthly_amount', (b ->> 'monthly_amount')::numeric,
                               'usd_amount', (b ->> 'usd_amount')::numeric)
            order by b ->> 'currency')
   from jsonb_array_elements(:'t1'::jsonb -> 'totals' -> 'by_currency') b),
  jsonb_build_array(
    jsonb_build_object('currency', 'OMR', 'staff_count', 1, 'monthly_amount', 50::numeric, 'usd_amount', null),
    jsonb_build_object('currency', 'TZS', 'staff_count', 2, 'monthly_amount', 500000::numeric, 'usd_amount', 195::numeric),
    jsonb_build_object('currency', 'USD', 'staff_count', 1, 'monthly_amount', 100::numeric, 'usd_amount', 100::numeric)),
  'totals are kept per currency (current salaries only): amounts of different currencies are never added');
select is(
  (select count(*)::int from jsonb_array_elements(:'t1'::jsonb -> 'totals' -> 'by_currency') b),
  (select count(distinct e ->> 'currency')::int
   from jsonb_array_elements(:'t1'::jsonb -> 'rows') e where (e ->> 'is_current')::boolean),
  'exactly one total per currency');
select is(
  jsonb_build_object(
    'usd_total', (:'t1'::jsonb -> 'totals' ->> 'usd_total')::numeric,
    'usd_complete', :'t1'::jsonb -> 'totals' -> 'usd_complete',
    'missing_rates', :'t1'::jsonb -> 'totals' -> 'missing_rates'),
  jsonb_build_object('usd_total', 295::numeric, 'usd_complete', false, 'missing_rates', '["OMR"]'::jsonb),
  'the USD total (97.50 + 97.50 + 100) covers converted currencies only and says that OMR is missing');
select is(:'t1'::jsonb ->> 'as_of', current_date::text, 'as_of is today');

select is(
  (select count(*)::int from public.restricted_access_log l where l.id > (select last_id from t43_log)),
  1, 'the call wrote exactly one access-log entry');
select is(
  (select jsonb_build_object(
            'user_id', l.user_id, 'device_id', l.device_id, 'table_name', l.table_name, 'row_count', l.row_count,
            'ids', (select array_agg(x::text order by x::text) from unnest(l.row_ids) x),
            'recent', l.accessed_at > now() - interval '1 minute',
            'context', l.context like 'restricted_read%')
   from public.restricted_access_log l where l.id > (select last_id from t43_log)),
  jsonb_build_object(
    'user_id', tests.id('u_mgr_tz'), 'device_id', 'dev-mgr-tz', 'table_name', 'staff_compensation', 'row_count', 7,
    'ids', (select array_agg(e ->> 'id' order by e ->> 'id') from jsonb_array_elements(:'t1'::jsonb -> 'rows') e),
    'recent', true, 'context', true),
  'the entry names the reader, the device, the table and exactly the salary rows that were returned');

-- sensitive community data
select tests.login_as(tests.id('u_mgr_tz'), 'aal2');
select public.restricted_read(
  'community_sensitive', array[tests.id('p_pemba_1'), tests.id('p_tanga_1'), tests.id('p_ke_1')]) as t2 \gset
select tests.logout();

select is(
  (select array_agg(e ->> 'id' order by e ->> 'id') from jsonb_array_elements(:'t2'::jsonb -> 'rows') e),
  (select array_agg(x::text order by x::text) from unnest(array[tests.id('sens:p_pemba_1'), tests.id('sens:p_tanga_1')]) x),
  'Tanzania manager: sensitive community rows of the Tanzanian projects only');
select is(
  (select jsonb_build_object(
            'project_id', e -> 'project_id', 'ibadi_families', e -> 'ibadi_families', 'omani_families', e -> 'omani_families',
            'omani_student_pct', (e ->> 'omani_student_pct')::numeric, 'ibadi_student_pct', (e ->> 'ibadi_student_pct')::numeric,
            'guest_financial_capacity', e -> 'guest_financial_capacity')
   from jsonb_array_elements(:'t2'::jsonb -> 'rows') e where e ->> 'id' = tests.id('sens:p_pemba_1')::text),
  jsonb_build_object(
    'project_id', tests.id('p_pemba_1'), 'ibadi_families', 12, 'omani_families', 3,
    'omani_student_pct', 5::numeric, 'ibadi_student_pct', 40::numeric, 'guest_financial_capacity', 'limited'),
  'a sensitive row carries its fields');
select is(
  (select row(l.user_id, l.table_name, l.row_count)::text
   from public.restricted_access_log l order by l.id desc limit 1),
  row(tests.id('u_mgr_tz'), 'community_sensitive'::text, 2)::text,
  'the sensitive read is logged as well');

-- ---------------------------------------------------------------------------
-- hq_admin, validation
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('u_hq'), 'aal2');
select public.restricted_read('staff_compensation', tests.fixture_projects()) as h1 \gset
select is(
  (select count(distinct e ->> 'project_id')::int from jsonb_array_elements(:'h1'::jsonb -> 'rows') e),
  4, 'hq_admin reads the salaries of every country (four fixture projects)');
select is(
  (select array_agg(b ->> 'currency' order by b ->> 'currency')
   from jsonb_array_elements(:'h1'::jsonb -> 'totals' -> 'by_currency') b),
  array['KES', 'OMR', 'TZS', 'USD'],
  'hq totals: one line per currency, KES and TZS are not mixed');
select is(
  (:'h1'::jsonb -> 'totals' ->> 'usd_total')::numeric,
  (97.50 * 3 + 100 + 1925.00)::numeric,
  'hq USD total = every current salary converted with its own rate');

select throws_ok(
  $$ select public.restricted_read('persons', array[tests.id('p_pemba_1')]) $$,
  'PT422', 'invalid_table', 'only the two restricted tables are accepted');
select throws_ok(
  $$ select public.restricted_read('staff_compensation; drop table x', array[tests.id('p_pemba_1')]) $$,
  'PT422', 'invalid_table', 'the table name is never interpolated');
select throws_ok(
  $$ select public.restricted_read('staff_compensation',
       (select array_agg(md5(g::text)::uuid) from generate_series(1, 201) g)) $$,
  'PT422', 'too_many_projects', 'more than 200 projects per call is refused');
select lives_ok(
  $$ select public.restricted_read('staff_compensation',
       (select array_agg(md5(g::text)::uuid) from generate_series(1, 200) g)) $$,
  '200 projects are accepted');
select is(
  public.restricted_read('community_sensitive', null) -> 'rows', '[]'::jsonb,
  'a null project list returns no rows');
select tests.logout();

-- a soft-deleted project gives nothing away
update public.projects set deleted_at = now() where id = tests.id('p_tanga_1');
select tests.login_as(tests.id('u_mgr_tz'), 'aal2');
select is(
  public.restricted_read('staff_compensation', array[tests.id('p_tanga_1')]) -> 'rows', '[]'::jsonb,
  'salaries of a soft-deleted project are not returned');
select tests.logout();

select * from finish();
rollback;

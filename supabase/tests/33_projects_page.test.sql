-- =============================================================================
-- 33  projects_page (migration 0034, brief §5: keyset pagination)
-- =============================================================================
begin;
set local search_path = public, extensions, tests;

select plan(31);

select tests.fixture_extra();

-- Helper (rolled back): walks every page and returns the ids in the order received.
create schema tests_page;
grant usage on schema tests_page to public;

create function tests_page.walk(p_filters jsonb, p_limit integer)
returns uuid[]
language plpgsql
as $$
declare
  v_after jsonb;
  v_page jsonb;
  v_ids uuid[] := '{}';
  v_guard integer := 0;
begin
  loop
    v_page := public.projects_page(p_filters, v_after, p_limit);
    v_ids := v_ids || coalesce(
      (select array_agg((r ->> 'id')::uuid order by o)
       from jsonb_array_elements(v_page -> 'rows') with ordinality as e(r, o)),
      '{}'::uuid[]);
    v_after := v_page -> 'next';
    exit when v_after is null or v_after = 'null'::jsonb;
    v_guard := v_guard + 1;
    if v_guard > 100 then
      raise exception 'paging does not terminate';
    end if;
  end loop;
  return v_ids;
end;
$$;

-- Nested areas inside Pemba North and 25 more Pemba projects (several share a
-- name, so the id tie-breaker matters), spread over types / statuses / states.
insert into public.admin_areas (id, country_id, parent_id, level, code, name_ar, name_en, name_sw, geom)
values
  ('00000000-0000-4000-8000-00000000a202', tests.id('tz'), tests.id('tz_pemba_north'), 2,
   'TEST-PAGE-L2', 'مقاطعة الاختبار', 'Page district (test)', 'Wilaya ya jaribio',
   st_multi(st_makeenvelope(39.80, -5.00, 39.88, -4.90, 4326)));
insert into public.admin_areas (id, country_id, parent_id, level, code, name_ar, name_en, name_sw, geom)
values
  ('00000000-0000-4000-8000-00000000a203', tests.id('tz'), '00000000-0000-4000-8000-00000000a202', 3,
   'TEST-PAGE-L3', 'قرية الاختبار', 'Page village (test)', 'Kijiji cha jaribio',
   st_multi(st_makeenvelope(39.82, -4.98, 39.86, -4.92, 4326)));

insert into public.projects
  (id, created_by, name_ar, name_latin, type, status, capacity, geom, country_id, branch_id, record_state)
select
  ('00000000-0000-4000-8000-0000000a' || lpad(to_hex(4096 + g), 4, '0'))::uuid,
  case when g <= 5 then tests.id('u_col_pemba2') else tests.id('u_sup_pemba') end,
  'مشروع ترقيم ' || (array['ألف', 'باء', 'جيم', 'دال', 'هاء', 'واو', 'زاي', 'حاء', 'طاء'])[1 + g % 9],
  'Paging project ' || g,
  (array['mosque', 'school', 'combined'])[1 + g % 3],
  (array['active', 'maintenance', 'building', 'inactive'])[1 + g % 4],
  50,
  -- g 1..10 fall inside the level-3 village, the rest elsewhere in Pemba North
  case when g <= 10 then st_setsrid(st_makepoint(39.83 + g * 0.002, -4.95), 4326)
       else st_setsrid(st_makepoint(39.62 + g * 0.002, -5.15), 4326) end,
  tests.id('tz'), tests.id('br_pemba'),
  (array['draft', 'submitted', 'approved', 'returned'])[1 + g % 4]
from generate_series(1, 25) g;

-- Distinct modification times for the "updated" order. The standard trigger
-- stamps every row of this transaction with the same now(), so it is switched
-- off for this one statement (table owner privilege; rolled back with the test).
alter table public.projects disable trigger t10_std;
update public.projects p
set updated_at = now() - make_interval(mins => s.n::int)
from (select id, row_number() over (order by id) as n
      from public.projects where branch_id = tests.id('br_pemba')) s
where p.id = s.id and s.n % 3 <> 0;   -- every third row keeps the shared timestamp (ties)
alter table public.projects enable trigger t10_std;

select has_function('public', 'projects_page', array['jsonb', 'jsonb', 'integer'],
  'projects_page(filters, after, limit) exists');
select function_privs_are('public', 'projects_page', array['jsonb', 'jsonb', 'integer'],
  'anon', array[]::text[], 'anon cannot execute projects_page');

-- Expected orders, computed by the privileged role.
select array_agg(p.id order by p.name_ar collate "C", p.id)::text as exp_name
from public.projects p where p.branch_id = tests.id('br_pemba') and p.deleted_at is null \gset
select array_agg(p.id order by p.updated_at desc, p.id desc)::text as exp_updated
from public.projects p where p.branch_id = tests.id('br_pemba') and p.deleted_at is null \gset
select count(*)::int as all_projects from public.projects p where p.deleted_at is null \gset
select count(*)::int as approved_projects from public.projects p
where p.deleted_at is null and p.record_state = 'approved' \gset

-- ----------------------------------------------------------------------------
-- Keyset paging: every row exactly once, in order
-- ----------------------------------------------------------------------------
select tests.login_as(tests.id('u_col_pemba'), 'aal1');

select is(cardinality(:'exp_name'::uuid[]), 27, 'the Pemba branch has 27 live projects in this test');
select is(tests_page.walk('{}'::jsonb, 4), :'exp_name'::uuid[],
  'name order, pages of 4: each row once, ordered by (name_ar, id)');
select is(tests_page.walk('{"sort": "name"}'::jsonb, 27), :'exp_name'::uuid[],
  'name order, one page of exactly the row count: complete and terminates');
select is(tests_page.walk('{"sort": "updated"}'::jsonb, 5), :'exp_updated'::uuid[],
  'updated order, pages of 5: each row once, ordered by (updated_at desc, id desc)');
select is(tests_page.walk('{"sort": "updated"}'::jsonb, 1), :'exp_updated'::uuid[],
  'updated order, pages of 1: ties on updated_at are neither skipped nor repeated');

select is((public.projects_page('{}'::jsonb, null, 4) ->> 'total')::int, 27,
  'the first page reports the total');
select is(jsonb_array_length(public.projects_page('{}'::jsonb, null, 4) -> 'rows'), 4,
  'p_limit is respected');
select ok(
  not (public.projects_page('{}'::jsonb, public.projects_page('{}'::jsonb, null, 4) -> 'next', 4) ? 'total'),
  'later pages do not recount');
select is(public.projects_page('{}'::jsonb, null, 50) -> 'next', 'null'::jsonb,
  'next is null on the last page');
select is(jsonb_array_length(public.projects_page(null, null, 100000) -> 'rows'), 27,
  'null filters are accepted and an absurd limit is capped without error');

-- ----------------------------------------------------------------------------
-- Row shape
-- ----------------------------------------------------------------------------
select ok(
  (select r ?& array['id', 'code', 'name_ar', 'name_latin', 'type', 'status', 'record_state',
                     'completeness', 'capacity', 'lon', 'lat', 'country_id', 'branch_id',
                     'admin_area_id', 'locality_id', 'area_level', 'area_name_ar', 'area_name_en',
                     'area_name_sw', 'locality_name_ar', 'locality_name_latin', 'cover_thumb',
                     'updated_at', 'version']
   from jsonb_array_elements(public.projects_page('{"q": "p_pemba_1"}'::jsonb, null, 5) -> 'rows') r),
  'a row carries every documented key');
select is(
  (select jsonb_build_array(r -> 'lon', r -> 'lat', r -> 'area_name_sw', r -> 'area_level')
   from jsonb_array_elements(public.projects_page('{"q": "p_pemba_1"}'::jsonb, null, 5) -> 'rows') r),
  '[39.75, -5.05, "Kaskazini Pemba", 1]'::jsonb,
  'coordinates travel as lon/lat numbers and the area names are joined');
select ok(
  (select r ->> 'cover_thumb' ~ ('^projects/TZ/' || tests.id('p_pemba_1')::text || '/.+_thumb\.webp$')
   from jsonb_array_elements(public.projects_page('{"q": "p_pemba_1"}'::jsonb, null, 5) -> 'rows') r),
  'cover_thumb is the storage path of the cover thumbnail');

-- ----------------------------------------------------------------------------
-- Filters (expected sets computed after logout, see below)
-- ----------------------------------------------------------------------------
select tests_page.walk('{"type": "school"}'::jsonb, 6)::text as got_type \gset
select tests_page.walk('{"status": ["maintenance", "building"]}'::jsonb, 6)::text as got_status \gset
select tests_page.walk('{"record_state": "draft"}'::jsonb, 6)::text as got_state \gset
select tests_page.walk('{"q": "جيم ترقيم"}'::jsonb, 2)::text as got_q \gset
select tests_page.walk('{"incomplete": true}'::jsonb, 6)::text as got_incomplete \gset
select tests_page.walk('{"created_by_me": true}'::jsonb, 6)::text as got_mine \gset
select tests_page.walk('{"has_open_maintenance": true}'::jsonb, 6)::text as got_maint \gset
select tests_page.walk(jsonb_build_object('admin_area_id', tests.id('tz_pemba_north')), 6)::text as got_area1 \gset
select tests_page.walk('{"admin_area_id": "00000000-0000-4000-8000-00000000a202"}'::jsonb, 6)::text as got_area2 \gset
select tests_page.walk(jsonb_build_object('donor_id', tests.id('donor:p_pemba_1')), 6)::text as got_donor \gset
select tests_page.walk(jsonb_build_object('country_id', tests.id('ke')), 6)::text as got_other_country \gset
select tests_page.walk(jsonb_build_object('branch_id', tests.id('br_tanga')), 6)::text as got_other_branch \gset

select tests.logout();

select set_eq(
  format('select unnest(%L::uuid[])', :'got_type'),
  $$select id from public.projects where branch_id = tests.id('br_pemba') and type = 'school'$$,
  'filter type');
select set_eq(
  format('select unnest(%L::uuid[])', :'got_status'),
  $$select id from public.projects where branch_id = tests.id('br_pemba') and status in ('maintenance', 'building')$$,
  'filter status (array)');
select set_eq(
  format('select unnest(%L::uuid[])', :'got_state'),
  $$select id from public.projects where branch_id = tests.id('br_pemba') and record_state = 'draft'$$,
  'filter record_state');
select set_eq(
  format('select unnest(%L::uuid[])', :'got_q'),
  $$select id from public.projects where branch_id = tests.id('br_pemba') and name_ar = 'مشروع ترقيم جيم'$$,
  'filter q (all words must occur, in any order)');
select set_eq(
  format('select unnest(%L::uuid[])', :'got_incomplete'),
  $$select id from public.projects where branch_id = tests.id('br_pemba') and completeness < 100$$,
  'filter incomplete');
select set_eq(
  format('select unnest(%L::uuid[])', :'got_mine'),
  $$select id from public.projects where branch_id = tests.id('br_pemba') and created_by = tests.id('u_col_pemba')$$,
  'filter created_by_me');
select set_eq(
  format('select unnest(%L::uuid[])', :'got_maint'),
  $$select project_id from public.project_maintenance m join public.projects p on p.id = m.project_id
    where p.branch_id = tests.id('br_pemba') and m.state in ('open', 'in_progress') and m.deleted_at is null$$,
  'filter has_open_maintenance');
select is(cardinality(:'got_area1'::uuid[]), 27,
  'filter admin_area_id (level 1) includes the projects of its descendant areas');
select set_eq(
  format('select unnest(%L::uuid[])', :'got_area2'),
  $$select id from public.projects where admin_area_id = '00000000-0000-4000-8000-00000000a203'$$,
  'filter admin_area_id (level 2) returns the projects of the village below it');
select is(:'got_donor'::uuid[], array[tests.id('p_pemba_1')], 'filter donor_id');
select is(:'got_other_country'::uuid[] || :'got_other_branch'::uuid[], '{}'::uuid[],
  'filtering by a country / branch outside the caller''s scope returns nothing');

-- ----------------------------------------------------------------------------
-- Scope
-- ----------------------------------------------------------------------------
select tests.login_as(tests.id('u_col_ke'), 'aal1');
select is(tests_page.walk('{}'::jsonb, 3), array[tests.id('p_ke_1')],
  'a Kenyan collector lists only Kenyan projects');
select is(tests_page.walk(jsonb_build_object('country_id', tests.id('tz')), 3), '{}'::uuid[],
  'a Kenyan collector asking for Tanzania gets nothing');

select tests.login_as(tests.id('u_viewer_global'), 'aal1');
select is(
  (public.projects_page('{}'::jsonb, null, 1) ->> 'total')::int,
  :approved_projects,
  'a global viewer sees every live approved project (owner decision ح: no draft / submitted / returned)');

-- ----------------------------------------------------------------------------
-- Validation
-- ----------------------------------------------------------------------------
select throws_ok($$select public.projects_page('{"sort": "random"}'::jsonb, null, 10)$$, 'PT422', null,
  'unknown sort is rejected');
select throws_ok(
  $$select public.projects_page('{"sort": "updated"}'::jsonb,
                                '{"s": "name", "k": "x", "id": "00000000-0000-4000-8000-000000000001"}'::jsonb, 10)$$,
  'PT422', null, 'a cursor of another sort order is rejected');

select tests.logout();
select * from finish();
rollback;

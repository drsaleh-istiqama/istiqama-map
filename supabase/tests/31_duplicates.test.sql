-- =============================================================================
-- 31  project_duplicates (migration 0032, brief §7.3)
-- =============================================================================
begin;
set local search_path = public, extensions, tests;

select plan(22);

select tests.fixture_extra();

-- p_pemba_1 is a mosque at (39.75, -5.05). One degree of latitude is ~110.6 km
-- there, so +0.000904 deg is ~100 m north and +0.001808 deg is ~200 m north.

-- A level-3 area (village) and extra projects for the name rule.
insert into public.admin_areas (id, country_id, parent_id, level, code, name_en, geom)
values
  ('00000000-0000-4000-8000-00000000a102', tests.id('tz'), tests.id('tz_pemba_north'), 2,
   'TEST-DUP-L2', 'Dup district (test)', st_multi(st_makeenvelope(39.80, -5.00, 39.88, -4.90, 4326)));
insert into public.admin_areas (id, country_id, parent_id, level, code, name_en, geom)
values
  ('00000000-0000-4000-8000-00000000a103', tests.id('tz'), '00000000-0000-4000-8000-00000000a102', 3,
   'TEST-DUP-L3', 'Dup village (test)', st_multi(st_makeenvelope(39.82, -4.98, 39.86, -4.92, 4326)));

insert into public.projects
  (id, created_by, name_ar, name_latin, type, status, geom, country_id, branch_id, locality_id, record_state)
values
  -- same locality as the candidate, 6 km away from p_pemba_1
  ('00000000-0000-4000-8000-00000000c001', tests.id('u_col_pemba'), 'مسجد النور', 'Masjid Nuur', 'mosque', 'active',
   st_setsrid(st_makepoint(39.741, -5.001), 4326), tests.id('tz'), tests.id('br_pemba'),
   tests.id('loc:tz_pemba_north'), 'approved'),
  -- inside the level-3 village, no locality
  ('00000000-0000-4000-8000-00000000c002', tests.id('u_col_pemba'), 'مدرسة الهدى القرآنية', 'Madrasat Al-Huda', 'school', 'active',
   st_setsrid(st_makepoint(39.84, -4.95), 4326), tests.id('tz'), tests.id('br_pemba'),
   null, 'approved'),
  -- same name as c001 but in another locality (Tanga)
  ('00000000-0000-4000-8000-00000000c003', tests.id('u_col_tanga'), 'مسجد النور', 'Masjid Nuur', 'mosque', 'active',
   st_setsrid(st_makepoint(39.06, -5.11), 4326), tests.id('tz'), tests.id('br_tanga'),
   tests.id('loc:tz_tanga'), 'approved');

select has_function('public', 'project_duplicates',
  array['text', 'double precision', 'double precision', 'text', 'uuid', 'uuid'],
  'project_duplicates(type, lon, lat, name, locality, exclude) exists');
select function_privs_are('public', 'project_duplicates',
  array['text', 'double precision', 'double precision', 'text', 'uuid', 'uuid'],
  'anon', array[]::text[], 'anon cannot execute project_duplicates');

select tests.login_as(tests.id('u_col_pemba2'), 'aal1');

-- ----------------------------------------------------------------------------
-- Rule 1: same type within 150 m
-- ----------------------------------------------------------------------------
select is(
  (select jsonb_agg(d -> 'id')
   from jsonb_array_elements(public.project_duplicates('mosque', 39.75, -5.049096, null, null)) d),
  jsonb_build_array(tests.id('p_pemba_1')),
  '100 m away, same type: reported');
select is(
  public.project_duplicates('mosque', 39.75, -5.049096, null, null) -> 0 ->> 'reason', 'nearby',
  '100 m away: reason is "nearby"');
select ok(
  (public.project_duplicates('mosque', 39.75, -5.049096, null, null) -> 0 ->> 'distance_m')::numeric
    between 95 and 105,
  '100 m away: distance_m is about 100');
select is(
  public.project_duplicates('mosque', 39.75, -5.049096, null, null) -> 0 -> 'similarity', 'null'::jsonb,
  'no name given: similarity is null');
select is(
  public.project_duplicates('mosque', 39.75, -5.048192, null, null), '[]'::jsonb,
  '200 m away: not a duplicate');
select is(
  public.project_duplicates('school', 39.75, -5.049096, null, null), '[]'::jsonb,
  '100 m away but a different type (school vs mosque): not a duplicate');
select is(
  (select jsonb_agg(d -> 'id')
   from jsonb_array_elements(public.project_duplicates('combined', 39.75, -5.049096, null, null)) d),
  jsonb_build_array(tests.id('p_pemba_1')),
  '"combined" overlaps with a mosque within 150 m');
select is(
  public.project_duplicates('mosque', 39.75, -5.049096, null, null, tests.id('p_pemba_1')), '[]'::jsonb,
  'the record being edited is excluded');
select is(
  public.project_duplicates('mosque', 39.75, -5.049096, null, null) -> 0 ->> 'created_by_me', 'false',
  'created_by_me is false for somebody else''s record');

-- ----------------------------------------------------------------------------
-- Rule 2: similar name in the same locality / village
-- ----------------------------------------------------------------------------
select is(
  (select jsonb_agg(d -> 'id')
   from jsonb_array_elements(public.project_duplicates(
     'mosque', 39.70, -5.15, 'مَسْجِدُ النُّورِ', tests.id('loc:tz_pemba_north'))) d),
  jsonb_build_array('00000000-0000-4000-8000-00000000c001'),
  'same locality, same name written with tashkeel: reported (and the Tanga namesake is not)');
select is(
  public.project_duplicates('mosque', 39.70, -5.15, 'مَسْجِدُ النُّورِ', tests.id('loc:tz_pemba_north'))
    -> 0 ->> 'reason',
  'similar_name', 'far away but similar name: reason is "similar_name"');
select ok(
  (public.project_duplicates('mosque', 39.70, -5.15, 'مَسْجِدُ النُّورِ', tests.id('loc:tz_pemba_north'))
    -> 0 ->> 'similarity')::numeric >= 0.6,
  'similarity is at least the 0.6 threshold');
select is(
  (select jsonb_agg(d -> 'id')
   from jsonb_array_elements(public.project_duplicates(
     'school', null, null, 'masjid nuur', tests.id('loc:tz_pemba_north'))) d),
  jsonb_build_array('00000000-0000-4000-8000-00000000c001'),
  'the Latin name matches too, even without coordinates and with another type');
select is(
  public.project_duplicates('mosque', 39.70, -5.15, 'مدرسة الفرقان', tests.id('loc:tz_pemba_north')),
  '[]'::jsonb, 'same locality, different name: not a duplicate');
select is(
  (select jsonb_agg(d -> 'id')
   from jsonb_array_elements(public.project_duplicates(
     'mosque', 39.83, -4.93, 'مدرسه الهدي القرانيه', null)) d),
  jsonb_build_array('00000000-0000-4000-8000-00000000c002'),
  'no locality chosen: a similar name in the same level-3 village is reported');
select is(
  public.project_duplicates('mosque', 39.75, -5.049096, 'مشروع اختبار p_pemba_1', null)
    -> 0 ->> 'similarity',
  '1.000', 'a nearby hit also reports the name similarity');

-- Both rules at once.
select tests.logout();
update public.projects set locality_id = tests.id('loc:tz_pemba_north') where id = tests.id('p_pemba_1');
select tests.login_as(tests.id('u_col_pemba2'), 'aal1');
select is(
  public.project_duplicates('mosque', 39.75, -5.049096, 'مشروع اختبار p_pemba_1',
                            tests.id('loc:tz_pemba_north')) -> 0 ->> 'reason',
  'both', 'nearby and similar name: reason is "both"');

-- ----------------------------------------------------------------------------
-- Scope and validation
-- ----------------------------------------------------------------------------
select tests.login_as(tests.id('u_col_ke'), 'aal1');
select is(
  public.project_duplicates('mosque', 39.75, -5.049096, 'مشروع اختبار p_pemba_1',
                            tests.id('loc:tz_pemba_north')),
  '[]'::jsonb, 'a Kenyan collector never sees Tanzanian candidates');

select tests.login_as(tests.id('u_viewer_tz'), 'aal1');
select ok(
  exists (select 1
          from jsonb_array_elements(public.project_duplicates('mosque', 39.75, -5.049096, null, null)) d
          where d ->> 'id' = tests.id('p_pemba_1')::text),
  'a viewer of the country gets the candidate (projects are readable by viewers)');

select throws_ok(
  $$select public.project_duplicates('church', 39.75, -5.05, null, null)$$, 'PT422', null,
  'unknown project type is rejected');

select tests.logout();
select * from finish();
rollback;

-- =============================================================================
-- 32  search (migration 0033, brief §5)
-- =============================================================================
begin;
set local search_path = public, extensions, tests;

select plan(36);

select tests.fixture_extra();

-- Extra rows (rolled back with the transaction).
insert into public.projects
  (id, created_by, name_ar, name_latin, type, status, geom, country_id, branch_id, record_state)
values
  ('00000000-0000-4000-8000-00000000d001', tests.id('u_col_pemba'), 'مدرسة النور', 'Msikiti wa Élite Nuru',
   'school', 'active', st_setsrid(st_makepoint(39.72, -5.02), 4326), tests.id('tz'), tests.id('br_pemba'), 'approved'),
  ('00000000-0000-4000-8000-00000000d002', tests.id('u_col_pemba'), 'مسجد الرحمة', 'Masjid Rahma',
   'mosque', 'active', st_setsrid(st_makepoint(39.73, -5.03), 4326), tests.id('tz'), tests.id('br_pemba'), 'approved'),
  ('00000000-0000-4000-8000-00000000d003', tests.id('u_col_ke'), 'مسجد التقوى', 'Masjid Taqwa',
   'mosque', 'active', st_setsrid(st_makepoint(39.67, -4.06), 4326), tests.id('ke'), tests.id('br_mombasa'), 'approved');

insert into public.persons (id, created_by, name_ar, name_latin, country_id, branch_id)
values
  ('00000000-0000-4000-8000-00000000e001', tests.id('u_col_pemba'), 'أحمد بن سعيد الخروصي', 'Ahmed bin Said',
   tests.id('tz'), tests.id('br_pemba')),
  ('00000000-0000-4000-8000-00000000e002', tests.id('u_col_pemba'), 'محمد بن خلفان', 'Mohammed bin Khalfanqx',
   tests.id('tz'), tests.id('br_pemba')),
  ('00000000-0000-4000-8000-00000000e003', tests.id('u_col_ke'), 'احمد بن ناصر', 'Ahmed bin Nasser',
   tests.id('ke'), tests.id('br_mombasa'));

insert into public.project_staff (id, created_by, project_id, person_id, role, start_date)
values
  ('00000000-0000-4000-8000-00000000f001', tests.id('u_col_pemba'), '00000000-0000-4000-8000-00000000d001',
   '00000000-0000-4000-8000-00000000e001', 'teacher', date '2021-01-01'),
  ('00000000-0000-4000-8000-00000000f002', tests.id('u_col_pemba'), '00000000-0000-4000-8000-00000000d002',
   '00000000-0000-4000-8000-00000000e002', 'imam', date '2021-01-01'),
  ('00000000-0000-4000-8000-00000000f003', tests.id('u_col_ke'), '00000000-0000-4000-8000-00000000d003',
   '00000000-0000-4000-8000-00000000e003', 'imam', date '2021-01-01');

insert into public.donors (id, created_by, name_ar, name_latin)
values ('00000000-0000-4000-8000-00000000d101', tests.id('u_col_pemba'), 'مؤسسة الخير الوقفية', 'Al-Khairqx Foundation');
insert into public.project_donors (id, created_by, project_id, donor_id, year)
values ('00000000-0000-4000-8000-00000000d102', tests.id('u_col_pemba'),
        '00000000-0000-4000-8000-00000000d002', '00000000-0000-4000-8000-00000000d101', 2020);

-- 60 Tanzanian projects sharing one word, to test the limit cap.
insert into public.projects (id, created_by, name_ar, type, status, geom, country_id, branch_id, record_state)
select ('00000000-0000-4000-8000-0000000d' || lpad(to_hex(4096 + g), 4, '0'))::uuid,
       tests.id('u_col_tanga'), 'مصلى الزيتونة رقم ' || g, 'mosque', 'active',
       st_setsrid(st_makepoint(38.9 + g * 0.001, -5.2), 4326), tests.id('tz'), tests.id('br_tanga'), 'approved'
from generate_series(1, 60) g;

-- ----------------------------------------------------------------------------
-- Environment and catalogue
-- ----------------------------------------------------------------------------
select ok(
  cardinality(show_trgm('محمد')) > 0,
  'pg_trgm extracts trigrams from Arabic text (the database LC_CTYPE must not be "C")');
select has_function('public', 'search', array['text', 'integer', 'text[]'], 'search(q, limit, kinds) exists');
select function_privs_are('public', 'search', array['text', 'integer', 'text[]'],
  'anon', array[]::text[], 'anon cannot execute search');

-- ----------------------------------------------------------------------------
-- Arabic and Latin normalisation
-- ----------------------------------------------------------------------------
select tests.login_as(tests.id('u_col_pemba'), 'aal1');

select ok(
  exists (select 1 from jsonb_array_elements(public.search('احمد')) h
          where h ->> 'kind' = 'staff' and h ->> 'id' = '00000000-0000-4000-8000-00000000e001'),
  'hamza: typing "احمد" finds "أحمد"');
select ok(
  exists (select 1 from jsonb_array_elements(public.search('أحمد بن سعيد')) h
          where h ->> 'kind' = 'staff' and h ->> 'id' = '00000000-0000-4000-8000-00000000e001'),
  'hamza: typing "أحمد" finds the same person');
select ok(
  exists (select 1 from jsonb_array_elements(public.search('مدرسه النور')) h
          where h ->> 'kind' = 'project' and h ->> 'id' = '00000000-0000-4000-8000-00000000d001'),
  'teh marbuta: typing "مدرسه" finds "مدرسة"');
select ok(
  exists (select 1 from jsonb_array_elements(public.search('مَسْجِدُ الرَّحْمَةِ')) h
          where h ->> 'kind' = 'project' and h ->> 'id' = '00000000-0000-4000-8000-00000000d002'),
  'tashkeel in the query is ignored');
select ok(
  exists (select 1 from jsonb_array_elements(public.search('الخروصى')) h
          where h ->> 'kind' = 'staff' and h ->> 'id' = '00000000-0000-4000-8000-00000000e001'),
  'alef maqsura: typing a final "ى" finds "ي"');
select ok(
  exists (select 1 from jsonb_array_elements(public.search('elite')) h
          where h ->> 'kind' = 'project' and h ->> 'id' = '00000000-0000-4000-8000-00000000d001'),
  'Latin accents: typing "elite" finds "Élite"');
select ok(
  exists (select 1 from jsonb_array_elements(public.search('NURU msikiti')) h
          where h ->> 'kind' = 'project' and h ->> 'id' = '00000000-0000-4000-8000-00000000d001'),
  'case and word order do not matter');
select ok(
  exists (select 1 from jsonb_array_elements(public.search('ms')) h
          where h ->> 'kind' = 'project' and h ->> 'id' = '00000000-0000-4000-8000-00000000d001'),
  'a two-letter query matches at the start of a word');

-- ----------------------------------------------------------------------------
-- Kinds: project by code, by staff name, by donor; localities
-- ----------------------------------------------------------------------------
select is(
  (select public.search(p.code) -> 0 ->> 'id' from public.projects p
   where p.id = '00000000-0000-4000-8000-00000000d002'),
  '00000000-0000-4000-8000-00000000d002',
  'a project code finds its project first');
select is(
  (select h -> 'projects' -> 0 ->> 'id'
   from jsonb_array_elements(public.search('محمد بن خلفان')) h
   where h ->> 'kind' = 'staff'),
  '00000000-0000-4000-8000-00000000d002',
  'a staff name leads to the project the person works at');
select is(
  (select h -> 'projects' -> 0 ->> 'role'
   from jsonb_array_elements(public.search('khalfanqx')) h
   where h ->> 'kind' = 'staff'),
  'imam', 'staff hits carry the role (searching the Latin name)');
select is(
  (select jsonb_build_array(h -> 'projects' -> 0 -> 'id', h -> 'projects_count')
   from jsonb_array_elements(public.search('مؤسسة الخير')) h
   where h ->> 'kind' = 'donor'),
  jsonb_build_array('00000000-0000-4000-8000-00000000d002', 1),
  'a donor name leads to the donor''s project');
select ok(
  exists (select 1 from jsonb_array_elements(public.search('village tz_pemba')) h
          where h ->> 'kind' = 'locality' and h ->> 'id' = tests.id('loc:tz_pemba_north')::text),
  'localities are searchable');
select is(
  (select jsonb_agg(distinct h -> 'kind') from jsonb_array_elements(public.search('khairqx', 20, array['donor'])) h),
  '["donor"]'::jsonb, 'p_kinds restricts the kinds');
select is(
  public.search('khairqx', 20, array['project', 'locality', 'staff']), '[]'::jsonb,
  'the donor is not returned when its kind is not requested');

-- ----------------------------------------------------------------------------
-- Typo tolerance (only when nothing matches exactly), short and hostile input
-- ----------------------------------------------------------------------------
select ok(
  exists (select 1 from jsonb_array_elements(public.search('masjid rahmma')) h
          where h ->> 'kind' = 'project' and h ->> 'id' = '00000000-0000-4000-8000-00000000d002'),
  'a Latin typo still finds the project (trigram fallback)');
select ok(
  exists (select 1 from jsonb_array_elements(public.search('مسجد الرحمه الكبير')) h
          where h ->> 'kind' = 'project' and h ->> 'id' = '00000000-0000-4000-8000-00000000d002'),
  'an Arabic near-match still finds the project (trigram fallback)');
select is(public.search('م'), '[]'::jsonb, 'a one-character query returns []');
select is(public.search('   '), '[]'::jsonb, 'a blank query returns []');
select is(public.search(null), '[]'::jsonb, 'a null query returns []');
select is(public.search('%%'), '[]'::jsonb, 'LIKE wildcards in the query are matched literally');
select is(public.search('___'), '[]'::jsonb, 'underscores in the query are matched literally');
select is(public.search('a b'), '[]'::jsonb, 'single letters only: nothing to search for');
select lives_ok($$select public.search('c+ (x')$$, 'regular-expression characters in short words are harmless');
select ok(
  exists (select 1 from jsonb_array_elements(public.search('ms wa')) h
          where h ->> 'kind' = 'project' and h ->> 'id' = '00000000-0000-4000-8000-00000000d001'),
  'several short words: the first starts a word, the others must occur');

-- ----------------------------------------------------------------------------
-- Authorisation
-- ----------------------------------------------------------------------------
-- Viewers: projects yes, staff never.
select tests.login_as(tests.id('u_viewer_tz'), 'aal1');
select is(
  (select count(*)::int from jsonb_array_elements(public.search('محمد بن خلفان')) h where h ->> 'kind' = 'staff'),
  0, 'a viewer gets no staff hits by Arabic name');
select is(
  public.search('khalfanqx'), '[]'::jsonb,
  'a viewer gets nothing at all for a query that only matches staff');
select ok(
  exists (select 1 from jsonb_array_elements(public.search('rahma')) h
          where h ->> 'kind' = 'project' and h ->> 'id' = '00000000-0000-4000-8000-00000000d002'),
  'a viewer still finds projects');

-- Kenya never sees Tanzania.
select tests.login_as(tests.id('u_col_ke'), 'aal1');
select is(
  (select jsonb_agg(h ->> 'id' order by h ->> 'id')
   from jsonb_array_elements(public.search('احمد')) h),
  '["00000000-0000-4000-8000-00000000e003"]'::jsonb,
  'a Kenyan collector searching "احمد" only gets the Kenyan person');
-- Collect a broad set of hits as the Kenyan collector, then verify them as the
-- privileged role (so that the check itself does not depend on RLS).
select (public.search('اختبار', 50) || public.search('masjid', 50) || public.search('مصلى', 50)
        || public.search('donor', 50) || public.search('village', 50) || public.search('imam', 50))::text
       as ke_hits \gset
select tests.logout();
select ok(
  jsonb_array_length(:'ke_hits'::jsonb) >= 5,
  'a Kenyan collector does get Kenyan hits (project, locality, staff, donor)');
select is(
  (select count(*)::int
   from jsonb_array_elements(:'ke_hits'::jsonb) h
   left join public.projects p on h ->> 'kind' = 'project' and p.id = (h ->> 'id')::uuid
   left join public.localities l on h ->> 'kind' = 'locality' and l.id = (h ->> 'id')::uuid
   left join public.persons pe on h ->> 'kind' = 'staff' and pe.id = (h ->> 'id')::uuid
   where (h ->> 'kind' in ('project', 'locality', 'staff')
          and coalesce(p.country_id, l.country_id, pe.country_id) is distinct from tests.id('ke'))
      or exists (
           select 1
           from jsonb_array_elements(coalesce(h -> 'projects', '[]'::jsonb)) hp
           join public.projects pp on pp.id = (hp ->> 'id')::uuid
           where pp.country_id <> tests.id('ke'))),
  0, 'a Kenyan collector gets no hit that belongs to another country (projects, localities, staff, donors)');

-- Limit cap and ordering.
select tests.login_as(tests.id('u_hq'), 'aal2');
select is(jsonb_array_length(public.search('مصلى الزيتونة', 500)), 50, 'p_limit is capped at 50');
select is(
  (select bool_and(s.score >= s.next_score)
   from (select (h ->> 'score')::numeric as score,
                lead((h ->> 'score')::numeric) over (order by o) as next_score
         from jsonb_array_elements(public.search('مسجد')) with ordinality as e(h, o)) s
   where s.next_score is not null),
  true, 'hits are ordered by descending score');

select tests.logout();
select * from finish();
rollback;

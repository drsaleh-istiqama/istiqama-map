-- =============================================================================
-- 41  person_candidates (migration 0041; brief §2.4)
--     possible matches by phone / similar name / area, inside the caller's
--     scope, and NEVER an automatic merge.
-- =============================================================================
begin;
set local search_path = public, extensions, tests;

select plan(49);

select tests.fixture();

-- Precondition of every Arabic name test: the database must not use LC_CTYPE "C"
-- (pg_trgm then extracts no trigrams from non-ASCII text).
select isnt(show_trgm('محمد')::text, '{}',
  'pg_trgm extracts trigrams from Arabic text (database LC_CTYPE is not "C")');

-- ---------------------------------------------------------------------------
-- Test persons (ids ...a0NN)
--   a001  Pemba, home Pemba North, phone, works as teacher in p_pemba_1
--   a002  Pemba, same name written with tashkeel, home Tanga area
--   a003  Pemba, Arabic + Latin name (hamza forms), phone
--   a004  Tanga branch, same name as a001, phone
--   a005  Kenya, same name as a001
--   a006  Pemba, same name, soft-deleted
--   a007  Pemba, unrelated name
--   a008  Pemba, same name, already merged into a001 (source of an old merge)
--   a009  Pemba, a person known by a single name
-- ---------------------------------------------------------------------------
insert into public.persons
  (id, created_by, name_ar, name_latin, phone_e164, country_id, branch_id, home_admin_area_id, deleted_at, merged_into_id)
values
  ('00000000-0000-4000-8000-00000000a001', tests.id('u_col_pemba'), 'محمد بن سالم الحارثي', null,
   '+255711111111', tests.id('tz'), tests.id('br_pemba'), tests.id('tz_pemba_north'), null, null),
  ('00000000-0000-4000-8000-00000000a002', tests.id('u_col_pemba'), 'مُحَمَّد بن سَالِم الحارثيّ', null,
   null, tests.id('tz'), tests.id('br_pemba'), tests.id('tz_tanga'), null, null),
  ('00000000-0000-4000-8000-00000000a003', tests.id('u_col_pemba'), 'أحمد إبراهيم العلوي', 'Ahmad Ibrahim Al-Alawi',
   '+255722222222', tests.id('tz'), tests.id('br_pemba'), null, null, null),
  ('00000000-0000-4000-8000-00000000a004', tests.id('u_col_tanga'), 'محمد بن سالم الحارثي', null,
   '+255733333333', tests.id('tz'), tests.id('br_tanga'), tests.id('tz_tanga'), null, null),
  ('00000000-0000-4000-8000-00000000a005', tests.id('u_col_ke'), 'محمد بن سالم الحارثي', null,
   '+254744444444', tests.id('ke'), tests.id('br_mombasa'), tests.id('ke_mombasa'), null, null),
  ('00000000-0000-4000-8000-00000000a006', tests.id('u_col_pemba'), 'محمد بن سالم الحارثي', null,
   null, tests.id('tz'), tests.id('br_pemba'), null, now(), null),
  ('00000000-0000-4000-8000-00000000a007', tests.id('u_col_pemba'), 'خالد عبدالله المزروعي', 'Khalid Abdallah',
   null, tests.id('tz'), tests.id('br_pemba'), null, null, null),
  ('00000000-0000-4000-8000-00000000a008', tests.id('u_col_pemba'), 'محمد بن سالم الحارثي', null,
   null, tests.id('tz'), tests.id('br_pemba'), null, now(), '00000000-0000-4000-8000-00000000a001'),
  ('00000000-0000-4000-8000-00000000a009', tests.id('u_col_pemba'), 'جمعة', 'Juma',
   null, tests.id('tz'), tests.id('br_pemba'), null, null, null);

insert into public.project_staff (id, created_by, project_id, person_id, role, start_date)
values ('00000000-0000-4000-8000-00000000b001', tests.id('u_col_pemba'), tests.id('p_pemba_1'),
        '00000000-0000-4000-8000-00000000a001', 'teacher', date '2021-03-01');

-- state before any lookup (to prove that nothing is ever merged or changed)
create temp table t41_before as
select p.id, p.version, p.deleted_at, p.merged_into_id from public.persons p;
create temp table t41_counts as
select (select count(*) from public.person_merge_requests) as requests,
       (select count(*) from public.project_staff) as staff;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'public.person_candidates(text, text, uuid)', 'execute'),
  'anon cannot execute person_candidates');

select tests.login_as(tests.id('u_viewer_tz'), 'aal1');
select throws_ok(
  $$ select public.person_candidates('محمد بن سالم الحارثي', null, null) $$,
  'PT403', 'forbidden', 'viewer (country) is refused');
select tests.login_as(tests.id('u_viewer_global'), 'aal1');
select throws_ok(
  $$ select public.person_candidates('محمد بن سالم الحارثي', '+255711111111', null) $$,
  'PT403', 'forbidden', 'viewer (global) is refused');
select tests.logout();

-- ---------------------------------------------------------------------------
-- Pemba collector: similar Arabic name, with / without tashkeel and hamza
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('u_col_pemba'), 'aal1');

select public.person_candidates('محمد بن سالم الحارثي', null, tests.id('tz_pemba_north')) as r1 \gset

select is(jsonb_typeof(:'r1'::jsonb), 'array', 'the result is a JSON array');
select is(
  (select array_agg(e ->> 'id' order by e ->> 'id') from jsonb_array_elements(:'r1'::jsonb) e),
  array['00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a002'],
  'exact name: the two live Pemba persons (plain and with tashkeel); not Tanga, Kenya, deleted or merged rows');
select is(:'r1'::jsonb -> 0 ->> 'id', '00000000-0000-4000-8000-00000000a001',
  'the person whose home is the requested area is ranked first');
select is(:'r1'::jsonb -> 0 -> 'reasons', '["name", "area"]'::jsonb, 'reasons of the same-area match: name + area');
select is(:'r1'::jsonb -> 1 -> 'reasons', '["name"]'::jsonb, 'reasons of the other match: name only');
select is((:'r1'::jsonb -> 1 ->> 'similarity')::numeric, 1.000,
  'tashkeel is ignored: similarity 1 for the vowelled spelling');
select is(:'r1'::jsonb -> 0 ->> 'phone', '+255711111111', 'a collector sees the phone of a person in scope');
select is((:'r1'::jsonb -> 0 ->> 'phone_masked')::boolean, false, 'phone_masked is false for it');
select is(:'r1'::jsonb -> 0 -> 'roles', '["teacher"]'::jsonb, 'roles of the candidate are listed');
select is(:'r1'::jsonb -> 0 -> 'staff' -> 0 ->> 'project_id', tests.id('p_pemba_1')::text,
  'the projects the candidate works in are listed');
select is(:'r1'::jsonb -> 0 -> 'home_area' ->> 'id', tests.id('tz_pemba_north')::text, 'home area is returned');

-- same query, other area: ranking follows the area
select public.person_candidates('محمد بن سالم الحارثي', null, tests.id('tz_tanga')) as r2 \gset
select is(:'r2'::jsonb -> 0 ->> 'id', '00000000-0000-4000-8000-00000000a002',
  'with another requested area the person living there comes first');

-- typed WITH tashkeel, stored without
select public.person_candidates('مُحَمَّدٌ بنُ سالمٍ الحارثيُّ', null, null) as r3 \gset
select is(
  (select count(*)::int from jsonb_array_elements(:'r3'::jsonb) e
   where e ->> 'id' in ('00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a002')),
  2, 'a name typed with tashkeel finds the persons stored without it');

-- hamza forms: typed without hamza, stored with hamza; the person also has a Latin name
select public.person_candidates('احمد ابراهيم العلوي', null, null) as r4 \gset
select is(:'r4'::jsonb -> 0 ->> 'id', '00000000-0000-4000-8000-00000000a003',
  'alef without hamza matches the stored hamza forms');
select is((:'r4'::jsonb -> 0 ->> 'similarity')::numeric, 1.000,
  'a second (Latin) name on the person does not dilute the similarity');

-- Latin name with diacritics and different case
select public.person_candidates('ÁHMAD Ibrahím al-alawi', null, null) as r5 \gset
select is(:'r5'::jsonb -> 0 ->> 'id', '00000000-0000-4000-8000-00000000a003',
  'Latin names match case- and accent-insensitively');

-- ---------------------------------------------------------------------------
-- Threshold 0.6
-- ---------------------------------------------------------------------------
-- one letter differs: similarity 0.75
select public.person_candidates('محمد بن سالم الحارسي', null, null) as r6 \gset
select ok(
  (select count(*) from jsonb_array_elements(:'r6'::jsonb) e
   where e ->> 'id' = '00000000-0000-4000-8000-00000000a001'
     and (e ->> 'similarity')::numeric between 0.6 and 0.99) = 1,
  'a near miss above the threshold (0.75) is offered');

-- two of four words: similarity 0.48
select public.person_candidates('محمد سالم', null, null) as r7 \gset
select is(:'r7'::jsonb, '[]'::jsonb, 'a name below the threshold (0.48) is not offered');

select ok(
  not exists (
    select 1
    from jsonb_array_elements(:'r1'::jsonb || :'r3'::jsonb || :'r4'::jsonb || :'r5'::jsonb || :'r6'::jsonb) e
    where not (e -> 'reasons' ? 'phone') and (e ->> 'similarity')::numeric < 0.6),
  'no name-only candidate is ever below 0.6');

-- three of four words: similarity 0.62, just above the threshold
select public.person_candidates('محمد بن سالم', null, null) as r6b \gset
select ok(
  (select count(*) from jsonb_array_elements(:'r6b'::jsonb) e
   where e ->> 'id' = '00000000-0000-4000-8000-00000000a001'
     and (e ->> 'similarity')::numeric between 0.6 and 0.65) = 1,
  'a name just above the threshold (0.62) is offered');

-- a single word can only match a person whose whole name is that word
select is(public.person_candidates('محمد', null, null), '[]'::jsonb,
  'a single common first name matches nobody with a longer name');
select is(
  (select array_agg(e ->> 'id') from jsonb_array_elements(public.person_candidates('جمعه', null, null)) e),
  array['00000000-0000-4000-8000-00000000a009'],
  'a single-word name is found by its normalised form (teh marbuta = heh)');
select is(public.person_candidates('juma', null, null) -> 0 ->> 'id', '00000000-0000-4000-8000-00000000a009',
  'also by its Latin form');

-- the lookup table follows the person: rename, then search by the new name
select tests.logout();
update public.persons set name_latin = 'Jumaa Khamis Faki' where id = '00000000-0000-4000-8000-00000000a009';
select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select is(public.person_candidates('jumaa khamis faki', null, null) -> 0 ->> 'id', '00000000-0000-4000-8000-00000000a009',
  'a renamed person is found by the new name');
select is(public.person_candidates('juma', null, null), '[]'::jsonb, 'and no longer by the old one');

-- ---------------------------------------------------------------------------
-- Phone
-- ---------------------------------------------------------------------------
select public.person_candidates('اسم لا يشبه أحدا', '+255 711-111 111', null) as r8 \gset
select is(
  (select array_agg(e ->> 'id') from jsonb_array_elements(:'r8'::jsonb) e),
  array['00000000-0000-4000-8000-00000000a001'],
  'exact phone match (formatting ignored) even when the name is different');
select is(:'r8'::jsonb -> 0 -> 'reasons', '["phone"]'::jsonb, 'reason: phone');

select public.person_candidates(null, '00255711111111', null) as r9 \gset
select is(:'r9'::jsonb -> 0 ->> 'id', '00000000-0000-4000-8000-00000000a001',
  'the 00 international prefix is accepted');

-- phone + name: the phone match is ranked before the name matches
select public.person_candidates('أحمد إبراهيم العلوي', '+255711111111', null) as r10 \gset
select is(
  (select array_agg(e ->> 'id' order by o) from jsonb_array_elements(:'r10'::jsonb) with ordinality x(e, o)),
  array['00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a003'],
  'phone match first, then the similar name');

-- a phone that belongs to a person of another branch is outside the scope
select public.person_candidates(null, '+255733333333', null) as r11 \gset
select is(:'r11'::jsonb, '[]'::jsonb, 'a phone match outside the caller''s scope is not revealed');

-- nothing to search for
select is(public.person_candidates('  ', null, null), '[]'::jsonb, 'empty input returns an empty array');
select is(public.person_candidates('م', '123', null), '[]'::jsonb, 'one letter / too short a phone returns an empty array');

select tests.logout();

-- ---------------------------------------------------------------------------
-- Scope: other roles
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('u_col_ke'), 'aal1');
select public.person_candidates('محمد بن سالم الحارثي', '+255711111111', null) as r12 \gset
select is(
  (select array_agg(e ->> 'id') from jsonb_array_elements(:'r12'::jsonb) e),
  array['00000000-0000-4000-8000-00000000a005'],
  'a Kenyan collector only gets the Kenyan person (neither by name nor by phone anything from Tanzania)');

select tests.login_as(tests.id('u_mgr_tz'), 'aal2');
select public.person_candidates('محمد بن سالم الحارثي', null, null) as r13 \gset
select is(
  (select array_agg(e ->> 'id' order by e ->> 'id') from jsonb_array_elements(:'r13'::jsonb) e),
  array['00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a002',
        '00000000-0000-4000-8000-00000000a004'],
  'the Tanzania manager gets the persons of both Tanzanian branches, not Kenya');

-- a manager without MFA has no effective role
select tests.login_as(tests.id('u_mgr_tz'), 'aal1');
select throws_ok(
  $$ select public.person_candidates('محمد بن سالم الحارثي', null, null) $$,
  'PT403', 'forbidden', 'a country manager at aal1 (no MFA) is refused');

select tests.login_as(tests.id('u_hq'), 'aal2');
select public.person_candidates('محمد بن سالم الحارثي', null, null) as r14 \gset
select is(jsonb_array_length(:'r14'::jsonb), 4, 'hq_admin gets all four live persons with that name');
select tests.logout();

-- ---------------------------------------------------------------------------
-- The lookup table can be rebuilt from persons (bulk loads that bypass triggers)
-- ---------------------------------------------------------------------------
create temp table t41_names as
select n.person_id, n.script, n.name_norm, n.n_trgm, n.country_id, n.branch_id from private.person_names n;

select cmp_ok(private.person_names_rebuild(), '>=', 10::bigint, 'person_names_rebuild() rewrites the lookup table');
select set_eq(
  'select n.person_id, n.script, n.name_norm, n.n_trgm, n.country_id, n.branch_id from private.person_names n',
  'select * from t41_names',
  'the rebuilt table equals the trigger-maintained one');
select is(
  (select array_agg(n.script || ':' || n.name_norm order by n.script) from private.person_names n
   where n.person_id = '00000000-0000-4000-8000-00000000a003'),
  array['ar:احمد ابراهيم العلوي', 'latin:ahmad ibrahim al-alawi'],
  'one normalised row per script');

-- ---------------------------------------------------------------------------
-- The threshold follows app_settings "persons.name_similarity" (default 0.6)
-- ---------------------------------------------------------------------------
insert into public.app_settings (key, value)
values ('persons.name_similarity', '0.45'::jsonb)
on conflict (key) do update set value = excluded.value, deleted_at = null;

select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select ok(
  (select count(*) from jsonb_array_elements(public.person_candidates('محمد سالم', null, null)) e
   where e ->> 'id' = '00000000-0000-4000-8000-00000000a001') = 1,
  'with the setting lowered to 0.45 the 0.48 match is offered');
select tests.logout();

update public.app_settings set value = '0.6'::jsonb where key = 'persons.name_similarity';

-- ---------------------------------------------------------------------------
-- No automatic merge, ever
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int
   from public.persons p
   join t41_before b on b.id = p.id
   where p.id <> '00000000-0000-4000-8000-00000000a009'   -- renamed above by the test itself
     and (p.version is distinct from b.version
          or p.deleted_at is distinct from b.deleted_at
          or p.merged_into_id is distinct from b.merged_into_id)),
  0, 'no person row was changed, deleted or merged by any lookup');
select is(
  (select count(*) from public.persons), (select count(*) from t41_before),
  'no person row was created or removed');
select is(
  (select row((select count(*) from public.person_merge_requests), (select count(*) from public.project_staff))::text),
  (select row(c.requests, c.staff)::text from t41_counts c),
  'no merge request was created and no staff link was touched');

-- two rows with identical name and phone stay two persons (v2 merged them by name)
insert into public.persons (id, created_by, name_ar, phone_e164, country_id, branch_id)
values
  ('00000000-0000-4000-8000-00000000a011', tests.id('u_col_pemba'), 'سعيد بن ناصر', '+255755555555', tests.id('tz'), tests.id('br_pemba')),
  ('00000000-0000-4000-8000-00000000a012', tests.id('u_col_pemba'), 'سعيد بن ناصر', '+255755555555', tests.id('tz'), tests.id('br_pemba'));

select tests.login_as(tests.id('u_sup_pemba'), 'aal1');
select public.person_candidates('سعيد بن ناصر', '+255755555555', null) as r15 \gset
select tests.logout();

select is(jsonb_array_length(:'r15'::jsonb), 2, 'both identical persons are offered as candidates');
select is(
  (select count(*)::int from public.persons p
   where p.id in ('00000000-0000-4000-8000-00000000a011', '00000000-0000-4000-8000-00000000a012')
     and p.deleted_at is null and p.merged_into_id is null),
  2, 'identical name and phone are still two separate live persons');

select * from finish();
rollback;

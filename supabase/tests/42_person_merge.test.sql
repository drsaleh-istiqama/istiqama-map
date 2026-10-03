-- =============================================================================
-- 42  merge_persons / revert_person_merge / request_person_merge /
--     resolve_person_merge_request (migration 0042; brief §2.4, §3)
--
-- Persons (ids ...c0NN)        Staff (ids ...d0NN)                  Compensation (...e0NN)
--   c001 S  Pemba (source)       d001 S teacher p_pemba_1             e001 on d001
--   c002 T  Pemba (target)       d002 S imam    p_pemba_2             e002 on d002
--   c003 X  Tanga                d003 T teacher p_pemba_1  (same assignment as d001)
--   c004 K  Kenya                d004 T agent   p_pemba_2
--   c005 Y  Pemba                d005 S teacher p_pemba_2  (already soft-deleted)
--                                d006 X imam    p_tanga_1
-- =============================================================================
begin;
set local search_path = public, extensions, tests;

select plan(57);

select tests.fixture();

insert into public.persons
  (id, created_by, name_ar, phone_e164, gender, birth_year, education_level, country_id, branch_id)
values
  ('00000000-0000-4000-8000-00000000c001', tests.id('u_col_pemba'), 'ناصر بن حمد الريامي', '+255766666661', 'male', 1975, 'secondary', tests.id('tz'), tests.id('br_pemba')),
  ('00000000-0000-4000-8000-00000000c002', tests.id('u_col_pemba'), 'ناصر حمد الريامي', null, null, null, 'diploma', tests.id('tz'), tests.id('br_pemba')),
  ('00000000-0000-4000-8000-00000000c003', tests.id('u_col_tanga'), 'ناصر بن حمد الريامي', '+255766666663', null, null, null, tests.id('tz'), tests.id('br_tanga')),
  ('00000000-0000-4000-8000-00000000c004', tests.id('u_col_ke'), 'ناصر بن حمد الريامي', null, null, null, null, tests.id('ke'), tests.id('br_mombasa')),
  ('00000000-0000-4000-8000-00000000c005', tests.id('u_col_pemba'), 'ناصر الريامي', null, null, null, null, tests.id('tz'), tests.id('br_pemba'));

insert into public.project_staff (id, created_by, project_id, person_id, role, start_date, deleted_at)
values
  ('00000000-0000-4000-8000-00000000d001', tests.id('u_col_pemba'), tests.id('p_pemba_1'), '00000000-0000-4000-8000-00000000c001', 'teacher', null, null),
  ('00000000-0000-4000-8000-00000000d002', tests.id('u_col_pemba'), tests.id('p_pemba_2'), '00000000-0000-4000-8000-00000000c001', 'imam', date '2019-05-01', null),
  ('00000000-0000-4000-8000-00000000d003', tests.id('u_col_pemba'), tests.id('p_pemba_1'), '00000000-0000-4000-8000-00000000c002', 'teacher', date '2018-01-01', null),
  ('00000000-0000-4000-8000-00000000d004', tests.id('u_col_pemba'), tests.id('p_pemba_2'), '00000000-0000-4000-8000-00000000c002', 'agent', null, null),
  ('00000000-0000-4000-8000-00000000d005', tests.id('u_col_pemba'), tests.id('p_pemba_2'), '00000000-0000-4000-8000-00000000c001', 'teacher', null, now()),
  ('00000000-0000-4000-8000-00000000d006', tests.id('u_col_tanga'), tests.id('p_tanga_1'), '00000000-0000-4000-8000-00000000c003', 'imam', null, null);

insert into public.staff_compensation (id, created_by, project_staff_id, monthly_amount, currency, effective_from)
values
  ('00000000-0000-4000-8000-00000000e001', tests.id('u_col_pemba'), '00000000-0000-4000-8000-00000000d001', 100000, 'TZS', date '2025-01-01'),
  ('00000000-0000-4000-8000-00000000e002', tests.id('u_col_pemba'), '00000000-0000-4000-8000-00000000d002', 50000, 'TZS', date '2025-01-01');

-- the state every revert must restore exactly
create temp table t42_staff as
select s.id, s.project_id, s.person_id, s.role, s.start_date, s.end_date, (s.deleted_at is null) as live, s.version
from public.project_staff s
where s.id::text like '00000000-0000-4000-8000-00000000d0%';

create temp table t42_comp as
select c.id, c.project_staff_id, (c.deleted_at is null) as live
from public.staff_compensation c
where c.id::text like '00000000-0000-4000-8000-00000000e0%';

create temp table t42_persons as
select p.id, p.name_ar, p.name_latin, p.phone_e164, p.gender, p.birth_year, p.birth_date,
       p.home_admin_area_id, p.home_area_text, p.education_level, p.graduated_from,
       (p.deleted_at is null) as live, p.merged_into_id, p.version
from public.persons p
where p.id::text like '00000000-0000-4000-8000-00000000c0%';

-- ---------------------------------------------------------------------------
-- Privileges and authorisation
-- ---------------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.merge_persons(uuid, uuid, text)', 'execute')
  and not has_function_privilege('anon', 'public.revert_person_merge(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.request_person_merge(uuid, uuid, text)', 'execute')
  and not has_function_privilege('anon', 'public.resolve_person_merge_request(uuid, text, text)', 'execute'),
  'anon cannot execute any merge RPC');
select ok(
  not has_function_privilege('authenticated', 'private.merge_persons_apply(uuid, uuid, text, uuid)', 'execute'),
  'the internal worker is not executable by API roles');

select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select throws_ok(
  $$ select public.merge_persons('00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000c002', 'x') $$,
  'PT403', 'forbidden', 'a field collector cannot merge');

select tests.login_as(tests.id('u_viewer_global'), 'aal1');
select throws_ok(
  $$ select public.merge_persons('00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000c002', 'x') $$,
  'PT403', 'forbidden', 'a viewer cannot merge');

select tests.login_as(tests.id('u_mgr_ke'), 'aal2');
select throws_ok(
  $$ select public.merge_persons('00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000c002', 'x') $$,
  'PT403', 'forbidden', 'the Kenya manager cannot merge Tanzanian persons');

select tests.login_as(tests.id('u_mgr_tz'), 'aal1');
select throws_ok(
  $$ select public.merge_persons('00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000c002', 'x') $$,
  'PT403', 'forbidden', 'a country manager without MFA cannot merge');

select tests.login_as(tests.id('u_sup_pemba'), 'aal1');
select throws_ok(
  $$ select public.merge_persons('00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000c003', 'x') $$,
  'PT403', 'forbidden', 'a branch supervisor needs review rights over BOTH persons (Pemba + Tanga refused)');
select throws_ok(
  $$ select public.merge_persons('00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000c001', 'x') $$,
  'PT422', 'invalid_argument', 'a person cannot be merged into itself');
select throws_ok(
  $$ select public.merge_persons('00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-0000000fffff', 'x') $$,
  'PT404', 'person_not_found', 'unknown target person');

-- ---------------------------------------------------------------------------
-- Merge S -> T by the branch supervisor
-- ---------------------------------------------------------------------------
select public.merge_persons(
  '00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000c002', 'same teacher entered twice') as m1 \gset
select tests.logout();

select is(:'m1'::jsonb ->> 'state', 'merged', 'merge_persons returns state merged');
select is(
  (:'m1'::jsonb - 'request_id'),
  jsonb_build_object(
    'state', 'merged',
    'source_id', '00000000-0000-4000-8000-00000000c001',
    'target_id', '00000000-0000-4000-8000-00000000c002',
    'moved_staff', 1,
    'collapsed_staff', 1,
    'filled_fields', '["birth_year", "gender", "phone_e164"]'::jsonb),
  'one staff row moved, one duplicate assignment collapsed, three blank fields filled');

select is(
  (select row(p.deleted_at is not null, p.merged_into_id)::text
   from public.persons p where p.id = '00000000-0000-4000-8000-00000000c001'),
  row(true, '00000000-0000-4000-8000-00000000c002'::uuid)::text,
  'the source is soft-deleted and points to the target');
select is(
  (select row(s.person_id, s.deleted_at is null, s.updated_by)::text
   from public.project_staff s where s.id = '00000000-0000-4000-8000-00000000d002'),
  row('00000000-0000-4000-8000-00000000c002'::uuid, true, tests.id('u_sup_pemba'))::text,
  'the source''s assignment now belongs to the target (and is stamped with the supervisor)');
select is(
  (select row(s.person_id, s.deleted_at is not null)::text
   from public.project_staff s where s.id = '00000000-0000-4000-8000-00000000d001'),
  row('00000000-0000-4000-8000-00000000c001'::uuid, true)::text,
  'the duplicate assignment (same project and role as the target''s) is soft-deleted, not duplicated');
select is(
  (select c.project_staff_id from public.staff_compensation c where c.id = '00000000-0000-4000-8000-00000000e001'),
  '00000000-0000-4000-8000-00000000d003'::uuid,
  'its salary row follows the surviving assignment (which had none)');
select is(
  (select c.project_staff_id from public.staff_compensation c where c.id = '00000000-0000-4000-8000-00000000e002'),
  '00000000-0000-4000-8000-00000000d002'::uuid,
  'the salary row of the moved assignment stays on it');
select is(
  (select row(s.person_id, s.deleted_at is not null)::text
   from public.project_staff s where s.id = '00000000-0000-4000-8000-00000000d005'),
  row('00000000-0000-4000-8000-00000000c001'::uuid, true)::text,
  'an assignment that was already deleted is left alone');
select is(
  (select row(p.phone_e164, p.gender, p.birth_year, p.education_level)::text
   from public.persons p where p.id = '00000000-0000-4000-8000-00000000c002'),
  row('+255766666661'::text, 'male'::text, 1975::smallint, 'diploma'::text)::text,
  'blank fields of the target were filled from the source; existing values were kept');
select ok(
  (select p.version from public.persons p where p.id = '00000000-0000-4000-8000-00000000c002')
    > (select b.version from t42_persons b where b.id = '00000000-0000-4000-8000-00000000c002')
  and (select s.version from public.project_staff s where s.id = '00000000-0000-4000-8000-00000000d002')
    > (select b.version from t42_staff b where b.id = '00000000-0000-4000-8000-00000000d002'),
  'changed rows got a new version (devices receive them on the next pull)');
select is(
  (select row(q.state, q.source_person_id, q.target_person_id, q.decided_by, q.reason,
              q.undo -> 'moved_staff', jsonb_array_length(q.undo -> 'collapsed_staff'))::text
   from public.person_merge_requests q where q.id = (:'m1'::jsonb ->> 'request_id')::uuid),
  row('merged'::text, '00000000-0000-4000-8000-00000000c001'::uuid, '00000000-0000-4000-8000-00000000c002'::uuid,
      tests.id('u_sup_pemba'), 'same teacher entered twice'::text,
      '["00000000-0000-4000-8000-00000000d002"]'::jsonb, 1)::text,
  'the merge is recorded in person_merge_requests with its undo data');
select ok(
  exists (select 1 from public.audit_log a
          where a.table_name = 'persons' and a.row_id = '00000000-0000-4000-8000-00000000c001'
            and a.op = 'UPDATE' and a.user_id = tests.id('u_sup_pemba')
            and 'merged_into_id' = any (a.changed_fields)),
  'the merge is in the audit log under the supervisor''s name');

-- a merged person cannot be merged again, nor be a target
select tests.login_as(tests.id('u_sup_pemba'), 'aal1');
select throws_ok(
  $$ select public.merge_persons('00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000c002', 'again') $$,
  'PT409', 'person_already_merged', 'the source cannot be merged twice');
select throws_ok(
  $$ select public.merge_persons('00000000-0000-4000-8000-00000000c005', '00000000-0000-4000-8000-00000000c001', 'into a merged person') $$,
  'PT409', 'person_already_merged', 'a merged person cannot be a target');

-- ---------------------------------------------------------------------------
-- Revert
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select throws_ok(
  format($$ select public.revert_person_merge(%L) $$, :'m1'::jsonb ->> 'request_id'),
  'PT403', 'forbidden', 'a field collector cannot revert a merge');

select tests.login_as(tests.id('u_mgr_ke'), 'aal2');
select throws_ok(
  format($$ select public.revert_person_merge(%L) $$, :'m1'::jsonb ->> 'request_id'),
  'PT403', 'forbidden', 'the Kenya manager cannot revert a Tanzanian merge');

select tests.login_as(tests.id('u_sup_pemba'), 'aal1');
select public.revert_person_merge((:'m1'::jsonb ->> 'request_id')::uuid) as v1 \gset
select throws_ok(
  format($$ select public.revert_person_merge(%L) $$, :'m1'::jsonb ->> 'request_id'),
  'PT409', 'merge_not_revertible', 'a reverted merge cannot be reverted again');
select tests.logout();

select is(
  (select jsonb_build_object(
            'state', :'v1'::jsonb -> 'state',
            'restored_staff', :'v1'::jsonb -> 'restored_staff',
            'skipped_staff', :'v1'::jsonb -> 'skipped_staff',
            'restored_collapsed', :'v1'::jsonb -> 'restored_collapsed',
            'reset_fields', (select jsonb_agg(f order by f) from jsonb_array_elements_text(:'v1'::jsonb -> 'reset_fields') f))),
  jsonb_build_object(
    'state', 'reverted', 'restored_staff', 1, 'skipped_staff', 0, 'restored_collapsed', 1,
    'reset_fields', '["birth_year", "gender", "phone_e164"]'::jsonb),
  'revert_person_merge reports what it restored');

select results_eq(
  $$ select s.id, s.project_id, s.person_id, s.role, s.start_date, s.end_date, (s.deleted_at is null)
     from public.project_staff s
     where s.id::text like '00000000-0000-4000-8000-00000000d0%' order by s.id $$,
  $$ select b.id, b.project_id, b.person_id, b.role, b.start_date, b.end_date, b.live
     from t42_staff b order by b.id $$,
  'merge + revert restores every staff link exactly');
select results_eq(
  $$ select c.id, c.project_staff_id, (c.deleted_at is null)
     from public.staff_compensation c
     where c.id::text like '00000000-0000-4000-8000-00000000e0%' order by c.id $$,
  $$ select b.id, b.project_staff_id, b.live from t42_comp b order by b.id $$,
  'merge + revert restores every salary link exactly');
select results_eq(
  $$ select p.id, p.name_ar, p.name_latin, p.phone_e164, p.gender, p.birth_year, p.birth_date,
            p.home_admin_area_id, p.home_area_text, p.education_level, p.graduated_from,
            (p.deleted_at is null), p.merged_into_id
     from public.persons p
     where p.id::text like '00000000-0000-4000-8000-00000000c0%' order by p.id $$,
  $$ select b.id, b.name_ar, b.name_latin, b.phone_e164, b.gender, b.birth_year, b.birth_date,
            b.home_admin_area_id, b.home_area_text, b.education_level, b.graduated_from,
            b.live, b.merged_into_id
     from t42_persons b order by b.id $$,
  'merge + revert restores both persons exactly');
select is(
  (select row(q.state, q.undo ->> 'reverted_by')::text
   from public.person_merge_requests q where q.id = (:'m1'::jsonb ->> 'request_id')::uuid),
  row('reverted'::text, tests.id('u_sup_pemba')::text)::text,
  'the request is marked reverted and keeps the trail');

-- ---------------------------------------------------------------------------
-- Pending requests: propose (collector) -> reject / approve (reviewer)
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select public.request_person_merge(
  '00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000c002', 'looks like the same man') as q1 \gset
select is(:'q1'::jsonb - 'request_id', '{"state": "pending", "created": true}'::jsonb,
  'a collector can propose a merge (pending)');
select is(
  public.request_person_merge('00000000-0000-4000-8000-00000000c002', '00000000-0000-4000-8000-00000000c001', 'again'),
  jsonb_build_object('request_id', :'q1'::jsonb -> 'request_id', 'state', 'pending', 'created', false),
  'proposing the same pair again (either direction) returns the open request');
select throws_ok(
  $$ select public.request_person_merge('00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000c003', 'x') $$,
  'PT404', 'person_not_found', 'a person outside the caller''s scope looks like a missing person');
select throws_ok(
  format($$ select public.resolve_person_merge_request(%L, 'approve') $$, :'q1'::jsonb ->> 'request_id'),
  'PT403', 'forbidden', 'a collector cannot decide a request');
select tests.logout();

select is(
  (select count(*)::int from public.persons p
   where p.id = '00000000-0000-4000-8000-00000000c001' and p.deleted_at is null and p.merged_into_id is null),
  1, 'a pending request merges nothing');

select tests.login_as(tests.id('u_sup_pemba'), 'aal1');
select throws_ok(
  format($$ select public.resolve_person_merge_request(%L, 'maybe') $$, :'q1'::jsonb ->> 'request_id'),
  'PT422', 'invalid_argument', 'the decision must be approve or reject');
select is(
  public.resolve_person_merge_request((:'q1'::jsonb ->> 'request_id')::uuid, 'reject', 'different fathers') ->> 'state',
  'rejected', 'the supervisor rejects the request');
select throws_ok(
  format($$ select public.resolve_person_merge_request(%L, 'approve') $$, :'q1'::jsonb ->> 'request_id'),
  'PT409', 'request_not_pending', 'a decided request cannot be decided again');
select tests.logout();

select is(
  (select row(q.state, q.decided_by, q.undo ->> 'decision_note')::text
   from public.person_merge_requests q where q.id = (:'q1'::jsonb ->> 'request_id')::uuid),
  row('rejected'::text, tests.id('u_sup_pemba'), 'different fathers'::text)::text,
  'the rejection is recorded with who decided and the note');
select is(
  (select count(*)::int from public.persons p
   where p.id = '00000000-0000-4000-8000-00000000c001' and p.deleted_at is null and p.merged_into_id is null),
  1, 'a rejected request merges nothing');

select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select public.request_person_merge(
  '00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000c002', 'second opinion') as q2 \gset
select isnt(:'q2'::jsonb ->> 'request_id', :'q1'::jsonb ->> 'request_id', 'after a rejection a new request can be opened');

select tests.login_as(tests.id('u_sup_pemba'), 'aal1');
select public.resolve_person_merge_request((:'q2'::jsonb ->> 'request_id')::uuid, 'approve') as a2 \gset
select is(
  jsonb_build_object('request_id', :'a2'::jsonb -> 'request_id', 'state', :'a2'::jsonb -> 'state',
                     'moved_staff', :'a2'::jsonb -> 'moved_staff', 'collapsed_staff', :'a2'::jsonb -> 'collapsed_staff'),
  jsonb_build_object('request_id', :'q2'::jsonb -> 'request_id', 'state', 'merged', 'moved_staff', 1, 'collapsed_staff', 1),
  'approving performs the merge under the same request id');
select tests.logout();

select is(
  (select row(q.state, q.reason, q.created_by, q.decided_by)::text
   from public.person_merge_requests q where q.id = (:'q2'::jsonb ->> 'request_id')::uuid),
  row('merged'::text, 'second opinion'::text, tests.id('u_col_pemba'), tests.id('u_sup_pemba'))::text,
  'the approved request keeps its proposer and reason and records the decider');
select is(
  (select p.merged_into_id from public.persons p where p.id = '00000000-0000-4000-8000-00000000c001'),
  '00000000-0000-4000-8000-00000000c002'::uuid, 'the source is merged after approval');

select tests.login_as(tests.id('u_sup_pemba'), 'aal1');
select is(public.revert_person_merge((:'q2'::jsonb ->> 'request_id')::uuid) ->> 'state', 'reverted',
  'a merge made by approval can be reverted as well');
select tests.logout();

select results_eq(
  $$ select s.id, s.project_id, s.person_id, s.role, s.start_date, s.end_date, (s.deleted_at is null)
     from public.project_staff s
     where s.id::text like '00000000-0000-4000-8000-00000000d0%' order by s.id $$,
  $$ select b.id, b.project_id, b.person_id, b.role, b.start_date, b.end_date, b.live
     from t42_staff b order by b.id $$,
  'and the staff links are again exactly as before');

-- ---------------------------------------------------------------------------
-- Country manager: cross-branch merge, later edits survive a revert, and
-- chained merges must be reverted in reverse order
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('u_mgr_tz'), 'aal2');
select public.merge_persons(
  '00000000-0000-4000-8000-00000000c003', '00000000-0000-4000-8000-00000000c002', 'Tanga duplicate') as m3 \gset
select is(
  jsonb_build_object('state', :'m3'::jsonb -> 'state', 'moved_staff', :'m3'::jsonb -> 'moved_staff',
                     'filled_fields', :'m3'::jsonb -> 'filled_fields'),
  '{"state": "merged", "moved_staff": 1, "filled_fields": ["phone_e164"]}'::jsonb,
  'the country manager merges across branches (Tanga person into Pemba person)');
select tests.logout();

select is(
  (select s.person_id from public.project_staff s where s.id = '00000000-0000-4000-8000-00000000d006'),
  '00000000-0000-4000-8000-00000000c002'::uuid, 'the Tanga assignment now belongs to the target');

-- somebody corrects the phone that the merge copied
update public.persons set phone_e164 = '+255700009999' where id = '00000000-0000-4000-8000-00000000c002';

-- chain: T is merged into Y
select tests.login_as(tests.id('u_mgr_tz'), 'aal2');
select public.merge_persons(
  '00000000-0000-4000-8000-00000000c002', '00000000-0000-4000-8000-00000000c005', 'chain') as m4 \gset
select is((:'m4'::jsonb ->> 'moved_staff')::int, 3,
  'chained merge: all three live assignments of T (two own + one inherited) move on to Y');
select throws_ok(
  format($$ select public.revert_person_merge(%L) $$, :'m3'::jsonb ->> 'request_id'),
  'PT409', 'merge_not_revertible', 'the older merge cannot be reverted while its target is itself merged');
select is(public.revert_person_merge((:'m4'::jsonb ->> 'request_id')::uuid) ->> 'state', 'reverted',
  'the newer merge is reverted first');
select public.revert_person_merge((:'m3'::jsonb ->> 'request_id')::uuid) as v3 \gset
select is(
  jsonb_build_object('state', :'v3'::jsonb -> 'state', 'restored_staff', :'v3'::jsonb -> 'restored_staff',
                     'reset_fields', :'v3'::jsonb -> 'reset_fields'),
  '{"state": "reverted", "restored_staff": 1, "reset_fields": []}'::jsonb,
  'then the older one; the phone that was edited after the merge is not cleared');
select tests.logout();

select is(
  (select p.phone_e164 from public.persons p where p.id = '00000000-0000-4000-8000-00000000c002'),
  '+255700009999', 'the later edit of the target survived the revert');
select results_eq(
  $$ select s.id, s.person_id, (s.deleted_at is null)
     from public.project_staff s
     where s.id::text like '00000000-0000-4000-8000-00000000d0%' order by s.id $$,
  $$ select b.id, b.person_id, b.live from t42_staff b order by b.id $$,
  'after reverting the whole chain every assignment is back with its original person');
select is(
  (select count(*)::int from public.persons p
   where p.id::text like '00000000-0000-4000-8000-00000000c0%' and p.deleted_at is null and p.merged_into_id is null),
  5, 'all five test persons are live and unmerged again');

-- hq_admin may merge anything, including across countries
select tests.login_as(tests.id('u_hq'), 'aal2');
select is(
  public.merge_persons('00000000-0000-4000-8000-00000000c004', '00000000-0000-4000-8000-00000000c003', 'hq') ->> 'state',
  'merged', 'hq_admin can merge across countries');
select tests.logout();

select * from finish();
rollback;

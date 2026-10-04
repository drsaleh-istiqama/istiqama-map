-- =============================================================================
-- 55  Restricted-data leak regressions (migration 0075; brief §3, §11;
--     acceptance criterion 5)
--
--   A. sync_status(): open conflicts on restricted tables are an equality
--      oracle on blind writes; counted only for callers with restricted access
--      to the conflict's country.
--   B. audit_log: the audit image of a sync_conflicts row about a restricted
--      table (server_value / client_value) is hidden like the restricted
--      tables' own audit rows, even for hq_admin (log evasion).
--   C. merge_persons(): the ids of moved salary rows never appear in
--      person_merge_requests.undo (readable by supervisors); revert still moves
--      them back.
--   D. restricted_access_log cannot be forged or altered by API roles.
--   E. blind writes: invalid values are refused identically whether or not a
--      salary row exists for the natural key (currency guard on the probe row).
--
-- Extra rows: u_mgr_ke additionally holds field_collector on br_pemba (TZ);
-- persons ...ee001/ee002, staff ...ee101/ee102 on p_pemba_2, salary ...ee201.
-- =============================================================================
begin;
set local search_path = public, extensions, tests;

select plan(24);

select tests.fixture();

insert into public.user_roles (user_id, role, scope_type, scope_id)
values (tests.id('u_mgr_ke'), 'field_collector', 'branch', tests.id('br_pemba'));

create temp table t55 (k text primary key, v text);
grant all on t55 to authenticated;
insert into t55 values
  ('eff', (select effective_from::text from public.staff_compensation where id = tests.id('comp:p_pemba_1')));

create function pg_temp.t55_conf(p_user uuid) returns integer
language sql as $$
  select (jsonb_path_query_first(public.sync_status(), '$.users[*] ? (@.user_id == $u).open_conflicts',
                                 jsonb_build_object('u', p_user)))::text::integer
$$;

create function pg_temp.t55_push_salary(p_amount numeric) returns jsonb
language sql as $$
  select public.sync_push(jsonb_build_array(jsonb_build_object(
    'op_id', gen_random_uuid(), 'table', 'staff_compensation', 'id', gen_random_uuid(), 'kind', 'upsert',
    'fields', jsonb_build_object('project_staff_id', tests.id('staff:p_pemba_1'), 'monthly_amount', p_amount,
                                 'currency', 'TZS', 'effective_from', (select v from t55 where k = 'eff')))),
    'dev-ke')
$$;

-- ---------------------------------------------------------------------------
-- A. sync_status conflict counts
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('u_mgr_ke'), 'aal2', 'dev-ke');
select public.report_device_status('dev-ke', 0, 0, 'test');   -- the device row shown per device

select is(pg_temp.t55_conf(tests.id('u_mgr_ke')), 0, 'KE manager: baseline open_conflicts 0');

select is((pg_temp.t55_push_salary(250000) -> 'results' -> 0) - 'op_id',
  '{"status": "applied", "version": null}'::jsonb,
  'blind push of the stored TZ salary: constant answer');
select is((pg_temp.t55_push_salary(1) -> 'results' -> 0) - 'op_id',
  '{"status": "applied", "version": null}'::jsonb,
  'blind push of a different TZ salary: the same constant answer');

select is(pg_temp.t55_conf(tests.id('u_mgr_ke')), 0,
  'KE manager: his blind TZ conflict is not counted in sync_status (no equality oracle)');
select is((public.sync_status() -> 'summary' ->> 'open_conflicts')::integer, 0,
  'KE manager: summary open_conflicts does not count it either');
select is(
  (select sum((d ->> 'open_conflicts')::integer)::integer
   from jsonb_array_elements(public.sync_status() -> 'users') u,
        jsonb_array_elements(u -> 'devices') d),
  0, 'KE manager: per-device open_conflicts do not count it either');
select tests.logout();

select is(
  (select count(*)::integer from public.sync_conflicts
   where table_name = 'staff_compensation' and client_user_id = tests.id('u_mgr_ke') and state = 'open'),
  1, 'the blind write did store exactly one conflict (for a manager who may see it)');

select tests.login_as(tests.id('u_hq'), 'aal2', 'dev-hq');
select is(pg_temp.t55_conf(tests.id('u_mgr_ke')), 1, 'hq_admin: the restricted conflict is counted');
select tests.logout();

select tests.login_as(tests.id('u_mgr_tz'), 'aal2', 'dev-tz');
select is(pg_temp.t55_conf(tests.id('u_mgr_ke')), 1, 'TZ manager (aal2): the TZ restricted conflict is counted');
select tests.logout();

select tests.login_as(tests.id('u_mgr_tz'), 'aal1', 'dev-tz');
select throws_ok($$ select public.sync_status() $$, 'PT403', null, 'TZ manager at aal1: sync_status refused');
select tests.logout();

-- ---------------------------------------------------------------------------
-- B. audit_log side door
-- ---------------------------------------------------------------------------
select ok(
  (select count(*) from public.audit_log a
   where a.table_name = 'sync_conflicts' and a.new_data ->> 'table_name' = 'staff_compensation') > 0,
  'the conflict about a salary has audit rows');

create temp table t55_log as select coalesce(max(l.id), 0) as last_id from public.restricted_access_log l;

select tests.login_as(tests.id('u_hq'), 'aal2', 'dev-hq');
select is_empty(
  $$ select 1 from public.audit_log a
     where a.table_name = 'sync_conflicts'
       and coalesce(a.new_data ->> 'table_name', a.old_data ->> 'table_name')
           in ('staff_compensation', 'community_sensitive') $$,
  'hq_admin: audit rows of conflicts about restricted tables are hidden from direct SQL');
select is_empty(
  $$ select 1 from public.audit_log a where a.table_name in ('staff_compensation', 'community_sensitive') $$,
  'hq_admin: audit rows of the restricted tables stay hidden');
select isnt_empty(
  $$ select 1 from public.audit_log a where a.table_name = 'projects' $$,
  'hq_admin: other audit rows stay readable');
select tests.logout();

select is(
  (select count(*)::integer from public.restricted_access_log l where l.id > (select last_id from t55_log)),
  0, 'reading audit_log wrote no restricted_access_log row (and returned nothing restricted)');

-- ---------------------------------------------------------------------------
-- C. person merge undo
-- ---------------------------------------------------------------------------
insert into public.persons (id, created_by, name_ar, name_latin, country_id, branch_id) values
  ('00000000-0000-4000-8000-0000000ee001', tests.id('u_col_pemba'), 'مكرر أ', 'Dup A', tests.id('tz'), tests.id('br_pemba')),
  ('00000000-0000-4000-8000-0000000ee002', tests.id('u_col_pemba'), 'مكرر ب', 'Dup B', tests.id('tz'), tests.id('br_pemba'));
insert into public.project_staff (id, created_by, project_id, person_id, role) values
  ('00000000-0000-4000-8000-0000000ee101', tests.id('u_col_pemba'), tests.id('p_pemba_2'), '00000000-0000-4000-8000-0000000ee001', 'teacher'),
  ('00000000-0000-4000-8000-0000000ee102', tests.id('u_col_pemba'), tests.id('p_pemba_2'), '00000000-0000-4000-8000-0000000ee002', 'teacher');
insert into public.staff_compensation (id, created_by, project_staff_id, monthly_amount, currency)
values ('00000000-0000-4000-8000-0000000ee201', tests.id('u_mgr_tz'), '00000000-0000-4000-8000-0000000ee101', 123456, 'TZS');

select tests.login_as(tests.id('u_sup_pemba'), 'aal2', 'dev-sup');
insert into t55
select 'req', public.merge_persons('00000000-0000-4000-8000-0000000ee001',
                                   '00000000-0000-4000-8000-0000000ee002', 'dup') ->> 'request_id';
select is(
  (select r.undo -> 'collapsed_staff' from public.person_merge_requests r
   where r.id = (select v::uuid from t55 where k = 'req')),
  '[{"id": "00000000-0000-4000-8000-0000000ee101", "kept_id": "00000000-0000-4000-8000-0000000ee102"}]'::jsonb,
  'supervisor: undo.collapsed_staff names the assignments only (no salary row ids)');
select ok(
  not exists (select 1 from public.person_merge_requests r where r.undo::text like '%ee201%'
                                                            or r.undo::text like '%moved_compensation%'),
  'supervisor: no merge undo mentions a salary row');
select tests.logout();

select is(
  (select project_staff_id from public.staff_compensation where id = '00000000-0000-4000-8000-0000000ee201'),
  '00000000-0000-4000-8000-0000000ee102'::uuid, 'the merge moved the salary row to the kept assignment');
select is(
  (select comp_ids from private.person_merge_comp_moves where request_id = (select v::uuid from t55 where k = 'req')),
  array['00000000-0000-4000-8000-0000000ee201'::uuid], 'the moved salary row is recorded in the private table');

select tests.login_as(tests.id('u_sup_pemba'), 'aal2', 'dev-sup');
select is(public.revert_person_merge((select v::uuid from t55 where k = 'req')) ->> 'state', 'reverted',
  'supervisor: the merge can still be reverted');
select tests.logout();

select is(
  (select project_staff_id from public.staff_compensation where id = '00000000-0000-4000-8000-0000000ee201'),
  '00000000-0000-4000-8000-0000000ee101'::uuid, 'revert moved the salary row back to the restored assignment');

-- ---------------------------------------------------------------------------
-- E. blind writes: the answer to invalid values does not depend on whether a
--    salary row exists for the natural key (the soft-deleted probe row must
--    pass the same triggers as a real insert)
-- ---------------------------------------------------------------------------
create function pg_temp.t55_blind(p_eff text, p_extra jsonb) returns jsonb
language sql as $$
  select (public.sync_push(jsonb_build_array(jsonb_build_object(
    'op_id', gen_random_uuid(), 'table', 'staff_compensation', 'id', gen_random_uuid(), 'kind', 'upsert',
    'fields', jsonb_build_object('project_staff_id', tests.id('staff:p_pemba_1'), 'effective_from', p_eff)
              || p_extra)), 'dev-col') -> 'results' -> 0) - 'op_id'
$$;

select tests.login_as(tests.id('u_col_pemba'), 'aal2', 'dev-col');
select is(
  pg_temp.t55_blind((select v from t55 where k = 'eff'), '{"monthly_amount": 5, "currency": "XXX"}'),
  pg_temp.t55_blind('2023-05-05', '{"monthly_amount": 5, "currency": "XXX"}'),
  'collector: unmanaged currency on an existing salary key is refused exactly like on a free key');
select is(
  pg_temp.t55_blind((select v from t55 where k = 'eff'), '{"monthly_amount": 5, "currency": "XXX"}') ->> 'status',
  'rejected', 'collector: ... and it is rejected (check_violation), not answered "applied"');
select tests.logout();

-- ---------------------------------------------------------------------------
-- D. restricted_access_log integrity
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('u_hq'), 'aal2', 'dev-hq');
select throws_ok(
  $$ insert into public.restricted_access_log (user_id, table_name, row_ids, row_count, context)
     values (auth.uid(), 'staff_compensation', '{}', 0, 'forged') $$,
  '42501', null, 'hq_admin: cannot forge a restricted_access_log row');
select tests.logout();

select * from finish();
rollback;

-- =============================================================================
-- 47  Server fixes of the unit-4 review (migration 0072)
--
--   1. staff_compensation.currency: managed list (brief §0 — a country added
--      from the admin console records salaries in its own currency).
--   2. merge_localities / revert_locality_merge: a branch supervisor cannot
--      fold an approved locality nor move projects of other branches (brief §3).
--   3. Revoking sessions ends the Auth sessions (refresh tokens) in the
--      database; admin_end_auth_sessions for the service role.
-- =============================================================================
begin;
set local search_path = public, extensions, tests;

select plan(30);

select tests.fixture();

-- =============================================================================
-- 1. Managed currencies
-- =============================================================================
select ok(
  not has_function_privilege('authenticated', 'private.currency_is_managed(text)', 'execute')
  and not has_function_privilege('anon', 'private.currency_is_managed(text)', 'execute'),
  'currency_is_managed: internal helper');

select throws_ok(
  $$ insert into public.staff_compensation (project_staff_id, monthly_amount, currency, effective_from)
     values (tests.id('staff:p_pemba_2'), 1, 'ETB', date '2001-01-01') $$,
  '23514', 'new row for relation "staff_compensation" violates check constraint "staff_compensation_currency_ck"',
  'a currency nobody manages yet is refused with the former error');

-- a new country from the admin console, with its own currency and no fx rate
insert into public.countries (id, iso2, iso3, name_ar, name_en, name_sw, default_currency)
values ('00000000-0000-4000-8000-0000000e7001', 'ET', 'ETH', 'إثيوبيا', 'Ethiopia', 'Ethiopia', 'ETB');

select lives_ok(
  $$ insert into public.staff_compensation (project_staff_id, monthly_amount, currency, effective_from)
     values (tests.id('staff:p_pemba_2'), 5000, 'ETB', date '2001-01-01') $$,
  'the default currency of a country added at run time is accepted for salaries');

-- a currency that only has an exchange rate
insert into public.fx_rates (id, currency, usd_per_unit, effective_date)
values ('00000000-0000-4000-8000-0000000e7002', 'MWK', 0.00058, date '2025-06-01');
select lives_ok(
  $$ insert into public.staff_compensation (id, project_staff_id, monthly_amount, currency, effective_from)
     values ('00000000-0000-4000-8000-0000000e7003', tests.id('staff:p_pemba_2'), 90000, 'MWK', date '2001-02-01') $$,
  'a currency with a live fx rate is accepted');

select throws_ok(
  $$ insert into public.staff_compensation (project_staff_id, monthly_amount, currency, effective_from)
     values (tests.id('staff:p_pemba_2'), 1, 'et1', date '2001-03-01') $$,
  '23514', null,
  'a malformed code is refused');

-- the rate is withdrawn: the existing salary row stays editable (only a change
-- of currency is checked) ...
update public.fx_rates set deleted_at = now() where id = '00000000-0000-4000-8000-0000000e7002';
select lives_ok(
  $$ update public.staff_compensation set monthly_amount = 95000 where id = '00000000-0000-4000-8000-0000000e7003' $$,
  'an existing row keeps working when its currency leaves the managed list');
select lives_ok(
  $$ update public.staff_compensation set deleted_at = now() where id = '00000000-0000-4000-8000-0000000e7003' $$,
  '... and can be soft-deleted');
-- ... but a new one is refused
select throws_ok(
  $$ insert into public.staff_compensation (project_staff_id, monthly_amount, currency, effective_from)
     values (tests.id('staff:p_pemba_2'), 1, 'MWK', date '2001-04-01') $$,
  '23514', null,
  'a withdrawn rate no longer makes a currency managed');

select is(
  private.currency_is_managed('ETB') and private.currency_is_managed('USD')
    and not private.currency_is_managed('XYZ') and not private.currency_is_managed(null),
  true,
  'currency_is_managed: country currencies, brief currencies; unknown or null codes are not');

-- =============================================================================
-- 2. Locality merge across branches
-- =============================================================================
insert into public.localities (id, created_by, country_id, admin_area_id, name_ar, name_latin, geom, status)
values
  ('00000000-0000-4000-8000-00000000e101', tests.id('u_col_pemba'), tests.id('tz'), tests.id('tz_pemba_north'),
   'قرية معتمدة', 'Kijiji Rasmi', st_setsrid(st_makepoint(39.74, -5.00), 4326), 'approved'),
  ('00000000-0000-4000-8000-00000000e102', tests.id('u_col_pemba'), tests.id('tz'), tests.id('tz_pemba_north'),
   'قرية الهدف', 'Kijiji Lengo', st_setsrid(st_makepoint(39.75, -5.01), 4326), 'approved'),
  ('00000000-0000-4000-8000-00000000e103', tests.id('u_col_tanga'), tests.id('tz'), tests.id('tz_tanga'),
   'قرية تانغا المقترحة', 'Kijiji Tanga', st_setsrid(st_makepoint(39.10, -5.07), 4326), 'proposed'),
  ('00000000-0000-4000-8000-00000000e104', tests.id('u_col_pemba'), tests.id('tz'), tests.id('tz_pemba_north'),
   'قرية بيمبا المقترحة', 'Kijiji Pemba', st_setsrid(st_makepoint(39.751, -5.051), 4326), 'proposed');

update public.projects set locality_id = '00000000-0000-4000-8000-00000000e103' where id = tests.id('p_tanga_1');
update public.projects set locality_id = '00000000-0000-4000-8000-00000000e104' where id = tests.id('p_pemba_1');

create temp table t47 (k text primary key, v jsonb) on commit drop;
grant all on t47 to authenticated;

select tests.login_as(tests.id('u_sup_pemba'), 'aal1');
select throws_ok(
  $$ select public.merge_localities('00000000-0000-4000-8000-00000000e103', '00000000-0000-4000-8000-00000000e102') $$,
  'PT403', 'forbidden',
  'a branch supervisor cannot fold a locality used by a project of another branch');
select throws_ok(
  $$ select public.merge_localities('00000000-0000-4000-8000-00000000e101', '00000000-0000-4000-8000-00000000e102') $$,
  'PT403', 'forbidden',
  'a branch supervisor cannot fold an approved locality');
insert into t47 select 'sup', public.merge_localities(
  '00000000-0000-4000-8000-00000000e104', '00000000-0000-4000-8000-00000000e102');
select tests.logout();

select ok(
  (select p.locality_id from public.projects p where p.id = tests.id('p_tanga_1')) = '00000000-0000-4000-8000-00000000e103'
  and (select l.deleted_at is null from public.localities l where l.id = '00000000-0000-4000-8000-00000000e103')
  and (select l.deleted_at is null from public.localities l where l.id = '00000000-0000-4000-8000-00000000e101'),
  'the refused merges changed nothing (Tanga project and both localities untouched)');
select is(
  (select v - 'merge_id' from t47 where k = 'sup'),
  jsonb_build_object('source_id', '00000000-0000-4000-8000-00000000e104', 'target_id', '00000000-0000-4000-8000-00000000e102',
                     'projects_moved', 1, 'source_deleted', true),
  'a branch supervisor folds a proposed locality used only by his branch');

-- a soft-deleted project of another branch counts as well
update public.localities set deleted_at = null where id = '00000000-0000-4000-8000-00000000e104';
update public.projects set locality_id = '00000000-0000-4000-8000-00000000e104', deleted_at = now()
where id = tests.id('p_tanga_1');
select tests.login_as(tests.id('u_sup_pemba'), 'aal1');
select throws_ok(
  $$ select public.merge_localities('00000000-0000-4000-8000-00000000e104', '00000000-0000-4000-8000-00000000e102') $$,
  'PT403', 'forbidden',
  'a soft-deleted project of another branch also blocks a branch-level merge');
select tests.logout();
update public.projects set locality_id = '00000000-0000-4000-8000-00000000e103', deleted_at = null
where id = tests.id('p_tanga_1');
update public.localities set deleted_at = now() where id = '00000000-0000-4000-8000-00000000e104';

-- the country manager may do both
select tests.login_as(tests.id('u_mgr_tz'), 'aal2');
insert into t47 select 'mgr', public.merge_localities(
  '00000000-0000-4000-8000-00000000e103', '00000000-0000-4000-8000-00000000e102');
insert into t47 select 'mgr_approved', public.merge_localities(
  '00000000-0000-4000-8000-00000000e101', '00000000-0000-4000-8000-00000000e102');
select tests.logout();
select ok(
  (select (v ->> 'projects_moved')::int from t47 where k = 'mgr') = 1
  and (select p.locality_id = '00000000-0000-4000-8000-00000000e102' and p.updated_by = tests.id('u_mgr_tz')
       from public.projects p where p.id = tests.id('p_tanga_1'))
  and (select (v ->> 'source_deleted')::boolean from t47 where k = 'mgr_approved'),
  'the country manager folds a locality used across branches and an approved one');

-- undoing the manager's cross-branch merge is not for the branch supervisor
select tests.login_as(tests.id('u_sup_pemba'), 'aal1');
select throws_ok(
  format('select public.revert_locality_merge(%L)', (select v ->> 'merge_id' from t47 where k = 'mgr')),
  'PT403', 'forbidden',
  'revert: a branch supervisor cannot undo a merge that moved another branch''s project');
select throws_ok(
  format('select public.revert_locality_merge(%L)', (select v ->> 'merge_id' from t47 where k = 'mgr_approved')),
  'PT403', 'forbidden',
  'revert: a branch supervisor cannot restore an approved locality');
-- his own merge he may undo
select lives_ok(
  format('select public.revert_locality_merge(%L)', (select v ->> 'merge_id' from t47 where k = 'sup')),
  'revert: a branch supervisor undoes his own branch-level merge');
select tests.logout();
select is(
  (select p.locality_id from public.projects p where p.id = tests.id('p_pemba_1')),
  '00000000-0000-4000-8000-00000000e104'::uuid,
  'revert: the project of his branch is back on the restored locality');

select ok(
  not has_function_privilege('authenticated',
        'private.locality_merge_allowed(private.sync_ctx, uuid, text, uuid[])', 'execute'),
  'locality_merge_allowed: internal helper');

-- =============================================================================
-- 3. Auth sessions on revocation
-- =============================================================================
insert into auth.sessions (id, user_id, created_at, updated_at, aal)
values
  ('00000000-0000-4000-8000-00000000e201', tests.id('u_col_tanga'),  now(), now(), 'aal1'),
  ('00000000-0000-4000-8000-00000000e202', tests.id('u_col_tanga'),  now(), now(), 'aal1'),
  ('00000000-0000-4000-8000-00000000e203', tests.id('u_col_ke'),     now(), now(), 'aal1'),
  ('00000000-0000-4000-8000-00000000e204', tests.id('u_col_pemba2'), now(), now(), 'aal1'),
  ('00000000-0000-4000-8000-00000000e205', tests.id('u_col_pemba'),  now(), now(), 'aal1');
insert into auth.refresh_tokens (token, user_id, revoked, created_at, updated_at, session_id)
values
  ('rt-e201', tests.id('u_col_tanga')::text,  false, now(), now(), '00000000-0000-4000-8000-00000000e201'),
  ('rt-e202', tests.id('u_col_tanga')::text,  false, now(), now(), '00000000-0000-4000-8000-00000000e202'),
  ('rt-e203', tests.id('u_col_ke')::text,     false, now(), now(), '00000000-0000-4000-8000-00000000e203'),
  ('rt-e204', tests.id('u_col_pemba2')::text, false, now(), now(), '00000000-0000-4000-8000-00000000e204'),
  ('rt-e205', tests.id('u_col_pemba')::text,  false, now(), now(), '00000000-0000-4000-8000-00000000e205'),
  ('rt-orph', tests.id('u_col_tanga')::text,  false, now(), now(), null);

select ok(
  has_function_privilege('service_role', 'public.admin_end_auth_sessions(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.admin_end_auth_sessions(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.admin_end_auth_sessions(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.end_auth_sessions(uuid)', 'execute')
  and not has_function_privilege('service_role', 'private.end_auth_sessions(uuid)', 'execute'),
  'admin_end_auth_sessions: service role only; end_auth_sessions: internal');

select tests.login_as(tests.id('u_hq'), 'aal2');
select throws_ok(
  $$ select public.admin_end_auth_sessions(tests.id('u_col_ke')) $$,
  '42501', null,
  'an administrator''s JWT cannot call admin_end_auth_sessions directly');
select lives_ok(
  $$ select public.admin_revoke_sessions(tests.id('u_col_tanga')) $$,
  'hq revokes the sessions of a user (direct RPC call, no Edge Function)');
select lives_ok(
  $$ select public.admin_set_user_active(tests.id('u_col_pemba2'), false) $$,
  'hq deactivates a user');
select tests.logout();

select is(
  (select count(*)::int from auth.sessions s where s.user_id = tests.id('u_col_tanga'))
  + (select count(*)::int from auth.refresh_tokens t where t.user_id = tests.id('u_col_tanga')::text),
  0,
  'admin_revoke_sessions deleted the user''s Auth sessions and refresh tokens (no refresh afterwards)');
select is(
  (select count(*)::int from auth.refresh_tokens t where t.user_id = tests.id('u_col_pemba2')::text),
  0,
  'admin_set_user_active(false) deleted the user''s refresh tokens');
select is(
  (select count(*)::int from auth.refresh_tokens t where t.token in ('rt-e203', 'rt-e205')),
  2,
  'other users keep their sessions');

-- service role (the admin Edge Function)
select set_config('request.jwt.claims', '{"role": "service_role"}', true);
select set_config('role', 'service_role', true);
select is(public.admin_end_auth_sessions(tests.id('u_col_ke')), 1,
  'admin_end_auth_sessions (service role) answers the number of sessions ended');
select throws_ok(
  $$ select public.admin_end_auth_sessions(null) $$,
  'PT422', 'invalid_argument', 'admin_end_auth_sessions: the user id is required');
select tests.logout();
select is(
  (select count(*)::int from auth.refresh_tokens t where t.user_id = tests.id('u_col_ke')::text),
  0,
  'admin_end_auth_sessions removed the refresh tokens');

select * from finish();
rollback;

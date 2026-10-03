-- =============================================================================
-- 14  Session state and MFA (brief §3: MFA is mandatory for country_manager and
--     hq_admin; sessions of a user or device can be revoked at once)
--
--   * country_manager / hq_admin have no privileges at AAL1;
--   * a revoked session, a revoked device, an inactive or deleted profile and a
--     revoked role grant lose access immediately (next statement);
--   * the helpers fail closed without a JWT, without a profile, without `iat`.
-- =============================================================================
begin;
set local search_path = public, extensions, tests;

select plan(91);

select tests.fixture_extra();

-- -----------------------------------------------------------------------------
-- A. MFA
-- -----------------------------------------------------------------------------
select tests.login_as(tests.id('u_mgr_tz'), 'aal1');

select is(private.aal2(), false, 'manager at AAL1: aal2() is false');
select is(private.session_ok(), true, 'manager at AAL1: the session itself is valid');
select is_empty($$ select * from private.my_roles() $$, 'manager at AAL1: my_roles() is empty');
select is_empty($$ select 1 from public.projects $$, 'manager at AAL1: sees no project');
select is_empty($$ select 1 from public.persons $$, 'manager at AAL1: sees no person');
select is_empty($$ select 1 from public.project_staff $$, 'manager at AAL1: sees no staff');
select is_empty($$ select 1 from public.sync_conflicts $$, 'manager at AAL1: sees no conflict');
select is(private.read_countries(), '{}'::uuid[], 'manager at AAL1: empty read scope');
select is(private.restricted_countries(), '{}'::uuid[], 'manager at AAL1: empty restricted scope');
select is(private.can_see_restricted(tests.id('tz')), false, 'manager at AAL1: can_see_restricted() is false');
select is(private.can_write_project(tests.id('tz'), tests.id('br_pemba')), false, 'manager at AAL1: can_write_project() is false');
select is(tests.visible('profiles'), tests.ids('u_mgr_tz'), 'manager at AAL1: sees only the own profile');
select is(
  (select role from public.user_roles where user_id = auth.uid()), 'country_manager',
  'manager at AAL1: can still read the own role grant (the app then asks for MFA)');

select tests.login_as(tests.id('u_mgr_tz'), 'aal2');
select is(private.aal2(), true, 'manager at AAL2: aal2() is true');
select is(tests.visible('projects', tests.fixture_projects()), tests.ids('p_pemba_1', 'p_pemba_2', 'p_tanga_1'),
  'manager at AAL2: sees the projects of the country');
select is(private.restricted_countries(), array[tests.id('tz')], 'manager at AAL2: restricted scope = the country');

-- a token without the aal claim is not AAL2
select tests.set_claim('aal', 'null'::jsonb);
select is_empty($$ select 1 from public.projects $$, 'manager without aal claim: sees no project');

select tests.login_as(tests.id('u_hq'), 'aal1');
select is(private.is_hq(), false, 'hq_admin at AAL1: is_hq() is false');
select is(private.read_all(), false, 'hq_admin at AAL1: read_all() is false');
select is(private.restricted_all(), false, 'hq_admin at AAL1: restricted_all() is false');
select is_empty($$ select 1 from public.projects $$, 'hq_admin at AAL1: sees no project');
select is_empty($$ select 1 from public.persons $$, 'hq_admin at AAL1: sees no person');
select is_empty($$ select 1 from public.audit_log $$, 'hq_admin at AAL1: sees no audit log');
select is(tests.visible('profiles'), tests.ids('u_hq'), 'hq_admin at AAL1: sees only the own profile');
select throws_ok(
  $$ insert into public.countries (iso2, name_ar, name_en) values ('ZY', 'x', 'x') $$, '42501', null,
  'hq_admin at AAL1: cannot write reference data');
select is_empty(
  $$ update public.profiles set active = false where id = tests.id('u_col_ke') returning 1 $$,
  'hq_admin at AAL1: cannot manage users');

select tests.login_as(tests.id('u_hq'), 'aal2');
select is(private.is_hq(), true, 'hq_admin at AAL2: is_hq() is true');
select is(tests.visible('projects', tests.fixture_projects()),
  tests.ids('p_pemba_1', 'p_pemba_2', 'p_tanga_1', 'p_ke_1'), 'hq_admin at AAL2: sees every project');

-- roles that do not require MFA work at both levels
select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select is(tests.visible('projects'), tests.ids('p_pemba_1', 'p_pemba_2'), 'field_collector at AAL1: works');
select tests.login_as(tests.id('u_col_pemba'), 'aal2');
select is(tests.visible('projects'), tests.ids('p_pemba_1', 'p_pemba_2'), 'field_collector at AAL2: works');
select tests.login_as(tests.id('u_sup_pemba'), 'aal1');
select is(tests.visible('projects'), tests.ids('p_pemba_1', 'p_pemba_2'), 'branch_supervisor at AAL1: works');

-- -----------------------------------------------------------------------------
-- B. Session revocation (profiles.sessions_revoked_at vs. JWT iat)
-- -----------------------------------------------------------------------------
select tests.logout();
update public.profiles set sessions_revoked_at = now() + interval '1 minute' where id = tests.id('u_col_pemba');

-- the token below was issued "now", i.e. before the revocation instant
select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select is(private.session_ok(), false, 'revoked session: session_ok() is false');
select is_empty($$ select * from private.my_roles() $$, 'revoked session: my_roles() is empty');
select is_empty($$ select 1 from public.projects $$, 'revoked session: sees no project');
select is_empty($$ select 1 from public.persons $$, 'revoked session: sees no person');
select is_empty($$ select 1 from public.project_photos $$, 'revoked session: sees no photo row');
select is_empty($$ select 1 from public.donors $$, 'revoked session: sees no donor (not even the own one)');
select is_empty($$ select 1 from public.countries $$, 'revoked session: sees no reference data');
select is_empty($$ select 1 from public.app_settings $$, 'revoked session: sees no setting');
select is_empty($$ select 1 from public.profiles $$, 'revoked session: sees no profile, not even the own');
select is_empty($$ select 1 from public.user_roles $$, 'revoked session: sees no role grant');
select is_empty($$ select 1 from public.notifications $$, 'revoked session: sees no notification');
select is_empty($$ select 1 from public.export_jobs $$, 'revoked session: sees no export job');
select is_empty($$ select 1 from public.devices $$, 'revoked session: sees no device');
select is_empty(
  $$ update public.profiles set full_name = 'x' where id = auth.uid() returning 1 $$,
  'revoked session: cannot update the own profile');
select is(private.can_write_project(tests.id('tz'), tests.id('br_pemba')), false,
  'revoked session: can_write_project() is false');
select is(private.read_branches(), '{}'::uuid[], 'revoked session: empty read scope');

-- a token without iat fails closed while a revocation is recorded
select tests.set_claim('iat', 'null'::jsonb);
select is(private.session_ok(), false, 'token without iat after a revocation: session_ok() is false');
select is_empty($$ select 1 from public.projects $$, 'token without iat after a revocation: sees no project');

-- a token issued after the revocation instant (fresh sign-in) works again
select tests.set_claim('iat', to_jsonb(extract(epoch from now() + interval '2 minutes')::bigint));
select is(private.session_ok(), true, 'token issued after the revocation: session_ok() is true');
select is(tests.visible('projects'), tests.ids('p_pemba_1', 'p_pemba_2'), 'token issued after the revocation: access is back');

-- other users are not affected
select tests.login_as(tests.id('u_col_pemba2'), 'aal1');
select is(tests.visible('projects'), tests.ids('p_pemba_1', 'p_pemba_2'), 'revocation of one user does not affect a colleague');

-- -----------------------------------------------------------------------------
-- C. Device revocation (devices.revoked_at, device from the x-device-id header)
-- -----------------------------------------------------------------------------
select tests.logout();
insert into public.devices (user_id, device_id, label, revoked_at)
values (tests.id('u_col_ke'), 'dev-lost-phone', 'Lost phone', now());

select tests.login_as(tests.id('u_col_ke'), 'aal1', 'dev-lost-phone');
select is(private.device_id(), 'dev-lost-phone', 'the device id comes from the x-device-id header');
select is(private.session_ok(), false, 'revoked device: session_ok() is false');
select is_empty($$ select 1 from public.projects $$, 'revoked device: sees no project');
select is_empty($$ select 1 from public.persons $$, 'revoked device: sees no person');
select is_empty($$ select 1 from public.countries $$, 'revoked device: sees no reference data');
select is_empty($$ select 1 from public.profiles $$, 'revoked device: sees no profile');
select is(private.can_write_project(tests.id('ke'), tests.id('br_mombasa')), false,
  'revoked device: can_write_project() is false');

select tests.login_as(tests.id('u_col_ke'), 'aal1', 'dev-u_col_ke');
select is(private.session_ok(), true, 'same user on a device that is not revoked: session_ok() is true');
select is(tests.visible('projects'), tests.ids('p_ke_1'), 'same user on another device: works');

select tests.login_as(tests.id('u_col_pemba2'), 'aal1', 'dev-lost-phone');
select is(tests.visible('projects'), tests.ids('p_pemba_1', 'p_pemba_2'),
  'a revoked device id of one user does not block another user');

-- server-side fallback: app.device_id
select tests.login_as(tests.id('u_col_ke'), 'aal1', null);
select is(private.session_ok(), true, 'no device header: the session is judged by profile and token only');
set local app.device_id = 'dev-lost-phone';
select is(private.session_ok(), false, 'revoked device through the app.device_id setting: session_ok() is false');
set local app.device_id = '';

-- -----------------------------------------------------------------------------
-- D. Inactive, deleted and missing profiles
-- -----------------------------------------------------------------------------
select tests.logout();
update public.profiles set active = false where id = tests.id('u_col_tanga');

select tests.login_as(tests.id('u_col_tanga'), 'aal1');
select is(private.session_ok(), false, 'inactive profile: session_ok() is false');
select is_empty($$ select * from private.my_roles() $$, 'inactive profile: my_roles() is empty');
select is_empty($$ select 1 from public.projects $$, 'inactive profile: sees no project');
select is_empty($$ select 1 from public.persons $$, 'inactive profile: sees no person');
select is_empty($$ select 1 from public.countries $$, 'inactive profile: sees no reference data');
select is_empty($$ select 1 from public.profiles $$, 'inactive profile: sees no profile');
select is_empty(
  $$ update public.profiles set active = true where id = auth.uid() returning 1 $$,
  'inactive profile: cannot reactivate itself');

select tests.logout();
update public.profiles set active = true where id = tests.id('u_col_tanga');
select tests.login_as(tests.id('u_col_tanga'), 'aal1');
select is(tests.visible('projects'), tests.ids('p_tanga_1'), 'reactivated profile: access is back');

select tests.logout();
update public.profiles set deleted_at = now() where id = tests.id('u_col_tanga');
select tests.login_as(tests.id('u_col_tanga'), 'aal1');
select is(private.session_ok(), false, 'soft-deleted profile: session_ok() is false');
select is_empty($$ select 1 from public.projects $$, 'soft-deleted profile: sees no project');

-- a valid JWT whose subject has no profile at all
select tests.login_as(tests._uuid('user:ghost@example.org'), 'aal2');
select is(private.session_ok(), false, 'no profile: session_ok() is false');
select is_empty($$ select 1 from public.projects $$, 'no profile: sees no project');
select is_empty($$ select 1 from public.countries $$, 'no profile: sees no reference data');

-- -----------------------------------------------------------------------------
-- E. Revoked role grant (soft delete)
-- -----------------------------------------------------------------------------
select tests.logout();
update public.user_roles set deleted_at = now() where user_id = tests.id('u_sup_pemba');

select tests.login_as(tests.id('u_sup_pemba'), 'aal1');
select is(private.session_ok(), true, 'revoked role grant: the session itself stays valid');
select is_empty($$ select * from private.my_roles() $$, 'revoked role grant: my_roles() is empty');
select is_empty($$ select 1 from public.projects $$, 'revoked role grant: sees no project');
select is_empty($$ select 1 from public.sync_conflicts $$, 'revoked role grant: sees no conflict');
select isnt_empty($$ select 1 from public.countries $$, 'revoked role grant: reference data stays readable');

-- -----------------------------------------------------------------------------
-- F. No JWT at all / anon / trusted callers
-- -----------------------------------------------------------------------------
select tests.logout();
select is(private.session_ok(), false, 'no JWT: session_ok() is false');
select is_empty($$ select * from private.my_roles() $$, 'no JWT: my_roles() is empty');
select is(private.read_all() or private.is_hq() or private.restricted_all(), false, 'no JWT: no capability');
select is(private.can_read_project(tests.id('tz'), tests.id('br_pemba')), false, 'no JWT: can_read_project() is false');
select is(private.can_read_project(null, null), false, 'can_read_project(null, null) is false, not null');
select results_eq(
  $$ select country_id, branch_id, created_by, record_state from private.project_scope(tests.id('p_pemba_2')) $$,
  $$ values (tests.id('tz'), tests.id('br_pemba'), tests.id('u_col_pemba'), 'draft'::text) $$,
  'project_scope() returns the scope facts of a project to trusted callers');

select tests.login_as(tests.id('u_hq'), 'aal2');
select throws_ok(
  $$ select * from private.project_scope(tests.id('p_pemba_2')) $$, '42501', null,
  'project_scope() is not executable by API roles, not even hq_admin');

select tests.login_anon();
select throws_ok($$ select private.read_all() $$, '42501', null, 'anon: cannot call the private helpers');
select throws_ok($$ select private.session_ok() $$, '42501', null, 'anon: cannot call session_ok()');

select tests.logout();
select * from finish();
rollback;

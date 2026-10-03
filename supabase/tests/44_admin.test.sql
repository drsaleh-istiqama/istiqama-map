-- =============================================================================
-- 44  Administration RPCs (migration 0044; brief §3)
--     admin_users, admin_set_role, admin_remove_role, admin_set_user_active,
--     admin_revoke_sessions, admin_restore_device
-- =============================================================================
begin;
set local search_path = public, extensions, tests;

select plan(79);

select tests.fixture();

-- u_hq must be the only hq_admin for the "last administrator" checks
update public.user_roles set deleted_at = now()
where role = 'hq_admin' and deleted_at is null and user_id <> tests.id('u_hq');

select tests.create_user('t44_new@example.org', null, null, null) as new_user \gset
select ur.id as hq_role from public.user_roles ur
where ur.user_id = tests.id('u_hq') and ur.role = 'hq_admin' and ur.deleted_at is null \gset

insert into public.devices (user_id, device_id, label)
values
  (tests.id('u_col_pemba'), 'dev-lost', 'Lost phone'),
  (tests.id('u_col_pemba'), 'dev-ok', 'Office tablet'),
  (tests.id('u_col_ke'), 'dev-ke', 'Kenya phone')
on conflict (user_id, device_id) do update set revoked_at = null, deleted_at = null;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.admin_users(text, integer)', 'execute')
  and not has_function_privilege('anon', 'public.admin_set_role(uuid, text, text, uuid)', 'execute')
  and not has_function_privilege('anon', 'public.admin_remove_role(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.admin_set_user_active(uuid, boolean)', 'execute')
  and not has_function_privilege('anon', 'public.admin_revoke_sessions(uuid, text)', 'execute')
  and not has_function_privilege('anon', 'public.admin_restore_device(uuid, text)', 'execute'),
  'anon cannot execute any administration RPC');
select ok(
  not has_function_privilege('authenticated', 'private.admin_scope(boolean)', 'execute'),
  'the authorisation gate itself is not callable by API roles');

-- ---------------------------------------------------------------------------
-- Non-administrators are refused everywhere
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select throws_ok($$ select public.admin_users() $$, 'PT403', 'forbidden', 'collector: admin_users refused');
select throws_ok(
  $$ select public.admin_set_role(tests.id('u_col_pemba'), 'hq_admin', 'global', null) $$,
  'PT403', 'forbidden', 'collector: cannot grant roles (not even to himself)');
select throws_ok(
  format($$ select public.admin_remove_role(%L) $$, :'hq_role'),
  'PT403', 'forbidden', 'collector: cannot remove roles');
select throws_ok(
  $$ select public.admin_set_user_active(tests.id('u_col_tanga'), false) $$,
  'PT403', 'forbidden', 'collector: cannot deactivate users');
select throws_ok(
  $$ select public.admin_revoke_sessions(tests.id('u_col_tanga')) $$,
  'PT403', 'forbidden', 'collector: cannot revoke sessions');
select throws_ok(
  $$ select public.admin_restore_device(tests.id('u_col_pemba'), 'dev-lost') $$,
  'PT403', 'forbidden', 'collector: cannot restore devices');

select tests.login_as(tests.id('u_sup_pemba'), 'aal1');
select throws_ok($$ select public.admin_users() $$, 'PT403', 'forbidden', 'supervisor: admin_users refused');
select throws_ok(
  $$ select public.admin_revoke_sessions(tests.id('u_col_pemba')) $$,
  'PT403', 'forbidden', 'supervisor: cannot revoke sessions');

select tests.login_as(tests.id('u_viewer_global'), 'aal2');
select throws_ok($$ select public.admin_users() $$, 'PT403', 'forbidden', 'viewer: admin_users refused');

select tests.login_as(tests.id('u_mgr_tz'), 'aal2');
select throws_ok(
  $$ select public.admin_set_role(tests.id('u_col_tanga'), 'branch_supervisor', 'branch', tests.id('br_tanga')) $$,
  'PT403', 'forbidden', 'country manager: cannot grant roles');
select throws_ok(
  format($$ select public.admin_remove_role(%L) $$, :'hq_role'),
  'PT403', 'forbidden', 'country manager: cannot remove roles');
select throws_ok(
  $$ select public.admin_set_user_active(tests.id('u_col_tanga'), false) $$,
  'PT403', 'forbidden', 'country manager: cannot deactivate users');
select throws_ok(
  $$ select public.admin_restore_device(tests.id('u_col_pemba'), 'dev-lost') $$,
  'PT403', 'forbidden', 'country manager: cannot restore devices');

-- administrators without MFA get a specific answer
select tests.login_as(tests.id('u_hq'), 'aal1');
select throws_ok($$ select public.admin_users() $$, 'PT403', 'mfa_required', 'hq_admin at aal1: MFA required');
select throws_ok(
  $$ select public.admin_set_role(tests.id('u_col_tanga'), 'viewer', 'global', null) $$,
  'PT403', 'mfa_required', 'hq_admin at aal1 cannot grant roles');
select tests.login_as(tests.id('u_mgr_tz'), 'aal1');
select throws_ok($$ select public.admin_users() $$, 'PT403', 'mfa_required', 'country manager at aal1: MFA required');
select tests.logout();

-- ---------------------------------------------------------------------------
-- admin_users
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('u_hq'), 'aal2');
select public.admin_users() as au \gset
select is(jsonb_typeof(:'au'::jsonb), 'array', 'admin_users returns a JSON array');
select is(
  (select count(*)::int from jsonb_array_elements(:'au'::jsonb) e
   where (e ->> 'id')::uuid = any (tests.fixture_users())),
  10, 'hq_admin sees every user');
select is(
  (select jsonb_build_object(
            'email', e -> 'email', 'active', e -> 'active', 'preferred_language', e -> 'preferred_language',
            'role', e -> 'roles' -> 0 -> 'role', 'scope_type', e -> 'roles' -> 0 -> 'scope_type',
            'scope_id', e -> 'roles' -> 0 -> 'scope_id', 'scope_name_en', e -> 'roles' -> 0 -> 'scope_name_en',
            'country_id', e -> 'roles' -> 0 -> 'country_id', 'has_last_sign_in', e ? 'last_sign_in_at',
            'devices', (select jsonb_agg(d ->> 'device_id' order by d ->> 'device_id')
                        from jsonb_array_elements(e -> 'devices') d
                        where d ->> 'device_id' in ('dev-lost', 'dev-ok')))
   from jsonb_array_elements(:'au'::jsonb) e where (e ->> 'id')::uuid = tests.id('u_col_pemba')),
  jsonb_build_object(
    'email', 'u_col_pemba@example.org', 'active', true, 'preferred_language', 'ar',
    'role', 'field_collector', 'scope_type', 'branch', 'scope_id', tests.id('br_pemba'),
    'scope_name_en', 'Pemba branch (test)', 'country_id', tests.id('tz'), 'has_last_sign_in', true,
    'devices', '["dev-lost", "dev-ok"]'::jsonb),
  'a user entry carries e-mail, state, roles with scope names, last sign-in and devices');
select is(
  (select array_agg(e ->> 'full_name' order by e ->> 'full_name')
   from jsonb_array_elements(public.admin_users('U_COL_PEM')) e),
  array['u_col_pemba', 'u_col_pemba2'], 'admin_users(search) filters by name (case-insensitive)');
select is(jsonb_array_length(public.admin_users(null, 3)), 3, 'admin_users(limit) limits the list');

select tests.login_as(tests.id('u_mgr_tz'), 'aal2');
select public.admin_users() as am \gset
select is(
  (select array_agg(e ->> 'full_name' order by e ->> 'full_name') from jsonb_array_elements(:'am'::jsonb) e
   where (e ->> 'id')::uuid = any (tests.fixture_users())),
  array['u_col_pemba', 'u_col_pemba2', 'u_col_tanga', 'u_mgr_tz', 'u_sup_pemba', 'u_viewer_tz'],
  'the Tanzania manager sees the users of Tanzania only (no HQ, no Kenya, no global viewer)');
select tests.logout();

-- ---------------------------------------------------------------------------
-- admin_set_role: validation
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('u_hq'), 'aal2');
select throws_ok(
  format($$ select public.admin_set_role(%L, 'superuser', 'global', null) $$, :'new_user'),
  'PT422', 'invalid_role_scope', 'unknown role');
select throws_ok(
  format($$ select public.admin_set_role(%L, 'viewer', 'planet', null) $$, :'new_user'),
  'PT422', 'invalid_role_scope', 'unknown scope type');
select throws_ok(
  format($$ select public.admin_set_role(%L, 'hq_admin', 'country', tests.id('tz')) $$, :'new_user'),
  'PT422', 'invalid_role_scope', 'hq_admin must be global');
select throws_ok(
  format($$ select public.admin_set_role(%L, 'country_manager', 'branch', tests.id('br_pemba')) $$, :'new_user'),
  'PT422', 'invalid_role_scope', 'country_manager needs a country scope');
select throws_ok(
  format($$ select public.admin_set_role(%L, 'country_manager', 'global', null) $$, :'new_user'),
  'PT422', 'invalid_role_scope', 'country_manager cannot be global');
select throws_ok(
  format($$ select public.admin_set_role(%L, 'branch_supervisor', 'country', tests.id('tz')) $$, :'new_user'),
  'PT422', 'invalid_role_scope', 'branch_supervisor needs a branch scope');
select throws_ok(
  format($$ select public.admin_set_role(%L, 'field_collector', 'global', null) $$, :'new_user'),
  'PT422', 'invalid_role_scope', 'field_collector cannot be global');
select throws_ok(
  format($$ select public.admin_set_role(%L, 'viewer', 'global', tests.id('tz')) $$, :'new_user'),
  'PT422', 'invalid_role_scope', 'a global scope has no scope id');
select throws_ok(
  format($$ select public.admin_set_role(%L, 'branch_supervisor', 'branch', null) $$, :'new_user'),
  'PT422', 'invalid_role_scope', 'a branch scope requires a branch');
select throws_ok(
  format($$ select public.admin_set_role(%L, 'branch_supervisor', 'branch', tests.id('tz')) $$, :'new_user'),
  'PT422', 'invalid_role_scope', 'the branch must exist (a country id is not a branch)');
select throws_ok(
  format($$ select public.admin_set_role(%L, 'viewer', 'country', '00000000-0000-4000-8000-0000000fffff') $$, :'new_user'),
  'PT422', 'invalid_role_scope', 'the country must exist');
select throws_ok(
  $$ select public.admin_set_role('00000000-0000-4000-8000-0000000fffff', 'viewer', 'global', null) $$,
  'PT404', 'user_not_found', 'unknown user');

-- valid grants
select public.admin_set_role(:'new_user', 'viewer', 'global', null) as g1 \gset
select is(:'g1'::jsonb - 'id',
  jsonb_build_object('user_id', :'new_user'::uuid, 'role', 'viewer', 'scope_type', 'global', 'scope_id', null, 'created', true),
  'a viewer may be global');
select is(
  public.admin_set_role(:'new_user', 'viewer', 'global', null),
  (:'g1'::jsonb - 'created') || '{"created": false}'::jsonb,
  'granting the same role again is idempotent (same grant, created = false)');

select public.admin_set_role(:'new_user', 'branch_supervisor', 'branch', tests.id('br_tanga')) as g2 \gset
select is((:'g2'::jsonb ->> 'created')::boolean, true, 'branch_supervisor on a branch is granted');
select lives_ok(
  format($$ select public.admin_set_role(%L, 'field_collector', 'country', tests.id('ke')) $$, :'new_user'),
  'a field collector may be scoped to a whole country');

-- the grant is effective immediately
select tests.login_as(:'new_user', 'aal1');
select is(
  row(private.can_review(tests.id('tz'), tests.id('br_tanga')), private.can_review(tests.id('tz'), tests.id('br_pemba')))::text,
  row(true, false)::text, 'the new supervisor can review the own branch only');

-- ---------------------------------------------------------------------------
-- admin_remove_role
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('u_hq'), 'aal2');
select is(
  public.admin_remove_role((:'g2'::jsonb ->> 'id')::uuid),
  jsonb_build_object('id', :'g2'::jsonb -> 'id', 'user_id', :'new_user'::uuid, 'removed', true),
  'a role grant is removed');
select is(
  (public.admin_remove_role((:'g2'::jsonb ->> 'id')::uuid) ->> 'removed')::boolean, false,
  'removing it again changes nothing');
select throws_ok(
  $$ select public.admin_remove_role('00000000-0000-4000-8000-0000000fffff') $$,
  'PT404', 'role_not_found', 'unknown role grant');
select throws_ok(
  format($$ select public.admin_remove_role(%L) $$, :'hq_role'),
  'PT409', 'last_hq_admin', 'the last hq_admin cannot be removed');

select tests.login_as(:'new_user', 'aal1');
select is(private.can_review(tests.id('tz'), tests.id('br_tanga')), false,
  'after the removal the review right is gone at once');

select tests.login_as(tests.id('u_hq'), 'aal2');
select is(
  public.admin_set_role(:'new_user', 'branch_supervisor', 'branch', tests.id('br_tanga')),
  (:'g2'::jsonb - 'created') || '{"created": true}'::jsonb,
  'granting a removed role again revives the same grant');
select tests.logout();

select ok(
  exists (select 1 from public.audit_log a
          where a.table_name = 'user_roles' and a.row_id = (:'g2'::jsonb ->> 'id')::uuid
            and a.op = 'INSERT' and a.user_id = tests.id('u_hq')),
  'role changes are in the audit log under the administrator''s name');

-- ---------------------------------------------------------------------------
-- admin_set_user_active
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('u_col_pemba2'), 'aal1');
select cmp_ok((select count(*)::int from public.projects), '>', 0, 'before: the collector sees projects');

select tests.login_as(tests.id('u_hq'), 'aal2');
select throws_ok(
  $$ select public.admin_set_user_active(tests.id('u_hq'), false) $$,
  'PT409', 'cannot_deactivate_self', 'an administrator cannot deactivate the own account');
select throws_ok(
  $$ select public.admin_set_user_active('00000000-0000-4000-8000-0000000fffff', false) $$,
  'PT404', 'user_not_found', 'unknown user');
select is(
  public.admin_set_user_active(tests.id('u_col_pemba2'), false),
  jsonb_build_object('user_id', tests.id('u_col_pemba2'), 'active', false, 'changed', true, 'auth_logout_required', true),
  'the user is deactivated');

select tests.login_as(tests.id('u_col_pemba2'), 'aal1');
select tests.set_claim('iat', to_jsonb(extract(epoch from clock_timestamp())::bigint + 5));
select is((select count(*)::int from public.projects), 0, 'a deactivated user reads nothing, even with a fresh token');
select is((public.my_context() ->> 'session_ok')::boolean, false, 'my_context() reports session_ok = false');

select tests.login_as(tests.id('u_hq'), 'aal2');
select is(
  (public.admin_set_user_active(tests.id('u_col_pemba2'), true) ->> 'changed')::boolean, true, 'the user is reactivated');

select tests.login_as(tests.id('u_col_pemba2'), 'aal1');
select tests.set_claim('iat', to_jsonb(extract(epoch from clock_timestamp())::bigint - 60));
select is((select count(*)::int from public.projects), 0,
  'tokens issued before the deactivation stay dead after reactivation');
select tests.set_claim('iat', to_jsonb(extract(epoch from clock_timestamp())::bigint + 5));
select cmp_ok((select count(*)::int from public.projects), '>', 0, 'a new sign-in works again');

-- ---------------------------------------------------------------------------
-- admin_revoke_sessions: whole user
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('u_col_pemba'), 'aal1', 'dev-ok');
select cmp_ok((select count(*)::int from public.projects), '>', 0, 'before the revocation the collector sees projects');

select tests.login_as(tests.id('u_hq'), 'aal2');
select public.admin_revoke_sessions(tests.id('u_col_pemba')) as rv1 \gset
select is(
  :'rv1'::jsonb - 'revoked_at',
  jsonb_build_object('user_id', tests.id('u_col_pemba'), 'device_id', null, 'scope', 'user', 'auth_logout_required', true),
  'admin_revoke_sessions(user) answers with scope user');

-- the user's existing token (issued a minute ago) is dead on the very next query
select tests.login_as(tests.id('u_col_pemba'), 'aal1', 'dev-ok');
select tests.set_claim('iat', to_jsonb(extract(epoch from clock_timestamp())::bigint - 60));
select is((select count(*)::int from public.projects), 0, 'after the revocation the next query returns nothing');
select is((select count(*)::int from public.persons), 0, 'no persons either');
select throws_ok(
  $$ select public.person_candidates('محمد', '+255700000001', null) $$,
  'PT403', 'forbidden', 'and RPCs refuse the revoked session');

-- a token issued after the revocation (new sign-in) works
select tests.set_claim('iat', to_jsonb(extract(epoch from clock_timestamp())::bigint + 5));
select cmp_ok((select count(*)::int from public.projects), '>', 0, 'a sign-in after the revocation works');

-- ---------------------------------------------------------------------------
-- admin_revoke_sessions: one device, and admin_restore_device
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('u_hq'), 'aal2');
select throws_ok(
  $$ select public.admin_revoke_sessions(tests.id('u_col_pemba'), 'dev-unknown') $$,
  'PT404', 'device_not_found', 'unknown device');
select public.admin_revoke_sessions(tests.id('u_col_pemba'), 'dev-lost') as rv2 \gset
select is(
  :'rv2'::jsonb - 'revoked_at',
  jsonb_build_object('user_id', tests.id('u_col_pemba'), 'device_id', 'dev-lost', 'scope', 'device', 'auth_logout_required', true),
  'admin_revoke_sessions(user, device) answers with scope device');

-- the token that was on the lost phone is dead even when the thief drops the device header
select tests.login_as(tests.id('u_col_pemba'), 'aal1', null);
select tests.set_claim('iat', to_jsonb(extract(epoch from clock_timestamp())::bigint - 60));
select is((select count(*)::int from public.projects), 0,
  'a device revocation also kills the tokens issued so far (the device header can be omitted)');

select tests.login_as(tests.id('u_col_pemba'), 'aal1', 'dev-lost');
select tests.set_claim('iat', to_jsonb(extract(epoch from clock_timestamp())::bigint + 5));
select is((select count(*)::int from public.projects), 0, 'the revoked device reads nothing, even with a new token');

select tests.login_as(tests.id('u_col_pemba'), 'aal1', 'dev-ok');
select tests.set_claim('iat', to_jsonb(extract(epoch from clock_timestamp())::bigint + 5));
select cmp_ok((select count(*)::int from public.projects), '>', 0, 'the same user keeps working on another device');

select tests.login_as(tests.id('u_hq'), 'aal2');
select is(
  public.admin_restore_device(tests.id('u_col_pemba'), 'dev-lost'),
  jsonb_build_object('user_id', tests.id('u_col_pemba'), 'device_id', 'dev-lost', 'restored', true),
  'the device is restored');
select is(
  (public.admin_restore_device(tests.id('u_col_pemba'), 'dev-lost') ->> 'restored')::boolean, false,
  'restoring it again changes nothing');
select throws_ok(
  $$ select public.admin_restore_device(tests.id('u_col_pemba'), 'dev-unknown') $$,
  'PT404', 'device_not_found', 'unknown device cannot be restored');

select tests.login_as(tests.id('u_col_pemba'), 'aal1', 'dev-lost');
select tests.set_claim('iat', to_jsonb(extract(epoch from clock_timestamp())::bigint + 5));
select cmp_ok((select count(*)::int from public.projects), '>', 0, 'the restored device works again');

-- ---------------------------------------------------------------------------
-- Country manager: own country only, never HQ
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('u_mgr_tz'), 'aal2');
select is(
  public.admin_revoke_sessions(tests.id('u_col_tanga')) ->> 'scope', 'user',
  'the Tanzania manager revokes the sessions of a Tanzanian user');
select throws_ok(
  $$ select public.admin_revoke_sessions(tests.id('u_col_ke')) $$,
  'PT404', 'user_not_found', 'a Kenyan user is invisible to the Tanzania manager');
select throws_ok(
  $$ select public.admin_revoke_sessions(tests.id('u_col_ke'), 'dev-ke') $$,
  'PT404', 'user_not_found', 'also for a device revocation');
select throws_ok(
  $$ select public.admin_revoke_sessions(tests.id('u_hq')) $$,
  'PT404', 'user_not_found', 'a country manager can never revoke an hq_admin');

select tests.logout();
select is(
  (select row(p.sessions_revoked_at is null,
              (select d.revoked_at is null from public.devices d where d.user_id = p.id and d.device_id = 'dev-ke'))::text
   from public.profiles p where p.id = tests.id('u_col_ke')),
  row(true, true)::text,
  'the refused attempts changed nothing for the Kenyan user');

select tests.login_as(tests.id('u_mgr_ke'), 'aal2');
select is(
  public.admin_revoke_sessions(tests.id('u_col_ke'), 'dev-ke') ->> 'scope', 'device',
  'the Kenya manager blocks a device of a Kenyan user');
select tests.logout();

select is(
  (select row(
     (select p.sessions_revoked_at is not null from public.profiles p where p.id = tests.id('u_col_tanga')),
     (select p.sessions_revoked_at is not null from public.profiles p where p.id = tests.id('u_col_ke')),
     (select p.sessions_revoked_at is null from public.profiles p where p.id = tests.id('u_hq')),
     (select d.revoked_at is not null from public.devices d where d.user_id = tests.id('u_col_ke') and d.device_id = 'dev-ke'))::text),
  row(true, true, true, true)::text,
  'only the allowed revocations were stored (the Kenyan one by the Kenya manager, nothing for HQ)');

select * from finish();
rollback;

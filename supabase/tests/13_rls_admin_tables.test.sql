-- =============================================================================
-- 13  Reference and admin tables (brief §3: hq_admin manages users, countries
--     and lists; nobody can grant themselves a role)
--
--   countries, admin_areas, branches, option_values, fx_rates, map_packs,
--   app_settings: readable with a valid session, writable by hq_admin only,
--   never hard-deleted.
--   profiles, user_roles, devices: own rows; hq_admin everything;
--   country_manager the users of the own country (read-only).
--   No direct UPDATE may remove the last effective hq_admin.
-- =============================================================================
begin;
set local search_path = public, extensions, tests;

select plan(127);

select tests.fixture_extra();
-- A signed-in user with a profile but without any role.
select tests.create_user('u_norole@example.org', null, null, null);

create temporary table _ref_tables on commit drop as
select t
from unnest(array[
  'countries', 'admin_areas', 'branches', 'option_values', 'fx_rates', 'map_packs', 'app_settings'
]) as t;
grant select on _ref_tables to public;

create temporary table _admin_tables on commit drop as
select t from unnest(array['profiles', 'user_roles', 'devices']) as t;
grant select on _admin_tables to public;

-- -----------------------------------------------------------------------------
-- A. Reading reference data
-- -----------------------------------------------------------------------------
select tests.login_as(tests.id('u_col_ke'), 'aal1');
select isnt_empty(format('select 1 from public.%I', t), format('field_collector: can read %s', t))
from _ref_tables order by t;
select is(
  tests.visible('countries', tests.ids('tz', 'ke')), tests.ids('tz', 'ke'),
  'field_collector: all countries are readable (reference data is not scoped)');
select is(
  tests.visible('app_settings', tests.ids('setting_public', 'setting_private')), tests.ids('setting_public'),
  'field_collector: only public settings');

select tests.login_as(tests.id('u_viewer_tz'), 'aal1');
select isnt_empty(format('select 1 from public.%I', t), format('viewer: can read %s', t))
from _ref_tables order by t;

select tests.login_as(tests._uuid('user:u_norole@example.org'), 'aal1');
select isnt_empty($$ select 1 from public.countries $$, 'user without a role: can read reference data');
select is_empty($$ select 1 from public.projects $$, 'user without a role: sees no project');
select is_empty($$ select 1 from public.persons $$, 'user without a role: sees no person');

select tests.login_as(tests.id('u_hq'), 'aal2');
select is(
  tests.visible('app_settings', tests.ids('setting_public', 'setting_private')),
  tests.ids('setting_public', 'setting_private'),
  'hq_admin: public and private settings');

select tests.login_anon();
select throws_ok(format('select 1 from public.%I limit 1', t), '42501', null, format('anon: cannot read %s', t))
from _ref_tables order by t;
select throws_ok(format('select 1 from public.%I limit 1', t), '42501', null, format('anon: cannot read %s', t))
from _admin_tables order by t;

-- -----------------------------------------------------------------------------
-- B. Writing reference data: hq_admin only
-- -----------------------------------------------------------------------------
select tests.login_as(tests.id('u_hq'), 'aal2');

select lives_ok(
  $$ insert into public.countries (iso2, iso3, name_ar, name_en) values ('ZZ', 'ZZZ', 'بلد اختبار', 'Testland') $$,
  'hq_admin: can add a country');
select is(
  (select created_by from public.countries where iso2 = 'ZZ'), tests.id('u_hq'),
  'hq_admin: the new country is stamped with the creator');
select lives_ok(
  $$ update public.countries set name_sw = 'Nchi ya majaribio' where iso2 = 'ZZ' $$,
  'hq_admin: can update a country');
select is(
  (select name_sw from public.countries where iso2 = 'ZZ'), 'Nchi ya majaribio',
  'hq_admin: the update is applied');
select lives_ok(
  $$ insert into public.branches (country_id, code, name_ar) values (tests.id('ke'), 'TEST-NEW', 'فرع جديد') $$,
  'hq_admin: can add a branch');
select lives_ok(
  $$ insert into public.option_values (list_key, code, name_ar) values ('livelihoods', 'test_new_option', 'خيار') $$,
  'hq_admin: can add an option value');
select lives_ok(
  $$ insert into public.fx_rates (currency, usd_per_unit, effective_date) values ('XTS', 2, date '2001-01-01') $$,
  'hq_admin: can add an fx rate');
select lives_ok(
  $$ update public.app_settings set value = '"2"'::jsonb where key = 'test.private_setting' $$,
  'hq_admin: can change a setting');
select lives_ok(
  $$ update public.map_packs set active = false where code = 'TEST-PACK' $$,
  'hq_admin: can change a map pack');
select lives_ok(
  $$ update public.countries set deleted_at = now() where iso2 = 'ZZ' $$,
  'hq_admin: soft delete is an UPDATE');
select throws_ok(format('delete from public.%I', t), '42501', null, format('hq_admin: hard DELETE from %s is refused', t))
from _ref_tables order by t;

-- hq_admin at AAL1 is not an administrator
select tests.login_as(tests.id('u_hq'), 'aal1');
select throws_ok(
  $$ insert into public.countries (iso2, name_ar, name_en) values ('ZY', 'x', 'x') $$, '42501', null,
  'hq_admin at AAL1: cannot add a country');
select is_empty(
  $$ update public.countries set name_en = 'Hacked' where iso2 = 'KE' returning 1 $$,
  'hq_admin at AAL1: UPDATE touches no row');

-- everybody else
select tests.login_as(tests.id('u_mgr_tz'), 'aal2');
select throws_ok(
  $$ insert into public.countries (iso2, name_ar, name_en) values ('ZY', 'x', 'x') $$, '42501', null,
  'country_manager: cannot add a country');
select throws_ok(
  $$ insert into public.branches (country_id, code, name_ar) values (tests.id('tz'), 'TEST-X', 'x') $$, '42501', null,
  'country_manager: cannot add a branch');
select throws_ok(
  $$ insert into public.fx_rates (currency, usd_per_unit, effective_date) values ('XTS', 3, date '2002-01-01') $$,
  '42501', null, 'country_manager: cannot add an fx rate');
select is_empty(format('update public.%I set deleted_at = now() returning 1', t),
  format('country_manager: UPDATE of %s touches no row', t))
from _ref_tables order by t;

select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select throws_ok(
  $$ insert into public.option_values (list_key, code, name_ar) values ('livelihoods', 'test_evil', 'x') $$,
  '42501', null, 'field_collector: cannot add an option value');
select throws_ok(
  $$ insert into public.app_settings (key, value, is_public) values ('test.evil', '1'::jsonb, true) $$,
  '42501', null, 'field_collector: cannot add a setting');
select is_empty(format('update public.%I set deleted_at = now() returning 1', t),
  format('field_collector: UPDATE of %s touches no row', t))
from _ref_tables order by t;
select throws_ok(format('delete from public.%I', t), '42501', null, format('field_collector: DELETE from %s is refused', t))
from _ref_tables order by t;

select tests.logout();
select is(
  (select count(*)::int from public.countries where iso2 in ('TZ', 'KE') and deleted_at is null and name_en <> 'Hacked'),
  2, 'reference data is untouched after the refused writes');

-- -----------------------------------------------------------------------------
-- C. profiles
-- -----------------------------------------------------------------------------
select tests.login_as(tests.id('u_col_pemba'), 'aal1');

select is(tests.visible('profiles'), tests.ids('u_col_pemba'), 'user: sees only the own profile');
select lives_ok(
  $$ update public.profiles set full_name = 'Collector Pemba', phone = '+255711111111', preferred_language = 'sw'
     where id = auth.uid() $$,
  'user: can change full_name, phone and preferred_language of the own profile');
select is(
  (select full_name || '|' || phone || '|' || preferred_language from public.profiles where id = auth.uid()),
  'Collector Pemba|+255711111111|sw', 'user: the profile change is applied');
select throws_ok(
  $$ update public.profiles set active = false where id = auth.uid() $$, 'PT403', null,
  'user: cannot change active');
select throws_ok(
  $$ update public.profiles set sessions_revoked_at = now() - interval '10 years' where id = auth.uid() $$, 'PT403', null,
  'user: cannot change sessions_revoked_at');
select throws_ok(
  $$ update public.profiles set deleted_at = now() where id = auth.uid() $$, 'PT403', null,
  'user: cannot soft-delete the own profile');
select throws_ok(
  $$ update public.profiles set created_at = now() - interval '1 day' where id = auth.uid() $$, 'PT403', null,
  'user: cannot change creation metadata');
select is_empty(
  $$ update public.profiles set full_name = 'Hacked' where id = tests.id('u_col_pemba2') returning 1 $$,
  'user: UPDATE of another profile touches no row');
select throws_ok(
  $$ update public.profiles set id = tests.id('u_col_pemba2') where id = auth.uid() $$, 'PT403', null,
  'user: cannot move the own profile to another id');
select throws_ok(
  $$ insert into public.profiles (id, full_name) values (tests._uuid('user:u_norole@example.org'), 'x') $$,
  '42501', null, 'user: cannot insert a profile');
select throws_ok(
  $$ delete from public.profiles where id = auth.uid() $$, '42501', null,
  'user: cannot delete the own profile');

select tests.login_as(tests.id('u_mgr_tz'), 'aal2');
select is(
  tests.visible('profiles', tests.fixture_users()),
  tests.ids('u_mgr_tz', 'u_sup_pemba', 'u_col_pemba', 'u_col_pemba2', 'u_col_tanga', 'u_viewer_tz'),
  'country_manager: profiles of the users of the own country');
select is_empty(
  $$ update public.profiles set active = false where id = tests.id('u_col_tanga') returning 1 $$,
  'country_manager: cannot deactivate a user (read-only)');
select throws_ok(
  $$ update public.profiles set active = false where id = auth.uid() $$, 'PT403', null,
  'country_manager: cannot change active on the own profile either');

select tests.login_as(tests.id('u_hq'), 'aal2');
select lives_ok(
  $$ update public.profiles set active = false where id = tests.id('u_col_tanga') $$,
  'hq_admin: can deactivate a user');
select lives_ok(
  $$ update public.profiles set sessions_revoked_at = now() where id = tests.id('u_col_pemba2') $$,
  'hq_admin: can revoke the sessions of a user');
select is(
  (select active from public.profiles where id = tests.id('u_col_tanga')), false,
  'hq_admin: the deactivation is applied');

-- -----------------------------------------------------------------------------
-- D. user_roles: nobody can grant themselves (or anybody) a role, except hq_admin
-- -----------------------------------------------------------------------------
select tests.login_as(tests.id('u_col_pemba'), 'aal1');

select is(
  (select count(*)::int from public.user_roles), 1, 'user: sees exactly the own role grant');
select throws_ok(
  $$ insert into public.user_roles (user_id, role, scope_type, scope_id) values (auth.uid(), 'hq_admin', 'global', null) $$,
  '42501', null, 'field_collector: cannot grant itself hq_admin');
select throws_ok(
  $$ insert into public.user_roles (user_id, role, scope_type, scope_id)
     values (auth.uid(), 'branch_supervisor', 'branch', tests.id('br_pemba')) $$,
  '42501', null, 'field_collector: cannot grant itself branch_supervisor');
select throws_ok(
  $$ insert into public.user_roles (user_id, role, scope_type, scope_id)
     values (auth.uid(), 'field_collector', 'branch', tests.id('br_tanga')) $$,
  '42501', null, 'field_collector: cannot extend its scope to another branch');
select is_empty(
  $$ update public.user_roles set role = 'country_manager', scope_type = 'country', scope_id = tests.id('tz')
     where user_id = auth.uid() returning 1 $$,
  'field_collector: UPDATE of the own role grant touches no row');
select is_empty(
  $$ update public.user_roles set scope_id = tests.id('br_tanga') where user_id = auth.uid() returning 1 $$,
  'field_collector: cannot re-scope the own role grant');
select throws_ok(
  $$ delete from public.user_roles where user_id = auth.uid() $$, '42501', null,
  'field_collector: cannot delete role grants');
select is(
  (select role || ':' || scope_type from public.user_roles where user_id = auth.uid()),
  'field_collector:branch', 'field_collector: the role grant is unchanged');

select tests.login_as(tests.id('u_sup_pemba'), 'aal1');
select throws_ok(
  $$ insert into public.user_roles (user_id, role, scope_type, scope_id)
     values (auth.uid(), 'country_manager', 'country', tests.id('tz')) $$,
  '42501', null, 'branch_supervisor: cannot grant itself country_manager');

select tests.login_as(tests.id('u_mgr_tz'), 'aal2');
select throws_ok(
  $$ insert into public.user_roles (user_id, role, scope_type, scope_id) values (auth.uid(), 'hq_admin', 'global', null) $$,
  '42501', null, 'country_manager: cannot grant itself hq_admin');
select throws_ok(
  $$ insert into public.user_roles (user_id, role, scope_type, scope_id)
     values (auth.uid(), 'country_manager', 'country', tests.id('ke')) $$,
  '42501', null, 'country_manager: cannot grant itself another country');
select throws_ok(
  $$ insert into public.user_roles (user_id, role, scope_type, scope_id)
     values (tests.id('u_col_tanga'), 'branch_supervisor', 'branch', tests.id('br_tanga')) $$,
  '42501', null, 'country_manager: cannot grant roles to others by direct SQL');
select is(
  (select count(*)::int from public.user_roles where user_id = any (tests.fixture_users())), 6,
  'country_manager: sees the role grants scoped to the own country (and its branches)');

select tests.login_as(tests.id('u_viewer_global'), 'aal1');
select throws_ok(
  $$ insert into public.user_roles (user_id, role, scope_type, scope_id) values (auth.uid(), 'field_collector', 'global', null) $$,
  '42501', null, 'viewer: cannot grant itself a writing role');

select tests.login_as(tests.id('u_hq'), 'aal1');
select throws_ok(
  $$ insert into public.user_roles (user_id, role, scope_type, scope_id)
     values (tests.id('u_col_tanga'), 'branch_supervisor', 'branch', tests.id('br_tanga')) $$,
  '42501', null, 'hq_admin at AAL1: cannot grant roles');

select tests.login_as(tests.id('u_hq'), 'aal2');
select lives_ok(
  $$ insert into public.user_roles (user_id, role, scope_type, scope_id)
     values (tests.id('u_col_tanga'), 'branch_supervisor', 'branch', tests.id('br_tanga')) $$,
  'hq_admin: can grant a role');
select lives_ok(
  $$ update public.user_roles set deleted_at = now()
     where user_id = tests.id('u_col_tanga') and role = 'branch_supervisor' $$,
  'hq_admin: can revoke a role (soft delete)');
select throws_ok(
  $$ delete from public.user_roles where user_id = tests.id('u_col_tanga') $$, '42501', null,
  'hq_admin: cannot hard-delete role grants');

-- -----------------------------------------------------------------------------
-- E. devices
-- -----------------------------------------------------------------------------
select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select is(tests.visible('devices'), tests.ids('device:u_col_pemba'), 'user: sees only the own devices');
select throws_ok(
  $$ insert into public.devices (user_id, device_id) values (auth.uid(), 'dev-direct') $$, '42501', null,
  'user: cannot register a device by direct INSERT (register_device RPC only)');
select is_empty(
  $$ update public.devices set revoked_at = null where user_id = auth.uid() returning 1 $$,
  'user: cannot un-revoke or change the own devices by direct UPDATE');

select tests.login_as(tests.id('u_mgr_tz'), 'aal2');
select is(tests.visible('devices', tests.kind_ids('device')), tests.ids('device:u_col_pemba'),
  'country_manager: devices of the users of the own country');

select tests.login_as(tests.id('u_hq'), 'aal2');
select is(tests.visible('devices', tests.kind_ids('device')),
  tests.ids('device:u_col_pemba', 'device:u_col_ke', 'device:u_hq'), 'hq_admin: all devices');
select lives_ok(
  $$ update public.devices set revoked_at = now() where id = tests.id('device:u_col_ke') $$,
  'hq_admin: can revoke a device');

-- -----------------------------------------------------------------------------
-- F. The last effective hq_admin (live global grant + active profile) cannot be
--    removed by direct DML either (admin_remove_role / admin_set_user_active
--    refuse it too; trigger t85_keep_hq_admin on user_roles and profiles)
-- -----------------------------------------------------------------------------
select tests.logout();
-- u_hq is the only effective hq_admin from here on (seed data may hold others)
update public.user_roles set deleted_at = now()
where role = 'hq_admin' and deleted_at is null and user_id <> tests.id('u_hq');
select tests.create_user('u_t13_inactive@example.org', null, null, null);
update public.profiles set active = false where id = tests._uuid('user:u_t13_inactive@example.org');

select tests.login_as(tests.id('u_hq'), 'aal2');
select throws_ok(
  $$ update public.user_roles set deleted_at = now() where role = 'hq_admin' and deleted_at is null $$,
  'PT409', 'last_hq_admin', 'hq_admin: cannot soft-delete the last hq_admin grant by direct UPDATE');
select throws_ok(
  format($f$ update public.user_roles set role = 'country_manager', scope_type = 'country', scope_id = %L
             where user_id = auth.uid() and role = 'hq_admin' $f$, tests.id('tz')),
  'PT409', 'last_hq_admin', 'hq_admin: cannot re-scope the last hq_admin grant');
select throws_ok(
  format($f$ update public.user_roles set user_id = %L where user_id = auth.uid() and role = 'hq_admin' $f$,
         tests._uuid('user:u_t13_inactive@example.org')),
  'PT409', 'last_hq_admin', 'hq_admin: cannot hand the last hq_admin grant to an inactive user');
select throws_ok(
  $$ update public.profiles set active = false where id = auth.uid() $$,
  'PT409', 'last_hq_admin', 'hq_admin: cannot deactivate the profile of the last hq_admin');
select throws_ok(
  $$ update public.profiles set deleted_at = now() where id = auth.uid() $$,
  'PT409', 'last_hq_admin', 'hq_admin: cannot soft-delete the profile of the last hq_admin');
select lives_ok(
  $$ update public.profiles set full_name = 'Head office' where id = auth.uid() $$,
  'hq_admin: other changes of the own profile are not affected');
select tests.logout();
select is(
  (select count(*)::int
     from public.user_roles ur
     join public.profiles p on p.id = ur.user_id
    where ur.user_id = tests.id('u_hq') and ur.role = 'hq_admin' and ur.scope_type = 'global'
      and ur.deleted_at is null and p.active and p.deleted_at is null),
  1, 'the last hq_admin is still in place after the refused statements');

-- With a second hq_admin the handover works by direct DML (the check must see the
-- other grant although the caller is no longer hq_admin after its own change).
select tests.create_user('u_t13_hq2@example.org', 'hq_admin', 'global', null);
select tests.login_as(tests.id('u_hq'), 'aal2');
select lives_ok(
  $$ update public.user_roles set deleted_at = now() where user_id = auth.uid() and role = 'hq_admin' $$,
  'hq_admin: can remove the own grant while another hq_admin remains');
select tests.login_as(tests._uuid('user:u_t13_hq2@example.org'), 'aal2');
select throws_ok(
  $$ update public.profiles set active = false where id = auth.uid() $$,
  'PT409', 'last_hq_admin', 'the remaining hq_admin is now the last one');
select tests.logout();
select lives_ok(
  format($f$ update public.user_roles set deleted_at = now() where user_id = %L and role = 'hq_admin' $f$,
         tests._uuid('user:u_t13_hq2@example.org')),
  'migration role (break-glass) and SECURITY DEFINER code are not restricted by the trigger');

select tests.logout();
select * from finish();
rollback;

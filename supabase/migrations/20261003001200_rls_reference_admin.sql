-- =============================================================================
-- 0012  RLS: reference and admin tables (brief §3; ARCHITECTURE §2.3)
--
--   countries, admin_areas, branches, option_values, fx_rates, map_packs,
--   app_settings
--       SELECT  every signed-in user with a valid session (session_ok);
--               app_settings: only rows with is_public, the rest hq_admin only
--       INSERT/UPDATE  hq_admin only (is_hq: global scope + AAL2)
--       DELETE  nobody (soft delete = UPDATE deleted_at; no DELETE privilege)
--
--   profiles, user_roles, devices
--       SELECT  own rows; hq_admin all; country_manager the users whose roles
--               are scoped to one of the manager's countries (or to a branch
--               of such a country)
--       INSERT/UPDATE  hq_admin; additionally a user may update the columns
--               full_name / phone / preferred_language of the own profile
--               (enforced by private.tg_profiles_guard)
--
-- All policies are for role `authenticated`; anon has neither privileges nor
-- policies; service_role and the migration role bypass RLS.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Reference tables
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'countries', 'admin_areas', 'branches', 'option_values', 'fx_rates', 'map_packs', 'app_settings'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    if t = 'app_settings' then
      -- Only settings flagged is_public are readable by every signed-in user;
      -- the rest is for hq_admin.
      execute
        'create policy app_settings_select on public.app_settings for select to authenticated '
        'using ((is_public and (select private.session_ok())) or (select private.is_hq()))';
    else
      execute format(
        'create policy %I on public.%I for select to authenticated '
        'using ((select private.session_ok()))',
        t || '_select', t);
    end if;

    execute format('drop policy if exists %I on public.%I', t || '_insert_hq', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated '
      'with check ((select private.is_hq()))',
      t || '_insert_hq', t);

    execute format('drop policy if exists %I on public.%I', t || '_update_hq', t);
    execute format(
      'create policy %I on public.%I for update to authenticated '
      'using ((select private.is_hq())) with check ((select private.is_hq()))',
      t || '_update_hq', t);
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- user_roles
-- (private.restricted_countries() = the countries where the caller is
--  country_manager at AAL2, i.e. exactly the "managed countries".)
-- -----------------------------------------------------------------------------
drop policy if exists user_roles_select_own on public.user_roles;
create policy user_roles_select_own on public.user_roles
  for select to authenticated
  using (user_id = (select auth.uid()) and (select private.session_ok()));

drop policy if exists user_roles_select_hq on public.user_roles;
create policy user_roles_select_hq on public.user_roles
  for select to authenticated
  using ((select private.is_hq()));

drop policy if exists user_roles_select_manager on public.user_roles;
create policy user_roles_select_manager on public.user_roles
  for select to authenticated
  using (
    (scope_type = 'country'
      and scope_id = any ((select private.restricted_countries())::uuid[]))
    or (scope_type = 'branch'
      and scope_id in (
        select b.id
        from public.branches b
        where b.country_id = any ((select private.restricted_countries())::uuid[])))
  );

drop policy if exists user_roles_insert_hq on public.user_roles;
create policy user_roles_insert_hq on public.user_roles
  for insert to authenticated
  with check ((select private.is_hq()));

drop policy if exists user_roles_update_hq on public.user_roles;
create policy user_roles_update_hq on public.user_roles
  for update to authenticated
  using ((select private.is_hq()))
  with check ((select private.is_hq()));

-- -----------------------------------------------------------------------------
-- profiles
-- -----------------------------------------------------------------------------
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) and (select private.session_ok()));

drop policy if exists profiles_select_hq on public.profiles;
create policy profiles_select_hq on public.profiles
  for select to authenticated
  using ((select private.is_hq()));

drop policy if exists profiles_select_manager on public.profiles;
create policy profiles_select_manager on public.profiles
  for select to authenticated
  using (
    exists (
      select 1
      from public.user_roles ur
      where ur.user_id = profiles.id
        and ur.deleted_at is null
        and (
          (ur.scope_type = 'country'
            and ur.scope_id = any ((select private.restricted_countries())::uuid[]))
          or (ur.scope_type = 'branch'
            and ur.scope_id in (
              select b.id
              from public.branches b
              where b.country_id = any ((select private.restricted_countries())::uuid[])))
        )
    )
  );

drop policy if exists profiles_insert_hq on public.profiles;
create policy profiles_insert_hq on public.profiles
  for insert to authenticated
  with check ((select private.is_hq()));

drop policy if exists profiles_update_hq on public.profiles;
create policy profiles_update_hq on public.profiles
  for update to authenticated
  using ((select private.is_hq()))
  with check ((select private.is_hq()));

-- Own profile: the row filter is here, the column filter is in the guard trigger.
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()) and (select private.session_ok()))
  with check (id = (select auth.uid()) and (select private.session_ok()));

-- A non-HQ API caller may change only full_name, phone and preferred_language
-- of a profile (and RLS restricts the row to the own profile). Everything else
-- (active, sessions_revoked_at, id, soft delete, creation metadata) is reserved
-- for hq_admin and for SECURITY DEFINER code, which runs as the migration role
-- and is therefore not restricted here.
create or replace function private.tg_profiles_guard()
returns trigger
language plpgsql
set search_path = public, extensions, private, pg_temp
as $$
declare
  -- columns the owner may edit + columns maintained by the standard trigger
  c_free constant text[] := array[
    'full_name', 'phone', 'preferred_language',
    'updated_at', 'updated_by', 'version', 'sync_xid'
  ];
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if (select private.is_hq()) then
    return new;
  end if;
  if (to_jsonb(new) - c_free) is distinct from (to_jsonb(old) - c_free) then
    raise exception 'Only full_name, phone and preferred_language of your own profile can be changed'
      using errcode = 'PT403';
  end if;
  return new;
end;
$$;

comment on function private.tg_profiles_guard() is
  'Column guard for direct profile updates by non-HQ API callers (own profile: full_name, phone, preferred_language only).';

-- t05: after t00_no_hard_delete, before t10_std (trigger naming of migration 0006),
-- so the comparison sees exactly what the caller sent.
drop trigger if exists t05_guard on public.profiles;
create trigger t05_guard
  before update on public.profiles
  for each row execute function private.tg_profiles_guard();

-- -----------------------------------------------------------------------------
-- devices (registration and heartbeat go through register_device / sync RPCs)
-- -----------------------------------------------------------------------------
drop policy if exists devices_select_own on public.devices;
create policy devices_select_own on public.devices
  for select to authenticated
  using (user_id = (select auth.uid()) and (select private.session_ok()));

drop policy if exists devices_select_hq on public.devices;
create policy devices_select_hq on public.devices
  for select to authenticated
  using ((select private.is_hq()));

drop policy if exists devices_select_manager on public.devices;
create policy devices_select_manager on public.devices
  for select to authenticated
  using (
    exists (
      select 1
      from public.user_roles ur
      where ur.user_id = devices.user_id
        and ur.deleted_at is null
        and (
          (ur.scope_type = 'country'
            and ur.scope_id = any ((select private.restricted_countries())::uuid[]))
          or (ur.scope_type = 'branch'
            and ur.scope_id in (
              select b.id
              from public.branches b
              where b.country_id = any ((select private.restricted_countries())::uuid[])))
        )
    )
  );

drop policy if exists devices_insert_hq on public.devices;
create policy devices_insert_hq on public.devices
  for insert to authenticated
  with check ((select private.is_hq()));

drop policy if exists devices_update_hq on public.devices;
create policy devices_update_hq on public.devices
  for update to authenticated
  using ((select private.is_hq()))
  with check ((select private.is_hq()));

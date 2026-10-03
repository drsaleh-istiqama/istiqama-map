-- =============================================================================
-- 0044  Administration RPCs (brief §3: users, roles, immediate session/device
--       revocation from the admin panel)
--
--   admin_users(p_search, p_limit)                       hq_admin: all users
--                                                        country_manager: users of own country
--   admin_set_role(p_user_id, p_role, p_scope_type, p_scope_id)      hq_admin
--   admin_remove_role(p_role_id)                                     hq_admin
--   admin_set_user_active(p_user_id, p_active)                       hq_admin
--   admin_revoke_sessions(p_user_id, p_device_id default null)       hq_admin, country_manager (own country)
--   admin_restore_device(p_user_id, p_device_id)                     hq_admin
--
-- "hq_admin" and "country_manager" are effective only at AAL2 (MFA), which is
-- enforced by private.my_roles(). Every function is SECURITY DEFINER and
-- authorises the caller itself through private.admin_scope().
--
-- JSON shapes: docs/contracts/people-admin.md
-- =============================================================================

-- -----------------------------------------------------------------------------
-- private.admin_scope — who is calling an administration function?
--   is_hq      true for an hq_admin (global, AAL2)
--   countries  countries managed by the caller (country_manager at AAL2);
--              empty for hq_admin (not needed) and when managers are not allowed
-- Raises PT401 without a user and PT403 when the caller is neither.
-- -----------------------------------------------------------------------------
create or replace function private.admin_scope(
  p_allow_manager boolean,
  out is_hq boolean,
  out countries uuid[]
)
returns record
language plpgsql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = 'PT401';
  end if;

  is_hq := coalesce(private.is_hq(), false);
  countries := '{}'::uuid[];
  if is_hq then
    return;
  end if;

  if p_allow_manager then
    select coalesce(array_agg(distinct r.scope_id), '{}'::uuid[])
    into countries
    from private.my_roles() r
    where r.role = 'country_manager'
      and r.scope_type = 'country'
      and r.scope_id is not null;
    if cardinality(countries) > 0 then
      return;
    end if;
  end if;

  -- Tell an administrator who has not passed MFA what is missing.
  if not coalesce(private.aal2(), false)
     and coalesce(private.session_ok(), false)
     and exists (
       select 1
       from public.user_roles ur
       where ur.user_id = auth.uid()
         and ur.deleted_at is null
         and (ur.role = 'hq_admin' or (p_allow_manager and ur.role = 'country_manager'))
     ) then
    raise exception 'mfa_required' using errcode = 'PT403',
      detail = 'Multi-factor authentication is required for administration.';
  end if;

  raise exception 'forbidden' using errcode = 'PT403',
    detail = 'Administrator rights are required.';
end;
$$;

comment on function private.admin_scope(boolean) is
  'Authorisation gate of the admin RPCs: returns (is_hq, managed countries) or raises PT401/PT403.';

-- True when p_user has a live role scoped to one of p_countries (or to a branch
-- of one of them) and is not an hq_admin: the users a country manager may manage.
create or replace function private.admin_user_in_countries(p_user uuid, p_countries uuid[])
returns boolean
language sql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
  select exists (
           select 1
           from public.user_roles ur
           where ur.user_id = p_user
             and ur.deleted_at is null
             and (
               (ur.scope_type = 'country' and ur.scope_id = any (p_countries))
               or (ur.scope_type = 'branch' and ur.scope_id in (
                     select b.id from public.branches b where b.country_id = any (p_countries)))
             )
         )
     and not exists (
           select 1
           from public.user_roles ur
           where ur.user_id = p_user
             and ur.deleted_at is null
             and ur.role = 'hq_admin'
         );
$$;

comment on function private.admin_user_in_countries(uuid, uuid[]) is
  'True when the user holds a role inside one of the given countries and is not an hq_admin.';

-- -----------------------------------------------------------------------------
-- public.admin_users
-- -----------------------------------------------------------------------------
create or replace function public.admin_users(p_search text default null, p_limit integer default 2000)
returns jsonb
language plpgsql
volatile            -- because of private.rate_limit(); the function itself only reads
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_scope  record;
  v_search text := nullif(private.norm(p_search), '');
  v_limit  integer := least(greatest(coalesce(p_limit, 2000), 1), 5000);
  v_result jsonb;
begin
  v_scope := private.admin_scope(true);
  perform private.rate_limit('admin_read', 120, interval '1 minute');

  select coalesce(jsonb_agg(u.obj order by u.sort_name, u.id), '[]'::jsonb)
  into v_result
  from (
    select
      p.id,
      private.norm(coalesce(p.full_name, '')) as sort_name,
      jsonb_build_object(
        'id', p.id,
        'full_name', p.full_name,
        'email', au.email,
        'phone', coalesce(nullif(p.phone, ''), nullif(au.phone::text, '')),
        'preferred_language', p.preferred_language,
        'active', p.active,
        'sessions_revoked_at', p.sessions_revoked_at,
        'created_at', p.created_at,
        'last_sign_in_at', au.last_sign_in_at,
        'roles', coalesce(r.roles, '[]'::jsonb),
        'devices', coalesce(d.devices, '[]'::jsonb)
      ) as obj
    from public.profiles p
    left join auth.users au on au.id = p.id
    left join lateral (
      select jsonb_agg(
               jsonb_build_object(
                 'id', ur.id,
                 'role', ur.role,
                 'scope_type', ur.scope_type,
                 'scope_id', ur.scope_id,
                 'scope_name_ar', coalesce(c.name_ar, b.name_ar),
                 'scope_name_en', coalesce(c.name_en, b.name_en),
                 'scope_name_sw', coalesce(c.name_sw, b.name_sw),
                 'country_id', coalesce(c.id, b.country_id),
                 'created_at', ur.created_at)
               order by ur.created_at, ur.id) as roles
      from public.user_roles ur
      left join public.countries c on ur.scope_type = 'country' and c.id = ur.scope_id
      left join public.branches b on ur.scope_type = 'branch' and b.id = ur.scope_id
      where ur.user_id = p.id
        and ur.deleted_at is null
    ) r on true
    left join lateral (
      select jsonb_agg(
               jsonb_build_object(
                 'id', dv.id,
                 'device_id', dv.device_id,
                 'label', dv.label,
                 'user_agent', dv.user_agent,
                 'app_version', dv.app_version,
                 'last_seen_at', dv.last_seen_at,
                 'last_push_at', dv.last_push_at,
                 'last_pull_at', dv.last_pull_at,
                 'pending_ops', dv.pending_ops,
                 'pending_photos', dv.pending_photos,
                 'revoked_at', dv.revoked_at)
               order by dv.last_seen_at desc nulls last, dv.id) as devices
      from public.devices dv
      where dv.user_id = p.id
        and dv.deleted_at is null
    ) d on true
    where p.deleted_at is null
      and (v_scope.is_hq or private.admin_user_in_countries(p.id, v_scope.countries))
      and (v_search is null
           or strpos(private.norm(coalesce(p.full_name, '')), v_search) > 0
           or strpos(private.norm(coalesce(au.email, '')), v_search) > 0
           or strpos(coalesce(p.phone, '') || ' ' || coalesce(au.phone::text, ''), v_search) > 0)
    order by 2, 1
    limit v_limit
  ) u;

  return v_result;
end;
$$;

comment on function public.admin_users(text, integer) is
  'Users with roles, last sign-in and devices. hq_admin: everybody; country_manager: users holding a role in the own country.';

-- -----------------------------------------------------------------------------
-- public.admin_set_role
--
-- Allowed combinations:
--   hq_admin           global
--   country_manager    country
--   branch_supervisor  branch
--   field_collector    branch | country
--   viewer             global | country | branch
-- Idempotent: granting an existing live role returns it; a previously removed
-- identical grant is revived instead of duplicated.
-- -----------------------------------------------------------------------------
create or replace function public.admin_set_role(
  p_user_id    uuid,
  p_role       text,
  p_scope_type text,
  p_scope_id   uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_scope   record;
  v_id      uuid;
  v_created boolean := false;
begin
  v_scope := private.admin_scope(false);
  perform private.rate_limit('admin_write', 120, interval '1 minute');

  if p_user_id is null then
    raise exception 'invalid_argument' using errcode = 'PT422',
      detail = 'The user id is required.';
  end if;
  if p_role is null
     or p_role not in ('field_collector', 'branch_supervisor', 'country_manager', 'hq_admin', 'viewer') then
    raise exception 'invalid_role_scope' using errcode = 'PT422',
      detail = format('Unknown role "%s".', coalesce(p_role, ''));
  end if;
  if p_scope_type is null or p_scope_type not in ('global', 'country', 'branch') then
    raise exception 'invalid_role_scope' using errcode = 'PT422',
      detail = format('Unknown scope type "%s".', coalesce(p_scope_type, ''));
  end if;

  if not (
       (p_role = 'hq_admin'          and p_scope_type = 'global')
    or (p_role = 'country_manager'   and p_scope_type = 'country')
    or (p_role = 'branch_supervisor' and p_scope_type = 'branch')
    or (p_role = 'field_collector'   and p_scope_type in ('branch', 'country'))
    or (p_role = 'viewer')
  ) then
    raise exception 'invalid_role_scope' using errcode = 'PT422',
      detail = format('Role "%s" cannot have scope "%s".', p_role, p_scope_type);
  end if;

  if p_scope_type = 'global' then
    if p_scope_id is not null then
      raise exception 'invalid_role_scope' using errcode = 'PT422',
        detail = 'A global scope has no scope id.';
    end if;
  elsif p_scope_id is null then
    raise exception 'invalid_role_scope' using errcode = 'PT422',
      detail = format('Scope "%s" requires a scope id.', p_scope_type);
  elsif p_scope_type = 'country' then
    if not exists (select 1 from public.countries c where c.id = p_scope_id and c.deleted_at is null) then
      raise exception 'invalid_role_scope' using errcode = 'PT422',
        detail = 'The country does not exist.';
    end if;
  else
    if not exists (select 1 from public.branches b where b.id = p_scope_id and b.deleted_at is null) then
      raise exception 'invalid_role_scope' using errcode = 'PT422',
        detail = 'The branch does not exist.';
    end if;
  end if;

  -- Serialise grants for one user (also protects the "revive or insert" below).
  perform 1 from public.profiles p where p.id = p_user_id and p.deleted_at is null for update;
  if not found then
    raise exception 'user_not_found' using errcode = 'PT404';
  end if;

  select ur.id into v_id
  from public.user_roles ur
  where ur.user_id = p_user_id
    and ur.role = p_role
    and ur.scope_type = p_scope_type
    and ur.scope_id is not distinct from p_scope_id
    and ur.deleted_at is null
  limit 1;

  if v_id is null then
    select ur.id into v_id
    from public.user_roles ur
    where ur.user_id = p_user_id
      and ur.role = p_role
      and ur.scope_type = p_scope_type
      and ur.scope_id is not distinct from p_scope_id
      and ur.deleted_at is not null
    order by ur.deleted_at desc
    limit 1;

    if v_id is not null then
      update public.user_roles ur set deleted_at = null where ur.id = v_id;
    else
      v_id := private.uuid_v7();
      insert into public.user_roles (id, user_id, role, scope_type, scope_id)
      values (v_id, p_user_id, p_role, p_scope_type, p_scope_id);
    end if;
    v_created := true;
  end if;

  return jsonb_build_object(
    'id', v_id,
    'user_id', p_user_id,
    'role', p_role,
    'scope_type', p_scope_type,
    'scope_id', p_scope_id,
    'created', v_created);
end;
$$;

comment on function public.admin_set_role(uuid, text, text, uuid) is
  'Grants a role with a validated scope to a user (hq_admin only). Idempotent.';

-- -----------------------------------------------------------------------------
-- public.admin_remove_role — soft delete; the last hq_admin cannot be removed.
-- -----------------------------------------------------------------------------
create or replace function public.admin_remove_role(p_role_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_scope record;
  v_role  public.user_roles%rowtype;
begin
  v_scope := private.admin_scope(false);
  perform private.rate_limit('admin_write', 120, interval '1 minute');

  if p_role_id is null then
    raise exception 'invalid_argument' using errcode = 'PT422',
      detail = 'The role grant id is required.';
  end if;

  select * into v_role from public.user_roles ur where ur.id = p_role_id for update;
  if v_role.id is null then
    raise exception 'role_not_found' using errcode = 'PT404';
  end if;
  if v_role.deleted_at is not null then
    return jsonb_build_object('id', v_role.id, 'user_id', v_role.user_id, 'removed', false);
  end if;

  if v_role.role = 'hq_admin' and not exists (
       select 1
       from public.user_roles ur
       join public.profiles p on p.id = ur.user_id
       where ur.role = 'hq_admin'
         and ur.scope_type = 'global'
         and ur.deleted_at is null
         and ur.id <> v_role.id
         and p.active
         and p.deleted_at is null
     ) then
    raise exception 'last_hq_admin' using errcode = 'PT409',
      detail = 'The last active hq_admin cannot be removed.';
  end if;

  update public.user_roles ur set deleted_at = clock_timestamp() where ur.id = v_role.id;

  return jsonb_build_object('id', v_role.id, 'user_id', v_role.user_id, 'removed', true);
end;
$$;

comment on function public.admin_remove_role(uuid) is
  'Removes (soft-deletes) a role grant (hq_admin only). Refuses to remove the last active hq_admin.';

-- -----------------------------------------------------------------------------
-- public.admin_set_user_active — deactivating also revokes every session.
-- -----------------------------------------------------------------------------
create or replace function public.admin_set_user_active(p_user_id uuid, p_active boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_scope   record;
  v_profile public.profiles%rowtype;
  v_now     timestamptz := clock_timestamp();
begin
  v_scope := private.admin_scope(false);
  perform private.rate_limit('admin_write', 120, interval '1 minute');

  if p_user_id is null or p_active is null then
    raise exception 'invalid_argument' using errcode = 'PT422',
      detail = 'The user id and the active flag are required.';
  end if;

  select * into v_profile
  from public.profiles p
  where p.id = p_user_id and p.deleted_at is null
  for update;
  if v_profile.id is null then
    raise exception 'user_not_found' using errcode = 'PT404';
  end if;

  if not p_active then
    if p_user_id = auth.uid() then
      raise exception 'cannot_deactivate_self' using errcode = 'PT409',
        detail = 'You cannot deactivate your own account.';
    end if;
    if exists (select 1 from public.user_roles ur
               where ur.user_id = p_user_id and ur.role = 'hq_admin' and ur.deleted_at is null)
       and not exists (
         select 1
         from public.user_roles ur
         join public.profiles p on p.id = ur.user_id
         where ur.role = 'hq_admin'
           and ur.scope_type = 'global'
           and ur.deleted_at is null
           and ur.user_id <> p_user_id
           and p.active
           and p.deleted_at is null
       ) then
      raise exception 'last_hq_admin' using errcode = 'PT409',
        detail = 'The last active hq_admin cannot be deactivated.';
    end if;
  end if;

  if v_profile.active is distinct from p_active then
    update public.profiles p
    set active = p_active,
        sessions_revoked_at = case when p_active then p.sessions_revoked_at else v_now end
    where p.id = p_user_id;
  end if;

  return jsonb_build_object(
    'user_id', p_user_id,
    'active', p_active,
    'changed', v_profile.active is distinct from p_active,
    'auth_logout_required', not p_active);
end;
$$;

comment on function public.admin_set_user_active(uuid, boolean) is
  'Activates or deactivates a user (hq_admin only). Deactivation takes effect immediately: session_ok() is false for the user.';

-- -----------------------------------------------------------------------------
-- public.admin_revoke_sessions
--
--   p_device_id is null  -> profiles.sessions_revoked_at = now: every token
--                           issued before this moment stops working at once
--                           (private.session_ok()). The user may sign in again.
--   p_device_id given    -> devices.revoked_at = now: that installation is
--                           blocked until admin_restore_device(), AND
--                           profiles.sessions_revoked_at = now. The device block
--                           is bound to the x-device-id header, which a stolen
--                           token could simply omit; killing the tokens issued
--                           so far closes that door. The user's other devices
--                           have to sign in again.
--
-- The `admin` Edge Function calls this RPC with the administrator's JWT and
-- then signs the user out through the Auth admin API so that refresh tokens
-- die as well ("auth_logout_required" is true in both cases).
--
-- Lost phone whose SIM receives the sign-in codes: revoking is not enough, the
-- holder can sign in again. Deactivate the account (admin_set_user_active)
-- until the number is safe.
-- -----------------------------------------------------------------------------
create or replace function public.admin_revoke_sessions(p_user_id uuid, p_device_id text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_scope  record;
  v_now    timestamptz := clock_timestamp();
  v_device text := nullif(btrim(coalesce(p_device_id, '')), '');
  v_n      integer;
begin
  v_scope := private.admin_scope(true);
  perform private.rate_limit('admin_write', 120, interval '1 minute');

  if p_user_id is null then
    raise exception 'invalid_argument' using errcode = 'PT422',
      detail = 'The user id is required.';
  end if;

  if not exists (select 1 from public.profiles p where p.id = p_user_id and p.deleted_at is null)
     or not (v_scope.is_hq or private.admin_user_in_countries(p_user_id, v_scope.countries)) then
    -- one answer for "unknown" and "outside your country"
    raise exception 'user_not_found' using errcode = 'PT404';
  end if;

  if v_device is null then
    update public.profiles p
    set sessions_revoked_at = v_now
    where p.id = p_user_id;

    return jsonb_build_object(
      'user_id', p_user_id,
      'device_id', null,
      'scope', 'user',
      'revoked_at', v_now,
      'auth_logout_required', true);
  end if;

  update public.devices d
  set revoked_at = v_now
  where d.user_id = p_user_id
    and d.device_id = v_device
    and d.deleted_at is null
    and d.revoked_at is null;
  get diagnostics v_n = row_count;

  if v_n = 0 and not exists (
       select 1 from public.devices d
       where d.user_id = p_user_id and d.device_id = v_device and d.deleted_at is null) then
    raise exception 'device_not_found' using errcode = 'PT404';
  end if;

  -- Tokens issued so far (on any device, with or without the header) are dead.
  update public.profiles p
  set sessions_revoked_at = v_now
  where p.id = p_user_id;

  return jsonb_build_object(
    'user_id', p_user_id,
    'device_id', v_device,
    'scope', 'device',
    'revoked_at', (select max(d.revoked_at) from public.devices d
                   where d.user_id = p_user_id and d.device_id = v_device and d.deleted_at is null),
    'auth_logout_required', true);
end;
$$;

comment on function public.admin_revoke_sessions(uuid, text) is
  'Immediately invalidates all sessions of a user; with a device id it also blocks that device until it is restored. hq_admin: anybody; country_manager: users of the own country.';

-- -----------------------------------------------------------------------------
-- public.admin_restore_device — lift a device block (e.g. the phone was found).
-- -----------------------------------------------------------------------------
create or replace function public.admin_restore_device(p_user_id uuid, p_device_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_scope  record;
  v_device text := nullif(btrim(coalesce(p_device_id, '')), '');
  v_n      integer;
begin
  v_scope := private.admin_scope(false);
  perform private.rate_limit('admin_write', 120, interval '1 minute');

  if p_user_id is null or v_device is null then
    raise exception 'invalid_argument' using errcode = 'PT422',
      detail = 'The user id and the device id are required.';
  end if;

  update public.devices d
  set revoked_at = null
  where d.user_id = p_user_id
    and d.device_id = v_device
    and d.deleted_at is null
    and d.revoked_at is not null;
  get diagnostics v_n = row_count;

  if v_n = 0 and not exists (
       select 1 from public.devices d
       where d.user_id = p_user_id and d.device_id = v_device and d.deleted_at is null) then
    raise exception 'device_not_found' using errcode = 'PT404';
  end if;

  return jsonb_build_object(
    'user_id', p_user_id,
    'device_id', v_device,
    'restored', v_n > 0);
end;
$$;

comment on function public.admin_restore_device(uuid, text) is
  'Clears devices.revoked_at so that the device can be used again (hq_admin only).';

-- -----------------------------------------------------------------------------
-- Privileges
-- -----------------------------------------------------------------------------
revoke execute on function private.admin_scope(boolean) from public, anon, authenticated;
revoke execute on function private.admin_user_in_countries(uuid, uuid[]) from public, anon, authenticated;
grant  execute on function private.admin_scope(boolean) to service_role;
grant  execute on function private.admin_user_in_countries(uuid, uuid[]) to service_role;

revoke execute on function public.admin_users(text, integer) from public, anon;
revoke execute on function public.admin_set_role(uuid, text, text, uuid) from public, anon;
revoke execute on function public.admin_remove_role(uuid) from public, anon;
revoke execute on function public.admin_set_user_active(uuid, boolean) from public, anon;
revoke execute on function public.admin_revoke_sessions(uuid, text) from public, anon;
revoke execute on function public.admin_restore_device(uuid, text) from public, anon;

grant execute on function public.admin_users(text, integer) to authenticated, service_role;
grant execute on function public.admin_set_role(uuid, text, text, uuid) to authenticated, service_role;
grant execute on function public.admin_remove_role(uuid) to authenticated, service_role;
grant execute on function public.admin_set_user_active(uuid, boolean) to authenticated, service_role;
grant execute on function public.admin_revoke_sessions(uuid, text) to authenticated, service_role;
grant execute on function public.admin_restore_device(uuid, text) to authenticated, service_role;

-- =============================================================================
-- 0021  my_context() and register_device()
--       (docs/ARCHITECTURE.md §2.4; contract: docs/contracts/sync.md)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- my_context(): everything the client needs to know about the signed-in user.
-- Read-only (STABLE), so it may be called with GET or POST.
--
-- A revoked session / inactive profile does not raise: it returns session_ok =
-- false with empty roles, so the client can show a clear message and sign out.
-- -----------------------------------------------------------------------------
create or replace function public.my_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_uid      uuid := auth.uid();
  c          private.sync_ctx;
  v_profile  jsonb;
  v_roles    jsonb;
  v_assigned jsonb;
  v_aal      text;
  v_mfa_role boolean;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = 'PT401';
  end if;

  c := private.sync_ctx();
  v_aal := case when private.aal2() then 'aal2' else 'aal1' end;

  select jsonb_build_object(
           'id', p.id,
           'full_name', p.full_name,
           'phone', p.phone,
           'preferred_language', p.preferred_language,
           'active', p.active)
    into v_profile
  from public.profiles p
  where p.id = v_uid and p.deleted_at is null;

  -- effective roles (what the helpers of Appendix A.3 see right now)
  select coalesce(jsonb_agg(jsonb_build_object(
           'role', r.role, 'scope_type', r.scope_type, 'scope_id', r.scope_id)
           order by r.role, r.scope_type, r.scope_id), '[]'::jsonb)
    into v_roles
  from (select distinct m.role, m.scope_type, m.scope_id from private.my_roles() m) r;

  -- granted roles (including the ones that need MFA and are not effective yet)
  select coalesce(jsonb_agg(jsonb_build_object(
           'role', ur.role, 'scope_type', ur.scope_type, 'scope_id', ur.scope_id)
           order by ur.role, ur.scope_type, ur.scope_id), '[]'::jsonb),
         coalesce(bool_or(ur.role in ('country_manager', 'hq_admin')), false)
    into v_assigned, v_mfa_role
  from public.user_roles ur
  where ur.user_id = v_uid and ur.deleted_at is null;

  return jsonb_build_object(
    'user_id', v_uid,
    'profile', v_profile,
    'roles', v_roles,
    'assigned_roles', v_assigned,
    'scopes', jsonb_build_object(
      'read',       jsonb_build_object('all', c.read_all,   'countries', to_jsonb(c.read_c),   'branches', to_jsonb(c.read_b)),
      'people',     jsonb_build_object('all', c.people_all, 'countries', to_jsonb(c.people_c), 'branches', to_jsonb(c.people_b)),
      'write',      jsonb_build_object('all', c.write_all,  'countries', to_jsonb(c.write_c),  'branches', to_jsonb(c.write_b)),
      'review',     jsonb_build_object('all', c.review_all, 'countries', to_jsonb(c.review_c), 'branches', to_jsonb(c.review_b)),
      'restricted', jsonb_build_object('all', c.restricted_all, 'countries', to_jsonb(c.restricted_c))),
    'aal', v_aal,
    'mfa_required', v_mfa_role and v_aal <> 'aal2',
    'session_ok', private.session_ok(),
    'capabilities', jsonb_build_object(
      'can_write',          c.write_all      or cardinality(c.write_c) > 0  or cardinality(c.write_b) > 0,
      'can_review',         c.review_all     or cardinality(c.review_c) > 0 or cardinality(c.review_b) > 0,
      'can_see_restricted', c.restricted_all or cardinality(c.restricted_c) > 0,
      'can_see_people',     c.people_all     or cardinality(c.people_c) > 0 or cardinality(c.people_b) > 0,
      'is_hq',              private.is_hq()),
    'device_id', c.device,
    'scope_epoch', c.epoch,
    'server_time', clock_timestamp());
end;
$$;

comment on function public.my_context() is
  'Profile, effective and granted roles, scope triples, AAL, capability flags and scope_epoch of the caller.';

-- -----------------------------------------------------------------------------
-- register_device(): upsert the caller's device row and report revocation.
-- Called after sign-in (and whenever the label or app version changes). The
-- per-cycle heartbeat with the pending counters is report_device_status()
-- (migration 0045); sync_push / sync_pull stamp last_push_at / last_pull_at.
-- A revoked device stays revoked: only an administrator can clear revoked_at.
-- -----------------------------------------------------------------------------
create or replace function public.register_device(
  p_device_id   text,
  p_label       text,
  p_app_version text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_header  text;
  v_agent   text;
  v_revoked timestamptz;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = 'PT401';
  end if;
  if p_device_id is null or p_device_id !~ '^[A-Za-z0-9._:-]{1,128}$' then
    raise exception 'invalid_device_id' using errcode = 'PT422',
      detail = 'device id must be 1-128 characters of [A-Za-z0-9._:-]';
  end if;

  -- The x-device-id header is what session_ok() and the audit trigger see; it
  -- must name the same device as the argument.
  v_header := nullif(btrim(nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-device-id'), '');
  if v_header is not null and v_header <> p_device_id then
    raise exception 'device_mismatch' using errcode = 'PT422',
      detail = 'x-device-id header and p_device_id differ';
  end if;

  perform private.rate_limit('register_device', 60, interval '1 minute');

  v_agent := left(nullif(current_setting('request.headers', true), '')::jsonb ->> 'user-agent', 400);

  insert into public.devices as d
    (user_id, device_id, label, user_agent, app_version, last_seen_at)
  values
    (v_uid, p_device_id, nullif(left(btrim(coalesce(p_label, '')), 120), ''), v_agent,
     nullif(left(btrim(coalesce(p_app_version, '')), 40), ''), now())
  on conflict (user_id, device_id) do update
    set label        = coalesce(excluded.label, d.label),
        user_agent   = coalesce(excluded.user_agent, d.user_agent),
        app_version  = coalesce(excluded.app_version, d.app_version),
        last_seen_at = now(),
        deleted_at   = null
  returning d.revoked_at into v_revoked;

  return jsonb_build_object(
    'device_id', p_device_id,
    'revoked', v_revoked is not null,
    'revoked_at', v_revoked,
    'server_time', clock_timestamp());
end;
$$;

comment on function public.register_device(text, text, text) is
  'Upserts the caller''s device (label, app version, user agent, last_seen_at) and returns {revoked}.';

revoke execute on function public.my_context() from public, anon;
revoke execute on function public.register_device(text, text, text) from public, anon;
grant  execute on function public.my_context() to authenticated;
grant  execute on function public.register_device(text, text, text) to authenticated;

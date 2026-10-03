-- =============================================================================
-- 0010  Authorisation helpers (docs/ARCHITECTURE.md §2.3, Appendix A.3; brief §3)
--
-- Every helper is STABLE + SECURITY DEFINER with a pinned search_path and only
-- ever reveals facts about the *calling* session, so it is safe to let
-- `authenticated` execute them (RLS policies are evaluated with the privileges
-- of the querying role, therefore that role must be able to call them).
--
-- They are written in PL/pgSQL on purpose: PL/pgSQL keeps its plans for the
-- life of the connection, whereas nested SQL-language functions that cannot be
-- inlined (SECURITY DEFINER) are re-planned on every call (measured: ~0.6 ms
-- per helper call as SQL, ~0.03 ms as PL/pgSQL).
--
-- Inside policies always wrap a call as `(select private.read_all())` so that
-- PostgreSQL evaluates it once per statement (InitPlan) and not once per row.
-- Inside SECURITY DEFINER functions call each helper once and keep the result
-- in a variable (see docs/contracts/authz.md).
--
-- The migration role must have BYPASSRLS (true for `postgres` on Supabase):
-- RLS is forced on every table and these functions read profiles, devices,
-- user_roles and projects on behalf of callers that cannot.
-- =============================================================================

-- The schema is created by migration 0001; keep this file self-sufficient.
create schema if not exists private;

revoke all on schema private from public;
revoke all on schema private from anon;
-- `authenticated` needs USAGE because policies call private.* as the invoker.
-- The schema is NOT exposed through PostgREST, so nothing in it is reachable
-- over the API.
grant usage on schema private to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Session state
-- -----------------------------------------------------------------------------

-- True when the session carries an AAL2 (MFA-verified) token.
create or replace function private.aal2()
returns boolean
language plpgsql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  return coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
end;
$$;

comment on function private.aal2() is
  'True when the JWT of the current request was issued at authenticator assurance level 2 (MFA).';

-- True when the caller may use the system at all:
--   * a live, active profile exists for auth.uid();
--   * the token was issued at or after profiles.sessions_revoked_at (when set);
--   * the device named by the x-device-id header is not revoked for this user.
-- Fails closed: no JWT, no profile, or no `iat` claim while a revocation is
-- recorded all yield false; a malformed `iat` raises.
create or replace function private.session_ok()
returns boolean
language plpgsql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_revoked timestamptz;
  v_iat     double precision;
  v_device  text;
begin
  if v_uid is null then
    return false;
  end if;

  select p.sessions_revoked_at
    into v_revoked
    from public.profiles p
   where p.id = v_uid
     and p.active
     and p.deleted_at is null;
  if not found then
    return false;
  end if;

  if v_revoked is not null then
    v_iat := nullif(auth.jwt() ->> 'iat', '')::double precision;
    if v_iat is null or to_timestamp(v_iat) < v_revoked then
      return false;
    end if;
  end if;

  v_device := private.device_id();
  if v_device is not null and exists (
       select 1
         from public.devices d
        where d.user_id = v_uid
          and d.device_id = v_device
          and d.revoked_at is not null) then
    return false;
  end if;

  return true;
end;
$$;

comment on function private.session_ok() is
  'False when there is no JWT user, the profile is missing/inactive/deleted, the JWT iat predates profiles.sessions_revoked_at, or the x-device-id device is revoked.';

-- Effective roles of the caller.
--   * nothing at all when session_ok() is false;
--   * country_manager / hq_admin rows only at AAL2 (MFA is mandatory for them);
--   * soft-deleted grants are ignored.
create or replace function private.my_roles()
returns table (role text, scope_type text, scope_id uuid)
language plpgsql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_uid  uuid := auth.uid();
  v_aal2 boolean;
begin
  if v_uid is null or not private.session_ok() then
    return;
  end if;
  v_aal2 := private.aal2();

  return query
    select ur.role::text, ur.scope_type::text, ur.scope_id
      from public.user_roles ur
     where ur.user_id = v_uid
       and ur.deleted_at is null
       and (v_aal2 or ur.role not in ('country_manager', 'hq_admin'));
end;
$$;

comment on function private.my_roles() is
  'Effective (role, scope_type, scope_id) rows of the caller; empty when the session is revoked/inactive; manager and HQ roles only at AAL2.';

-- HQ administrator: role hq_admin with global scope, at AAL2 (enforced by my_roles()).
create or replace function private.is_hq()
returns boolean
language plpgsql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  return exists (
    select 1
      from private.my_roles() r
     where r.role = 'hq_admin'
       and r.scope_type = 'global');
end;
$$;

comment on function private.is_hq() is 'True for an hq_admin with global scope at AAL2.';

-- -----------------------------------------------------------------------------
-- Internal building blocks for the scope triples (not part of the contract;
-- other migrations should use the named helpers below).
-- -----------------------------------------------------------------------------

create or replace function private.authz_scope_all(p_roles text[])
returns boolean
language plpgsql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  return exists (
    select 1
      from private.my_roles() r
     where r.role = any (p_roles)
       and r.scope_type = 'global');
end;
$$;

create or replace function private.authz_scope_ids(p_roles text[], p_scope_type text)
returns uuid[]
language plpgsql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  return coalesce(
    (select array_agg(distinct r.scope_id)
       from private.my_roles() r
      where r.role = any (p_roles)
        and r.scope_type = p_scope_type
        and r.scope_id is not null),
    '{}'::uuid[]);
end;
$$;

create or replace function private.authz_can(p_roles text[], p_country uuid, p_branch uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  return exists (
    select 1
      from private.my_roles() r
     where r.role = any (p_roles)
       and (
         r.scope_type = 'global'
         or (r.scope_type = 'country' and r.scope_id = p_country)
         or (r.scope_type = 'branch' and r.scope_id = p_branch)
       ));
end;
$$;

-- -----------------------------------------------------------------------------
-- Scope triples: <capability>_all() + <capability>_countries() + <capability>_branches()
--   read       : any role
--   people     : any role except viewer
--   write      : field_collector, branch_supervisor, country_manager, hq_admin
--   review     : branch_supervisor, country_manager, hq_admin
--   restricted : country_manager, hq_admin (global or country scope only)
-- A branch-scoped role matches rows whose branch_id equals the scope; a
-- country-scoped role matches rows whose country_id equals the scope; a global
-- scope matches everything. The arrays are never null ('{}' when empty).
-- -----------------------------------------------------------------------------

-- read ------------------------------------------------------------------------
create or replace function private.read_all()
returns boolean
language plpgsql stable security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  return private.authz_scope_all(
    array['field_collector', 'branch_supervisor', 'country_manager', 'hq_admin', 'viewer']);
end;
$$;

create or replace function private.read_countries()
returns uuid[]
language plpgsql stable security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  return private.authz_scope_ids(
    array['field_collector', 'branch_supervisor', 'country_manager', 'hq_admin', 'viewer'], 'country');
end;
$$;

create or replace function private.read_branches()
returns uuid[]
language plpgsql stable security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  return private.authz_scope_ids(
    array['field_collector', 'branch_supervisor', 'country_manager', 'hq_admin', 'viewer'], 'branch');
end;
$$;

-- people (names, phones, staff) -------------------------------------------------
create or replace function private.people_all()
returns boolean
language plpgsql stable security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  return private.authz_scope_all(
    array['field_collector', 'branch_supervisor', 'country_manager', 'hq_admin']);
end;
$$;

create or replace function private.people_countries()
returns uuid[]
language plpgsql stable security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  return private.authz_scope_ids(
    array['field_collector', 'branch_supervisor', 'country_manager', 'hq_admin'], 'country');
end;
$$;

create or replace function private.people_branches()
returns uuid[]
language plpgsql stable security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  return private.authz_scope_ids(
    array['field_collector', 'branch_supervisor', 'country_manager', 'hq_admin'], 'branch');
end;
$$;

-- write -------------------------------------------------------------------------
create or replace function private.write_all()
returns boolean
language plpgsql stable security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  return private.authz_scope_all(
    array['field_collector', 'branch_supervisor', 'country_manager', 'hq_admin']);
end;
$$;

create or replace function private.write_countries()
returns uuid[]
language plpgsql stable security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  return private.authz_scope_ids(
    array['field_collector', 'branch_supervisor', 'country_manager', 'hq_admin'], 'country');
end;
$$;

create or replace function private.write_branches()
returns uuid[]
language plpgsql stable security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  return private.authz_scope_ids(
    array['field_collector', 'branch_supervisor', 'country_manager', 'hq_admin'], 'branch');
end;
$$;

-- review (approve / return / merge / resolve conflicts) ---------------------------
create or replace function private.review_all()
returns boolean
language plpgsql stable security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  return private.authz_scope_all(array['branch_supervisor', 'country_manager', 'hq_admin']);
end;
$$;

create or replace function private.review_countries()
returns uuid[]
language plpgsql stable security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  return private.authz_scope_ids(array['branch_supervisor', 'country_manager', 'hq_admin'], 'country');
end;
$$;

create or replace function private.review_branches()
returns uuid[]
language plpgsql stable security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  return private.authz_scope_ids(array['branch_supervisor', 'country_manager', 'hq_admin'], 'branch');
end;
$$;

-- restricted (salaries, sensitive community data) ---------------------------------
create or replace function private.restricted_all()
returns boolean
language plpgsql stable security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  return private.authz_scope_all(array['country_manager', 'hq_admin']);
end;
$$;

create or replace function private.restricted_countries()
returns uuid[]
language plpgsql stable security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  return private.authz_scope_ids(array['country_manager', 'hq_admin'], 'country');
end;
$$;

-- -----------------------------------------------------------------------------
-- Row-level convenience wrappers (for SECURITY DEFINER functions that check a
-- single row; never call them per row over a large set — use the triples).
-- They return false (never null) for null arguments.
-- -----------------------------------------------------------------------------

create or replace function private.can_read_project(p_country uuid, p_branch uuid)
returns boolean
language plpgsql stable security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  return private.authz_can(
    array['field_collector', 'branch_supervisor', 'country_manager', 'hq_admin', 'viewer'],
    p_country, p_branch);
end;
$$;

create or replace function private.can_see_people(p_country uuid, p_branch uuid)
returns boolean
language plpgsql stable security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  return private.authz_can(
    array['field_collector', 'branch_supervisor', 'country_manager', 'hq_admin'],
    p_country, p_branch);
end;
$$;

create or replace function private.can_write_project(p_country uuid, p_branch uuid)
returns boolean
language plpgsql stable security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  return private.authz_can(
    array['field_collector', 'branch_supervisor', 'country_manager', 'hq_admin'],
    p_country, p_branch);
end;
$$;

create or replace function private.can_review(p_country uuid, p_branch uuid)
returns boolean
language plpgsql stable security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  return private.authz_can(
    array['branch_supervisor', 'country_manager', 'hq_admin'],
    p_country, p_branch);
end;
$$;

-- Restricted data is granted per country (or globally), never per branch.
create or replace function private.can_see_restricted(p_country uuid)
returns boolean
language plpgsql stable security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  return private.authz_can(array['country_manager', 'hq_admin'], p_country, null::uuid);
end;
$$;

-- Raw scope facts of one project (no authorisation inside: it is executable
-- only by the migration role and service_role, i.e. from SECURITY DEFINER
-- code that then calls can_*_project() on the result). Soft-deleted projects
-- are returned too; no row when the project does not exist.
create or replace function private.project_scope(p_project uuid)
returns table (country_id uuid, branch_id uuid, created_by uuid, record_state text)
language plpgsql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  return query
    select p.country_id, p.branch_id, p.created_by, p.record_state::text
      from public.projects p
     where p.id = p_project;
end;
$$;

comment on function private.project_scope(uuid) is
  'Scope columns of a project for authorisation inside SECURITY DEFINER functions. Not executable by API roles.';

-- -----------------------------------------------------------------------------
-- Execute privileges
-- -----------------------------------------------------------------------------

revoke execute on function
  private.aal2(),
  private.session_ok(),
  private.my_roles(),
  private.is_hq(),
  private.authz_scope_all(text[]),
  private.authz_scope_ids(text[], text),
  private.authz_can(text[], uuid, uuid),
  private.read_all(), private.read_countries(), private.read_branches(),
  private.people_all(), private.people_countries(), private.people_branches(),
  private.write_all(), private.write_countries(), private.write_branches(),
  private.review_all(), private.review_countries(), private.review_branches(),
  private.restricted_all(), private.restricted_countries(),
  private.can_read_project(uuid, uuid),
  private.can_see_people(uuid, uuid),
  private.can_write_project(uuid, uuid),
  private.can_review(uuid, uuid),
  private.can_see_restricted(uuid),
  private.project_scope(uuid)
from public, anon;

grant execute on function
  private.aal2(),
  private.session_ok(),
  private.my_roles(),
  private.is_hq(),
  private.authz_scope_all(text[]),
  private.authz_scope_ids(text[], text),
  private.authz_can(text[], uuid, uuid),
  private.read_all(), private.read_countries(), private.read_branches(),
  private.people_all(), private.people_countries(), private.people_branches(),
  private.write_all(), private.write_countries(), private.write_branches(),
  private.review_all(), private.review_countries(), private.review_branches(),
  private.restricted_all(), private.restricted_countries(),
  private.can_read_project(uuid, uuid),
  private.can_see_people(uuid, uuid),
  private.can_write_project(uuid, uuid),
  private.can_review(uuid, uuid),
  private.can_see_restricted(uuid)
to authenticated, service_role;

-- project_scope: trusted callers only.
revoke execute on function private.project_scope(uuid) from authenticated;
grant execute on function private.project_scope(uuid) to service_role;

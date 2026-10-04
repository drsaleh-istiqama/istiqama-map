-- =============================================================================
-- 0072  Server fixes from the unit-4 review
--       (contracts: schema.md §staff_compensation, people-admin.md §6 and §11)
--
--   1. staff_compensation.currency is checked against the MANAGED currency list
--      instead of a literal list: a country added from the admin console (brief
--      §0) records salaries in its default_currency without a migration.
--      Managed = the eight currencies of brief §2 + every country's
--      default_currency + every currency with a live fx_rates row.
--   2. (The branch rule of merge_localities / revert_locality_merge is fixed in
--      place in migration 0071: private.locality_merge_allowed.)
--   3. Ending the Auth sessions (refresh tokens) on revocation ships as SQL:
--      private.end_auth_sessions() deletes the user's auth.sessions (refresh
--      tokens cascade). It runs from an AFTER UPDATE trigger on profiles
--      whenever sessions_revoked_at moves forward or an account is deactivated
--      — i.e. inside admin_revoke_sessions and admin_set_user_active(false),
--      whoever calls them, in the same transaction.
--      public.admin_end_auth_sessions() is the service-role RPC the `admin`
--      Edge Function looks for (supabase/functions/_shared/authAdmin.ts,
--      AUTH_LOGOUT_RPC), so auth_logout.method becomes 'rpc' on every target.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Managed currencies
-- -----------------------------------------------------------------------------
create or replace function private.currency_is_managed(p_currency text)
returns boolean
language sql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
  select p_currency is not null
     and p_currency ~ '^[A-Z]{3}$'
     and (
       p_currency in ('TZS', 'KES', 'UGX', 'RWF', 'BIF', 'MZN', 'OMR', 'USD')
       or exists (select 1 from public.countries c
                  where c.default_currency = p_currency and c.deleted_at is null)
       or exists (select 1 from public.fx_rates f
                  where f.currency = p_currency and f.deleted_at is null));
$$;

comment on function private.currency_is_managed(text) is
  'True for the currencies a salary may use: the eight of brief §2, any country''s default_currency, any currency with a live fx_rates row.';

create or replace function private.staff_compensation_currency_guard()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  -- a missing currency is the NOT NULL constraint's business (not_null_violation)
  if new.currency is not null and not private.currency_is_managed(new.currency::text) then
    -- same SQLSTATE, constraint name and message as the former CHECK, so that
    -- sync_push (check_violation + constraint) and the clients keep working
    raise exception 'new row for relation "staff_compensation" violates check constraint "staff_compensation_currency_ck"'
      using errcode = '23514',
            constraint = 'staff_compensation_currency_ck',
            table = 'staff_compensation',
            schema = 'public',
            column = 'currency';
  end if;
  return new;
end;
$$;

alter table public.staff_compensation drop constraint if exists staff_compensation_currency_ck;
alter table public.staff_compensation drop constraint if exists staff_compensation_currency_format_ck;
alter table public.staff_compensation
  add constraint staff_compensation_currency_format_ck check (currency ~ '^[A-Z]{3}$');

drop trigger if exists staff_compensation_currency_tg on public.staff_compensation;
create trigger staff_compensation_currency_tg
  before insert or update of currency on public.staff_compensation
  for each row
  when (new.deleted_at is null)
  execute function private.staff_compensation_currency_guard();

comment on column public.staff_compensation.currency is
  'ISO 4217 code from the managed list (private.currency_is_managed): brief §2 currencies, country default currencies, currencies with an fx rate.';

-- -----------------------------------------------------------------------------
-- 3. Ending Auth sessions (refresh tokens)
--
-- private.end_auth_sessions(user): deletes the user's auth.sessions (GoTrue's
-- refresh_tokens and mfa_amr_claims cascade) and the refresh tokens that have
-- no session. Returns the number of sessions deleted, or NULL when the Auth
-- tables are missing or not writable by the function owner (the caller then
-- still reports auth_logout_required and the Edge Function tries its other
-- ways). Never raises.
-- -----------------------------------------------------------------------------
create or replace function private.end_auth_sessions(p_user_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_n integer;
begin
  if p_user_id is null then
    return 0;
  end if;
  begin
    execute 'delete from auth.sessions s where s.user_id = $1' using p_user_id;
    get diagnostics v_n = row_count;
    execute 'delete from auth.refresh_tokens t where t.user_id = $1::text' using p_user_id;
  exception
    when undefined_table or invalid_schema_name or undefined_column or insufficient_privilege then
      return null;
  end;
  return v_n;
end;
$$;

comment on function private.end_auth_sessions(uuid) is
  'Deletes the Auth sessions and refresh tokens of a user (no token refresh afterwards). NULL when the Auth tables are not reachable.';

-- Service-role RPC used by the `admin` Edge Function (AUTH_LOGOUT_RPC).
-- Raises when the Auth tables are not reachable, so that the function reports
-- auth_logout.done = false instead of a silent success.
create or replace function public.admin_end_auth_sessions(p_user_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_n integer;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'restricted to the service role' using errcode = 'PT403';
  end if;
  if p_user_id is null then
    raise exception 'invalid_argument' using errcode = 'PT422',
      detail = 'The user id is required.';
  end if;
  v_n := private.end_auth_sessions(p_user_id);
  if v_n is null then
    raise exception 'auth_sessions_unavailable' using errcode = 'PT503',
      detail = 'The Auth session tables are not reachable from the database.';
  end if;
  return v_n;
end;
$$;

comment on function public.admin_end_auth_sessions(uuid) is
  'Service role only: ends every Auth session (refresh tokens) of a user. Returns the number of sessions deleted.';

-- Revocation trigger: a forward move of profiles.sessions_revoked_at (only the
-- admin RPCs of migration 0044 write it) or a deactivation ends the user's Auth
-- sessions in the same transaction, so a refresh token cannot bring the access
-- back — on Supabase and locally, with or without the Edge Function.
create or replace function private.profiles_end_auth_sessions_tg()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  perform private.end_auth_sessions(new.id);
  return null;
end;
$$;

drop trigger if exists profiles_end_auth_sessions on public.profiles;
create trigger profiles_end_auth_sessions
  after update of sessions_revoked_at, active on public.profiles
  for each row
  when ((new.sessions_revoked_at is not null
         and new.sessions_revoked_at is distinct from old.sessions_revoked_at)
        or (old.active and not new.active))
  execute function private.profiles_end_auth_sessions_tg();

-- -----------------------------------------------------------------------------
-- Privileges, hardening, schema version
-- -----------------------------------------------------------------------------
revoke execute on function private.currency_is_managed(text) from public, anon, authenticated;
revoke execute on function private.staff_compensation_currency_guard() from public, anon, authenticated;
revoke execute on function private.end_auth_sessions(uuid) from public, anon, authenticated, service_role;
revoke execute on function private.profiles_end_auth_sessions_tg() from public, anon, authenticated;

revoke execute on function public.admin_end_auth_sessions(uuid) from public, anon, authenticated;
grant execute on function public.admin_end_auth_sessions(uuid) to service_role;

select private.harden_private_schema();

create or replace function private.schema_version()
returns text
language sql
immutable
parallel safe
set search_path = public, extensions, private, pg_temp
as $$
  select '20261003007200'::text;
$$;

revoke execute on function private.schema_version() from public, anon, authenticated;

-- =============================================================================
-- 0070  Integration hardening (cross-team loose ends; contract: docs/contracts/schema.md §9)
--
--   (a) Schema "private": RLS enabled AND forced on every table, and nothing
--       granted to public / anon / authenticated on any relation (tables, views,
--       materialized views, sequences).      private.harden_private_schema()
--   (b) pg_cron: the daily retention jobs that migration 0058 does not schedule
--       (private.sync_prune, private.sync_rejections_cleanup).
--   (c) public.server_info(): environment, schema version, server clock and
--       PostGIS version for the client's diagnostics screen.
--       private.schema_version() is the constant later migrations bump.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- (a) private.harden_private_schema()
--
-- Tables of schema private are bookkeeping for SECURITY DEFINER code only. Their
-- owner bypasses RLS (postgres on Supabase has BYPASSRLS; the superuser on the
-- local stack), so RLS without any policy closes them for everybody else even if
-- a privilege is granted by mistake later. Several tables were created with
-- "enable" but without "force" (sync_tables, sync_state, sync_scope_moves,
-- report_meta, enum_labels, export_column_defs, import_column_defs).
--
-- The function is generic (it walks pg_class) and idempotent: a later migration
-- that adds a table to schema private either hardens it itself or simply ends
-- with
--     select private.harden_private_schema();
-- pgTAP file 16 fails while any table of the schema is not hardened.
--
-- Returns the number of RLS switches it had to turn on (0 = nothing to do).
-- SECURITY INVOKER on purpose: only the owner of the tables can run the ALTERs.
-- -----------------------------------------------------------------------------
create or replace function private.harden_private_schema()
returns integer
language plpgsql
volatile
set search_path = public, extensions, private, pg_temp
as $$
declare
  r         record;
  v_changed integer := 0;
begin
  for r in
    select n.nspname::text as nspname,
           c.relname::text as relname,
           c.relkind,
           c.relrowsecurity,
           c.relforcerowsecurity,
           o.rolname::text as owner_name,
           (o.rolsuper or o.rolbypassrls) as owner_bypasses
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_roles o on o.oid = c.relowner
    where n.nspname = 'private'
      and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
      -- relations that belong to an extension are not ours to change
      and not exists (
        select 1
        from pg_catalog.pg_depend d
        where d.classid = 'pg_catalog.pg_class'::regclass
          and d.objid = c.oid
          and d.deptype = 'e')
    order by c.relname
  loop
    if r.relkind in ('r', 'p') then
      -- Forced RLS without policies hides every row from an owner that does not
      -- bypass RLS: the SECURITY DEFINER functions would silently see empty
      -- tables. Refuse instead of breaking the server.
      if not r.owner_bypasses and not r.relforcerowsecurity then
        raise exception 'cannot force row level security on %.%: its owner "%" has neither SUPERUSER nor BYPASSRLS',
          r.nspname, r.relname, r.owner_name
          using hint = 'Tables of schema private must be owned by the role that owns the SECURITY DEFINER functions (postgres on Supabase).';
      end if;
      if not r.relrowsecurity then
        execute format('alter table %I.%I enable row level security', r.nspname, r.relname);
        v_changed := v_changed + 1;
      end if;
      if not r.relforcerowsecurity then
        execute format('alter table %I.%I force row level security', r.nspname, r.relname);
        v_changed := v_changed + 1;
      end if;
    end if;

    if r.relkind = 'S' then
      execute format('revoke all on sequence %I.%I from public, anon, authenticated', r.nspname, r.relname);
    else
      execute format('revoke all on table %I.%I from public, anon, authenticated', r.nspname, r.relname);
    end if;
  end loop;

  return v_changed;
end;
$$;

comment on function private.harden_private_schema() is
  'Enables and forces RLS on every table of schema private and revokes all privileges on its relations from public, anon and authenticated. Idempotent; returns the number of RLS switches turned on. Run it (as the owner) after adding a table to the schema.';

revoke execute on function private.harden_private_schema() from public, anon, authenticated, service_role;

do $harden$
declare
  v_changed integer;
begin
  v_changed := private.harden_private_schema();
  raise notice 'schema private hardened: % row-level-security switch(es) turned on', v_changed;
end
$harden$;

-- -----------------------------------------------------------------------------
-- (b) Daily retention jobs (same guarded pattern as migration 0058, which already
-- schedules istiqama-refresh-reports, istiqama-rate-limit-cleanup and
-- istiqama-expire-exports).
--
--   istiqama-sync-prune                 02:41 UTC  private.sync_prune()
--        idempotency ledger (sync_applied_ops) and scope-move log, 180 days
--   istiqama-sync-rejections-cleanup    02:53 UTC  private.sync_rejections_cleanup()
--        rejected-operation diagnostics, 30 days
--
-- pg_cron runs a job as the role that scheduled it (the migration role), without
-- any end-user JWT, which is what the hard-delete guard of sync_applied_ops
-- requires. Without pg_cron (local stack, plain PostgreSQL) this block does
-- nothing: run the two functions from an external scheduler over a database
-- connection (schema private is not exposed through the REST API).
-- -----------------------------------------------------------------------------
do $jobs$
declare
  v_has_cron boolean;
begin
  select exists (select 1 from pg_available_extensions where name = 'pg_cron') into v_has_cron;
  if not v_has_cron then
    raise notice 'pg_cron is not available: private.sync_prune() and private.sync_rejections_cleanup() must be scheduled externally';
    return;
  end if;

  begin
    create extension if not exists pg_cron;
  exception when others then
    -- e.g. pg_cron present on disk but not in shared_preload_libraries, or this is not the
    -- database named by cron.database_name.
    raise notice 'pg_cron could not be enabled (%): sync retention jobs must be scheduled externally', sqlerrm;
    return;
  end;

  begin
    -- cron.schedule(job_name, schedule, command) upserts by job name (pg_cron >= 1.4).
    if to_regprocedure('private.sync_prune(interval, interval)') is not null then
      perform cron.schedule('istiqama-sync-prune', '41 2 * * *',
                            'select private.sync_prune()');
    end if;
    if to_regprocedure('private.sync_rejections_cleanup(interval)') is not null then
      perform cron.schedule('istiqama-sync-rejections-cleanup', '53 2 * * *',
                            'select private.sync_rejections_cleanup()');
    end if;
  exception when others then
    raise notice 'pg_cron sync retention jobs could not be scheduled (%)', sqlerrm;
  end;
end
$jobs$;

-- -----------------------------------------------------------------------------
-- (c) Schema version and server_info()
--
-- private.schema_version(): timestamp prefix of the newest migration file, the
-- same 14 digits the Supabase CLI records in supabase_migrations.schema_migrations.
-- BUMP IT IN EVERY LATER MIGRATION (create or replace with the new prefix).
-- -----------------------------------------------------------------------------
create or replace function private.schema_version()
returns text
language sql
immutable
parallel safe
set search_path = public, extensions, private, pg_temp
as $$
  select '20261003007000'::text;
$$;

comment on function private.schema_version() is
  'Timestamp prefix of the newest migration applied by this code base. Bump it in every later migration.';

revoke execute on function private.schema_version() from public, anon, authenticated;

-- server_info(): cheap and read-only (STABLE, so GET works too). It never raises:
-- each value has a fallback, because this is what the client shows when something
-- else is broken.
--
--   app_environment   app_settings 'app.environment' when it is a non-empty JSON
--                     string ("staging" is written by the staging seed), else
--                     "production" (docs/contracts/reference-data.md §5)
--   schema_version    the greater of private.schema_version() and the newest
--                     14-digit version in supabase_migrations.schema_migrations
--                     (the table exists where the Supabase CLI applied the
--                     migrations; the Docker-less local stack has none)
--   server_time       clock_timestamp(), for clock-skew checks on the device
--   postgis_version   postgis_lib_version(), e.g. "3.4.2"
--
-- No authorisation beyond the EXECUTE grant: nothing here depends on the caller,
-- and a user with a revoked session may still open the diagnostics screen.
create or replace function public.server_info()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_env     text;
  v_schema  text := private.schema_version();
  v_applied text;
  v_postgis text;
begin
  select s.value #>> '{}'
    into v_env
  from public.app_settings s
  where s.key = 'app.environment'
    and s.deleted_at is null
    and jsonb_typeof(s.value) = 'string';

  begin
    if to_regclass('supabase_migrations.schema_migrations') is not null then
      execute 'select max(m.version::text collate "C") from supabase_migrations.schema_migrations m'
              || ' where m.version::text ~ ''^[0-9]{14}$'''
        into v_applied;
    end if;
  exception when others then
    v_applied := null;
  end;

  begin
    v_postgis := postgis_lib_version();
  exception when others then
    select e.extversion::text into v_postgis from pg_catalog.pg_extension e where e.extname = 'postgis';
  end;

  return jsonb_build_object(
    'app_environment', coalesce(nullif(btrim(v_env), ''), 'production'),
    'schema_version', greatest(v_schema collate "C", v_applied collate "C"),
    'server_time', clock_timestamp(),
    'postgis_version', v_postgis);
end;
$$;

comment on function public.server_info() is
  'Diagnostics for the client: {app_environment, schema_version, server_time, postgis_version}. Any signed-in user; never raises.';

revoke execute on function public.server_info() from public, anon;
grant  execute on function public.server_info() to authenticated, service_role;

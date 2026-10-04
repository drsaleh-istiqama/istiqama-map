-- =============================================================================
-- 0011  RLS baseline and table privileges (ARCHITECTURE §2.3, Appendix A.1)
--
-- Supabase grants ALL on every new object in schema public to anon,
-- authenticated and service_role. This migration removes all of that and gives
-- back the minimum:
--
--   anon           nothing, anywhere
--   authenticated  SELECT on readable tables (RLS decides which rows);
--                  INSERT/UPDATE only on reference/admin tables (RLS: hq_admin);
--                  never DELETE/TRUNCATE (soft delete only);
--                  nothing on restricted tables and on the sync ledger
--   service_role   unchanged (BYPASSRLS, used only by Edge Functions), except
--                  that it cannot rewrite the append-only logs
--
-- Field data is written exclusively through SECURITY DEFINER RPCs (sync_push,
-- import_commit, merge_persons, ...), which run as the migration role.
-- =============================================================================

-- 1. Default deny: RLS enabled + forced and every API privilege removed on all
--    tables that exist at this point (also the ones this file does not know).
do $$
declare
  r record;
begin
  for r in
    select c.oid::regclass as rel, c.relkind
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and not exists (            -- leave extension-owned relations alone
        select 1 from pg_depend d
        where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
  loop
    if r.relkind in ('r', 'p') then
      execute format('alter table %s enable row level security', r.rel);
      execute format('alter table %s force row level security', r.rel);
      execute format('revoke all on table %s from public, anon, authenticated', r.rel);
    else
      -- views / materialized views / foreign tables: never visible to anon;
      -- their owners decide what authenticated may see.
      execute format('revoke all on table %s from public, anon', r.rel);
    end if;
  end loop;
end
$$;

revoke all on all sequences in schema public from public, anon, authenticated;
revoke execute on all functions in schema public from public, anon;

-- Nothing in schema private is a table an API role may touch directly.
revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all sequences in schema private from public, anon, authenticated;

-- Objects created by later migrations must not become visible to anon by
-- default (each later migration still revokes explicitly, Appendix A.1; pgTAP
-- checks the final state).
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke execute on functions from anon;

-- 2. Reference / admin tables: readable with a valid session, managed by
--    hq_admin through RLS. No DELETE: rows are soft-deleted with deleted_at.
grant select, insert, update on table
  public.countries,
  public.admin_areas,
  public.branches,
  public.option_values,
  public.fx_rates,
  public.map_packs,
  public.app_settings,
  public.profiles,
  public.user_roles,
  public.devices
to authenticated;

-- 3. Field data: read-only for authenticated (rows filtered by RLS scope).
grant select on table
  public.localities,
  public.projects,
  public.project_facilities,
  public.project_maintenance,
  public.project_photos,
  public.donors,
  public.project_donors,
  public.persons,
  public.project_staff,
  public.person_merge_requests,
  public.community_profiles,
  public.sync_conflicts,
  public.notifications
to authenticated;

-- project_land: every column except owner_name. A private landowner is a person and
-- the name is people data (schema.md); RLS cannot hide one column per caller, so the
-- name reaches people-scoped callers only through sync_pull / report_project / export.
grant select (id, created_at, updated_at, created_by, updated_by, version, deleted_at, sync_xid,
              project_id, ownership, area_m2, utilization_pct, expandable, notes)
  on table public.project_land
to authenticated;

-- 4. Own jobs: read-only, written through RPC.
grant select on table
  public.export_jobs,
  public.import_batches,
  public.import_rows
to authenticated;

-- 5. Logs: hq_admin may read (RLS); nobody may change them.
grant select on table
  public.audit_log,
  public.restricted_access_log
to authenticated;

revoke update, delete, truncate on table
  public.audit_log,
  public.restricted_access_log
from service_role;

-- 6. Restricted tables and the idempotency ledger: no privilege for API roles
--    (already removed by the loop above; repeated for clarity and so that a
--    later accidental GRANT is easy to spot in review).
revoke all on table
  public.staff_compensation,
  public.community_sensitive,
  public.sync_applied_ops
from public, anon, authenticated;

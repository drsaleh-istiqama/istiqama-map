-- =============================================================================
-- 0006  Standard-column trigger, audit trigger, hard-delete protection
--       (ARCHITECTURE §2.1; brief §2 "soft delete always", §2.6 audit_log)
--
-- Trigger names (same on every table, they fire in alphabetical order):
--   t00_no_hard_delete  BEFORE DELETE   statement  private.tg_no_hard_delete()
--   t00_no_truncate     BEFORE TRUNCATE statement  private.tg_no_hard_delete()
--   t10_std             BEFORE INSERT OR UPDATE row private.tg_std([ 'sync' ])
--   t20_*               BEFORE row      derived columns / validation (0007-0009)
--   t80_*               AFTER statement completeness of the parent project (0008)
--   t90_audit           AFTER INSERT OR UPDATE OR DELETE row private.tg_audit(...)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- private.tg_std — standard columns.
--
--   INSERT  id          kept when supplied (client UUIDv7), else generated
--           created_at  kept when supplied and not in the future (offline entry
--                       time), else now()
--           created_by / updated_by = auth.uid(); explicit values are kept only
--                       when there is no JWT user (service role, cron, definer
--                       code that sets them)
--           version     1
--   UPDATE  id, created_at are immutable; created_by is immutable for JWT users
--           updated_by  = auth.uid() (explicit value kept when there is no JWT user)
--           version     old.version + 1
--   both    updated_at  = now()
--           sync_xid    = private.current_xid() on syncable tables (argument 'sync')
--
-- SECURITY INVOKER on purpose: it touches nothing but NEW.
-- -----------------------------------------------------------------------------
create or replace function private.tg_std()
returns trigger
language plpgsql
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if tg_op = 'INSERT' then
    if new.id is null then
      new.id := private.uuid_v7();
    end if;
    if new.created_at is null or new.created_at > now() + interval '5 minutes' then
      new.created_at := now();
    end if;
    if v_uid is not null then
      new.created_by := v_uid;
      new.updated_by := v_uid;
    else
      new.updated_by := coalesce(new.updated_by, new.created_by);
    end if;
    new.version := 1;
  else
    new.id := old.id;
    new.created_at := old.created_at;
    if v_uid is not null then
      new.created_by := old.created_by;
      new.updated_by := v_uid;
    end if;
    new.version := old.version + 1;
  end if;

  new.updated_at := now();

  if tg_nargs > 0 and tg_argv[0] = 'sync' then
    new.sync_xid := private.current_xid();
  end if;

  return new;
end;
$$;

comment on function private.tg_std() is
  'BEFORE INSERT/UPDATE trigger for the standard columns; argument ''sync'' also maintains sync_xid.';

-- -----------------------------------------------------------------------------
-- private.geom_audit — compact text form of a geometry for the audit log:
-- points as EWKT, anything else as type + point count + md5 (boundaries can be
-- megabytes; the log only needs to show that, and when, they changed).
-- -----------------------------------------------------------------------------
create or replace function private.geom_audit(p extensions.geometry)
returns text
language sql
immutable
parallel safe
set search_path = public, extensions, private, pg_temp
as $$
  select case
    when p is null then null
    when geometrytype(p) = 'POINT' then st_asewkt(p)
    else 'SRID=' || st_srid(p) || ';' || geometrytype(p)
         || ' npoints=' || st_npoints(p)
         || ' md5=' || md5(st_asewkb(p))
  end;
$$;

-- -----------------------------------------------------------------------------
-- private.tg_audit — one audit_log row per changed row.
--
--   * old_data / new_data: the whole row as JSONB; geometry columns (geom,
--     geom_simple) are replaced by private.geom_audit() text.
--   * changed_fields (UPDATE): changed columns without the bookkeeping columns
--     updated_at, updated_by, version, sync_xid and without the columns named
--     in the trigger arguments (used for the devices heartbeat).
--   * an UPDATE that changes nothing else is not logged.
--   * user_id = auth.uid(), falling back to the row's updated_by for server-side
--     code; device_id = private.device_id().
--
-- SECURITY DEFINER: callers have no privilege on audit_log.
-- -----------------------------------------------------------------------------
create or replace function private.tg_audit()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_has_geom boolean := tg_table_name in ('projects', 'localities', 'admin_areas');
  r_old      record;
  r_new      record;
  v_old      jsonb;
  v_new      jsonb;
  v_geo      jsonb;
  v_changed  text[];
  v_row      jsonb;
  v_ignore   text[];
begin
  -- TG_ARGV is NULL (not an empty array) when the trigger has no arguments.
  v_ignore := coalesce(tg_argv, '{}'::text[]);

  if tg_op <> 'INSERT' then
    r_old := old;
    if v_has_geom then
      v_geo := jsonb_build_object('geom', private.geom_audit(r_old.geom));
      r_old.geom := null;
      if tg_table_name = 'admin_areas' then
        v_geo := v_geo || jsonb_build_object('geom_simple', private.geom_audit(r_old.geom_simple));
        r_old.geom_simple := null;
      end if;
      v_old := to_jsonb(r_old) || v_geo;
    else
      v_old := to_jsonb(r_old);
    end if;
  end if;

  if tg_op <> 'DELETE' then
    r_new := new;
    if v_has_geom then
      v_geo := jsonb_build_object('geom', private.geom_audit(r_new.geom));
      r_new.geom := null;
      if tg_table_name = 'admin_areas' then
        v_geo := v_geo || jsonb_build_object('geom_simple', private.geom_audit(r_new.geom_simple));
        r_new.geom_simple := null;
      end if;
      v_new := to_jsonb(r_new) || v_geo;
    else
      v_new := to_jsonb(r_new);
    end if;
  end if;

  if tg_op = 'UPDATE' then
    select coalesce(array_agg(n.key order by n.key), '{}'::text[])
      into v_changed
      from jsonb_each(v_new) as n
     where n.key not in ('updated_at', 'updated_by', 'version', 'sync_xid')
       and n.key <> all (v_ignore)
       and n.value is distinct from v_old -> n.key;

    if cardinality(v_changed) = 0 then
      return null;
    end if;
  end if;

  v_row := coalesce(v_new, v_old);

  insert into public.audit_log
    (table_name, row_id, op, old_data, new_data, changed_fields, row_version, user_id, device_id)
  values
    (tg_table_name,
     (v_row ->> 'id')::uuid,
     tg_op,
     v_old,
     v_new,
     v_changed,
     (v_row ->> 'version')::integer,
     coalesce(auth.uid(), (v_row ->> 'updated_by')::uuid),
     private.device_id());

  return null;
end;
$$;

comment on function private.tg_audit() is
  'AFTER INSERT/UPDATE/DELETE row trigger writing public.audit_log. Trigger arguments = extra columns ignored when detecting changes.';

-- -----------------------------------------------------------------------------
-- private.tg_no_hard_delete — soft delete only.
--
-- Rejects DELETE and TRUNCATE
--   * issued directly by an API role (anon, authenticated, service_role), and
--   * issued by SECURITY DEFINER code running on behalf of an end user
--     (JWT role anon/authenticated), e.g. sync_push or an import RPC.
-- Maintenance code without an end-user JWT (cron, migrations, service-role RPC
-- wrappers that prune ledgers) may still delete.
--
-- SECURITY INVOKER on purpose: current_user must be the real caller.
-- -----------------------------------------------------------------------------
create or replace function private.tg_no_hard_delete()
returns trigger
language plpgsql
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_jwt_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    nullif(current_setting('request.jwt.claim.role', true), '')
  );
begin
  if current_user in ('anon', 'authenticated', 'service_role', 'authenticator')
     or coalesce(v_jwt_role, '') in ('anon', 'authenticated') then
    raise exception 'hard_delete_forbidden'
      using errcode = 'PT403',
            detail = format('%s on %I.%I is not allowed', tg_op, tg_table_schema, tg_table_name),
            hint = 'Rows are soft-deleted: set deleted_at instead.';
  end if;
  return null;
end;
$$;

comment on function private.tg_no_hard_delete() is
  'BEFORE DELETE/TRUNCATE statement trigger: API roles and code acting for an end user can never hard-delete (PT403).';

-- -----------------------------------------------------------------------------
-- private.tg_append_only — audit_log and restricted_access_log can only grow.
-- (Retention jobs must disable the trigger explicitly as the table owner.)
-- -----------------------------------------------------------------------------
create or replace function private.tg_append_only()
returns trigger
language plpgsql
set search_path = public, extensions, private, pg_temp
as $$
begin
  raise exception 'append_only_table'
    using errcode = 'PT403',
          detail = format('%s on %I.%I is not allowed', tg_op, tg_table_schema, tg_table_name);
end;
$$;

comment on function private.tg_append_only() is
  'BEFORE UPDATE/DELETE/TRUNCATE statement trigger for append-only log tables (PT403).';

-- -----------------------------------------------------------------------------
-- Attach the triggers.
-- -----------------------------------------------------------------------------
do $$
declare
  -- Tables with the standard columns and sync_xid (ARCHITECTURE §3.2 pull order).
  v_sync text[] := array[
    'countries', 'admin_areas', 'branches', 'option_values', 'fx_rates', 'localities', 'donors',
    'projects', 'project_land', 'project_facilities', 'project_maintenance', 'project_photos',
    'project_donors', 'persons', 'project_staff', 'community_profiles', 'staff_compensation',
    'community_sensitive', 'person_merge_requests', 'sync_conflicts', 'notifications', 'map_packs'
  ];
  -- Tables with the standard columns but without sync_xid.
  v_plain text[] := array[
    'profiles', 'user_roles', 'devices', 'export_jobs', 'import_batches', 'import_rows', 'app_settings'
  ];
  -- Tables without the standard columns (logs / ledger).
  v_logs text[] := array['audit_log', 'sync_applied_ops', 'restricted_access_log'];
  -- Standard tables that are not audited: import_rows is a high-volume staging
  -- table whose effects are audited on the target rows (and kept in pre_image).
  v_no_audit text[] := array['import_rows'];
  t text;
begin
  foreach t in array v_sync loop
    execute format(
      'create trigger t10_std before insert or update on public.%I
         for each row execute function private.tg_std(''sync'')', t);
  end loop;

  foreach t in array v_plain loop
    execute format(
      'create trigger t10_std before insert or update on public.%I
         for each row execute function private.tg_std()', t);
  end loop;

  foreach t in array v_sync || v_plain loop
    continue when t = any (v_no_audit);
    if t = 'devices' then
      -- Heartbeat columns change on every sync call; they are not worth a log row.
      execute
        'create trigger t90_audit after insert or update or delete on public.devices
           for each row execute function private.tg_audit(
             ''last_seen_at'', ''last_push_at'', ''last_pull_at'', ''pending_ops'',
             ''pending_photos'', ''app_version'', ''user_agent'')';
    else
      execute format(
        'create trigger t90_audit after insert or update or delete on public.%I
           for each row execute function private.tg_audit()', t);
    end if;
  end loop;

  foreach t in array v_sync || v_plain || v_logs loop
    execute format(
      'create trigger t00_no_hard_delete before delete on public.%I
         for each statement execute function private.tg_no_hard_delete()', t);
    execute format(
      'create trigger t00_no_truncate before truncate on public.%I
         for each statement execute function private.tg_no_hard_delete()', t);
  end loop;
end
$$;

create trigger t01_append_only before update or delete on public.audit_log
  for each statement execute function private.tg_append_only();
create trigger t01_append_only_truncate before truncate on public.audit_log
  for each statement execute function private.tg_append_only();

create trigger t01_append_only before update or delete on public.restricted_access_log
  for each statement execute function private.tg_append_only();
create trigger t01_append_only_truncate before truncate on public.restricted_access_log
  for each statement execute function private.tg_append_only();

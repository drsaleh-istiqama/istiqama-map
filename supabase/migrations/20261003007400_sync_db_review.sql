-- =============================================================================
-- 0074  Database review (sync correctness + real-Supabase compatibility),
--       2026-10-05. Contract: docs/contracts/sync.md; tests: pgTAP file 25.
--
--   1. private.sync_apply_op (copy of 0023 with four changes)
--      a. base_version: anything but absent/null or a non-negative int4
--         (JSON number or digit string) is rejected as invalid_base_version
--         (was invalid_value for "abc", 1.5, true, {} and values > int4).
--      b. a base_version ABOVE the row's version (only possible after the
--         database was restored to an older state) is treated as unknown (0):
--         it used to count as "current" and silently overwrote fields other
--         devices had written.
--      c. an INSERT by another device counts only the fields it filled in
--         (non-null), so a 1:1 child created on two devices no longer yields
--         "null vs value" conflicts for fields the first device left empty.
--      d. when a caller writes a field again, his own open conflicts on that
--         field are withdrawn (soft-deleted): his newer value supersedes the
--         older proposal, which a reviewer could otherwise still apply.
--   2. project_photos: upload_state never goes back from 'uploaded' to
--      'pending' through sync_push (guard sync_guard_project_photos).
--   3. resolve_conflict(..., 'client'): validated like a write - the stored row
--      must stay in the reviewer's scope (location / branch conflicts could move
--      a record to another country or branch), branch belongs to country, locality of the
--      project's country (merged localities replaced), table guards.
--   4. private.sync_rebase(): works without session_replication_role (not
--      settable by the non-superuser "postgres" role of a managed Supabase
--      project): falls back to ALTER TABLE ... DISABLE/ENABLE TRIGGER.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. private.sync_apply_op
-- -----------------------------------------------------------------------------
create or replace function private.sync_apply_op(p_ctx private.sync_ctx, p_op jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_op_id       uuid    := (p_op ->> 'op_id')::uuid;
  v_table       text    := p_op ->> 'table';
  v_kind        text    := coalesce(p_op ->> 'kind', 'upsert');
  v_fields      jsonb   := coalesce(p_op -> 'fields', '{}'::jsonb);
  v_id          uuid;
  v_base        integer;
  reg           private.sync_tables%rowtype;
  v_sel         text;
  v_restricted  boolean;
  v_cur         jsonb;
  v_cur_version integer;
  v_redirected  boolean := false;
  v_is_insert   boolean := false;
  v_scope       private.sync_row_scope;
  v_writer      boolean;
  v_reviewer    boolean;
  v_writable    text[];
  v_all_cols    text[];
  v_ignored     text[]  := '{}';
  v_clean       jsonb   := '{}'::jsonb;
  v_guard       jsonb;
  v_force       jsonb   := '{}'::jsonb;
  v_on_change   jsonb   := '{}'::jsonb;
  v_has_geom    boolean := false;
  v_lon         double precision;
  v_lat         double precision;
  v_created     timestamptz;
  v_new         jsonb;
  v_delta       jsonb   := '{}'::jsonb;
  v_apply       jsonb   := '{}'::jsonb;
  v_others      text[]  := '{}';
  v_others_all  boolean := false;
  v_others_any  boolean := false;
  v_conf_id     uuid;
  v_conf_ids    uuid[]  := '{}';
  v_conf_fields text[]  := '{}';
  v_server_vals jsonb   := '{}'::jsonb;
  v_server_val  jsonb;
  v_version     integer;
  v_status      text;
  v_k           text;
  v_country     uuid;
  v_c2          uuid;
  v_b2          uuid;
  v_wrote       boolean := false;
  v_blind       boolean := false;
  v_id_taken    boolean := false;
  v_merged_fn   boolean;
  v_result      jsonb;
begin
  -- ---------------------------------------------------------------------------
  -- 1. Envelope
  -- ---------------------------------------------------------------------------
  if v_table is null then
    raise exception 'missing_table' using errcode = 'PT422';
  end if;
  if v_kind not in ('upsert', 'delete') then
    raise exception 'invalid_kind' using errcode = 'PT422', detail = 'kind must be "upsert" or "delete"';
  end if;
  v_id := (p_op ->> 'id')::uuid;
  if v_id is null then
    raise exception 'missing_id' using errcode = 'PT422';
  end if;
  if jsonb_typeof(v_fields) is distinct from 'object' then
    raise exception 'invalid_fields' using errcode = 'PT422', detail = 'fields must be a JSON object';
  end if;
  -- base_version: absent / null = 0, otherwise a non-negative integer (a JSON
  -- number, or a string of digits as older clients sent it). Anything else
  -- ("abc", 1.5, true, -1, objects, values beyond int4) is invalid_base_version
  -- instead of a generic invalid_value (review 2026-10-05).
  if jsonb_typeof(p_op -> 'base_version') is null or jsonb_typeof(p_op -> 'base_version') = 'null' then
    v_base := 0;
  elsif jsonb_typeof(p_op -> 'base_version') in ('number', 'string')
        and (p_op ->> 'base_version') ~ '^[0-9]{1,10}$'
        and (p_op ->> 'base_version')::bigint <= 2147483647 then
    v_base := (p_op ->> 'base_version')::integer;
  else
    raise exception 'invalid_base_version' using errcode = 'PT422',
      detail = 'base_version must be a non-negative integer (0 = created on this device)';
  end if;

  select * into reg from private.sync_tables s where s.table_name = v_table;
  if not found then
    raise exception 'unknown_table' using errcode = 'PT422',
      detail = format('"%s" is not a syncable table', v_table);
  end if;
  if reg.push_insert = 'none' and reg.push_update = 'none' and reg.push_delete = 'none' then
    raise exception 'table_not_writable' using errcode = 'PT403',
      detail = format('"%s" cannot be written through sync_push', v_table);
  end if;

  v_restricted := reg.audience = 'restricted';
  v_sel := private.sync_select_list(v_table, 't');

  -- ---------------------------------------------------------------------------
  -- 2. Current row (wire shape), locked for the rest of the transaction
  -- ---------------------------------------------------------------------------
  execute format(
    'select (select to_jsonb(x) from (select %s) x) from public.%I t where t.id = $1 for update of t',
    v_sel, v_table)
    into v_cur using v_id;

  -- ---------------------------------------------------------------------------
  -- 3. DELETE (soft)
  -- ---------------------------------------------------------------------------
  if v_kind = 'delete' then
    -- Restricted row, caller without restricted access to the country of the
    -- row the id names (or the id is unknown): a BLIND delete, addressed by the
    -- natural key and answered with the constant (sync.md §4.4). Only a caller
    -- who can see the stored row's restricted data deletes by id (below).
    if v_restricted and not coalesce(p_ctx.restricted_all, false) then
      if v_cur is not null then
        v_scope := private.sync_row_scope(reg, v_cur, v_id);
      end if;
      if v_cur is null or not private.sync_sees_restricted(p_ctx, v_scope.country_id) then
        return private.sync_delete_by_key(p_ctx, reg, v_op_id, v_fields);
      end if;
    end if;

    if v_cur is null then
      -- never reached the server (or already purged): nothing to do
      return jsonb_build_object('op_id', v_op_id, 'status', 'applied', 'version', null);
    end if;
    v_cur_version := (v_cur ->> 'version')::integer;
    v_scope       := private.sync_row_scope(reg, v_cur, v_id);
    if (v_cur ->> 'deleted_at') is not null then
      return jsonb_build_object('op_id', v_op_id, 'status', 'applied', 'version', v_cur_version);
    end if;

    v_writer   := private.sync_can(p_ctx, 'write',  reg.scope_kind, v_scope.country_id, v_scope.branch_id);
    v_reviewer := private.sync_can(p_ctx, 'review', reg.scope_kind, v_scope.country_id, v_scope.branch_id);
    if reg.scope_kind = 'donor'
       and not private.sync_donor_visible(p_ctx, v_id, (v_cur ->> 'created_by')::uuid) then
      v_writer := false; v_reviewer := false;   -- out_of_scope
    end if;
    perform private.sync_authorise(
      reg.push_delete, v_writer, v_reviewer,
      (v_cur ->> 'created_by')::uuid = p_ctx.uid,
      v_scope.project_creator = p_ctx.uid,
      v_scope.owner_id = p_ctx.uid);

    -- The workflow rules apply to a delete as to an edit, validated against the
    -- current server state (sync.md §4.3): e.g. a collector cannot delete his
    -- approved project or a locality that has been approved.
    if reg.guard is not null then
      execute format('select private.%I($1, $2, $3, $4, $5)', reg.guard)
        using p_ctx, 'delete'::text, v_cur, '{}'::jsonb, v_reviewer;
    end if;

    if v_base < v_cur_version then
      select count(*) > 0 into v_others_any
      from public.audit_log a
      where a.table_name = v_table and a.row_id = v_id and a.row_version > v_base
        and a.device_id is distinct from p_ctx.device;
    end if;

    execute format('update public.%I t set deleted_at = now() where t.id = $1 returning t.version', v_table)
      into v_version using v_id;

    if not v_reviewer and reg.push_delete = 'project_editor' and v_scope.project_state = 'approved' then
      update public.projects p set record_state = 'submitted'
      where p.id = v_scope.project_id and p.record_state = 'approved';
    end if;

    return jsonb_build_object(
      'op_id', v_op_id,
      'status', case when v_others_any then 'merged' else 'applied' end,
      'version', v_version);
  end if;

  -- ---------------------------------------------------------------------------
  -- 4. UPSERT: sanitise the payload
  --    Only writable columns survive; server-managed columns are dropped
  --    silently (created_at is taken from v_fields on INSERT only, see 5.),
  --    names that are not columns at all are reported back.
  -- ---------------------------------------------------------------------------
  v_writable := private.sync_writable_columns(v_table);

  select coalesce(array_agg(a.attname::text), '{}'::text[]) into v_all_cols
  from pg_attribute a
  where a.attrelid = format('public.%I', v_table)::regclass and a.attnum > 0 and not a.attisdropped;

  select coalesce(jsonb_object_agg(e.key, e.value) filter (where e.key = any (v_writable)), '{}'::jsonb),
         coalesce(array_agg(e.key order by e.key) filter (
                    where not (e.key = any (v_all_cols))
                      and not (reg.geom_point and e.key in ('lon', 'lat'))), '{}'::text[])
    into v_clean, v_ignored
  from jsonb_each(v_fields) e;

  if reg.geom_point and (v_fields ? 'lon' or v_fields ? 'lat') then
    if not (v_fields ? 'lon' and v_fields ? 'lat') then
      raise exception 'invalid_coordinates' using errcode = 'PT422', detail = 'lon and lat must be sent together';
    end if;
    v_lon := (v_fields ->> 'lon')::double precision;
    v_lat := (v_fields ->> 'lat')::double precision;
    if (v_lon is null) <> (v_lat is null) then
      raise exception 'invalid_coordinates' using errcode = 'PT422', detail = 'lon and lat must be sent together';
    end if;
    if v_lon is not null and not (v_lon between -180 and 180 and v_lat between -90 and 90) then
      raise exception 'invalid_coordinates' using errcode = 'PT422',
        detail = 'lon must be within -180..180 and lat within -90..90';
    end if;
    v_has_geom := true;
  end if;

  -- A project naming a locality that was merged into another one
  -- (merge_localities, migration 0071) - typically entered offline before the
  -- device pulled the merge - is pointed at the surviving locality; the device
  -- receives the stored value with its next pull.
  if v_table = 'projects' and jsonb_typeof(v_clean -> 'locality_id') = 'string' then
    if v_merged_fn is null then
      v_merged_fn := to_regprocedure('private.locality_merged_into(uuid)') is not null;
    end if;
    if v_merged_fn then
      v_clean := v_clean || jsonb_build_object('locality_id',
        private.locality_merged_into((v_clean ->> 'locality_id')::uuid));
    end if;
  end if;

  -- Blind writes (sync.md §4.4). A caller who cannot see the restricted data of
  -- the row's country (field collector, branch supervisor, ...) must get an
  -- answer that depends on his own input and scope only - never on what is
  -- stored (brief §3: no salary, no restricted data of others; acceptance
  -- criterion 5). Therefore such an operation
  --   * always names its parent (as an insert must), so it is addressed by its
  --     natural key and never by the row id: whether the op's id exists, holds
  --     the same key or was redirected earlier cannot change the outcome;
  --   * is validated as an insert of a new row before an existing row is
  --     touched (private.sync_probe_insert, step 6);
  --   * is answered with a constant result (step 8): whether the values were
  --     written, already equal or stored as conflicts for a country manager
  --     is not disclosed.
  -- The parent itself (project / project_staff) is data the caller may see.
  if v_restricted then
    if (v_clean ->> reg.scope_col) is not null then
      v_scope := private.sync_row_scope(reg, v_clean, v_id);
      v_blind := not private.sync_sees_restricted(p_ctx, v_scope.country_id);
    elsif v_cur is not null then
      v_scope := private.sync_row_scope(reg, v_cur, v_id);
      v_blind := not private.sync_sees_restricted(p_ctx, v_scope.country_id);
      if v_blind then
        -- the same answer, in the same order of checks, as for an insert
        -- without its parent (created_at first, see below)
        if nullif(btrim(v_fields ->> 'created_at'), '') is not null then
          v_created := (v_fields ->> 'created_at')::timestamptz;
        end if;
        raise exception 'parent_required' using errcode = 'PT422',
          detail = format('%s.%s is required', reg.table_name, reg.scope_col);
      end if;
    end if;
    if v_blind then
      v_id_taken := v_cur is not null;
      v_cur := null;
    end if;
  end if;

  -- The client's id is unknown on the server: from the client's point of view
  -- this is an insert. created_at is validated now, before the natural-key
  -- lookup, so that an insert redirected to an existing row refuses the same
  -- values as a real insert (the value itself is used by a real insert only).
  if v_cur is null and nullif(btrim(v_fields ->> 'created_at'), '') is not null then
    v_created := (v_fields ->> 'created_at')::timestamptz;
  end if;

  -- A natural-key column the client left out takes its column default, as it
  -- would in the insert (staff_compensation.effective_from = today): the
  -- lookup below must find the row that the insert would collide with.
  if v_cur is null and reg.natural_key is not null then
    v_clean := private.sync_natural_key_defaults(reg, v_clean);
  end if;

  -- Natural key: an insert for a parent that already has a live row (two devices
  -- created the same 1:1 child offline, or a restricted row is re-entered blind)
  -- is applied to the existing row. base_version 0 means "I have never seen the
  -- server row", so every field another device wrote can conflict.
  if v_cur is null and reg.natural_key is not null and v_clean ?& reg.natural_key then
    execute format(
      'select (select to_jsonb(x) from (select %1$s) x)'
      || ' from public.%2$I t, jsonb_populate_record(null::public.%2$I, $1) r'
      || ' where %3$s and t.deleted_at is null limit 1 for update of t',
      v_sel, v_table,
      (select string_agg(format('t.%1$I = r.%1$I', k), ' and ') from unnest(reg.natural_key) as k))
      into v_cur using v_clean;
    if v_cur is not null then
      v_redirected := true;
      v_id := (v_cur ->> 'id')::uuid;
      v_base := 0;
    end if;
  end if;

  if v_cur is null and v_id_taken then
    -- blind write whose id names another row (deleted, or with another natural
    -- key): the new row gets its own id (results of blind writes carry no id)
    v_id := private.uuid_v7();
  end if;

  if v_cur is null then
    -- -------------------------------------------------------------------------
    -- 5. INSERT
    -- -------------------------------------------------------------------------
    v_is_insert := true;

    -- scope defaults from the caller's roles
    if reg.scope_kind = 'row' then
      if (v_clean ->> 'branch_id') is null
         and not p_ctx.write_all and cardinality(p_ctx.write_c) = 0 and cardinality(p_ctx.write_b) = 1 then
        v_clean := v_clean || jsonb_build_object('branch_id', p_ctx.write_b[1]);
      end if;
      if (v_clean ->> 'country_id') is null then
        if (v_clean ->> 'branch_id') is not null then
          select b.country_id into v_country from public.branches b where b.id = (v_clean ->> 'branch_id')::uuid;
        elsif not p_ctx.write_all and cardinality(p_ctx.write_b) = 0 and cardinality(p_ctx.write_c) = 1 then
          v_country := p_ctx.write_c[1];
        end if;
        if v_country is not null then
          v_clean := v_clean || jsonb_build_object('country_id', v_country);
        end if;
      end if;
    elsif reg.scope_kind = 'country' then
      if (v_clean ->> 'country_id') is null and not p_ctx.write_all and cardinality(p_ctx.write_cs) = 1 then
        v_clean := v_clean || jsonb_build_object('country_id', p_ctx.write_cs[1]);
      end if;
    end if;

    v_scope := private.sync_row_scope(reg, v_clean, v_id);
    if v_scope.parent_deleted then
      raise exception 'parent_deleted' using errcode = 'PT409',
        detail = 'The parent record was deleted on the server.';
    end if;
    if reg.table_name = 'projects' then
      v_scope.project_creator := p_ctx.uid;
    end if;
    v_writer   := private.sync_can(p_ctx, 'write',  reg.scope_kind, v_scope.country_id, v_scope.branch_id);
    v_reviewer := private.sync_can(p_ctx, 'review', reg.scope_kind, v_scope.country_id, v_scope.branch_id);
    perform private.sync_authorise(
      reg.push_insert, v_writer, v_reviewer, true, v_scope.project_creator = p_ctx.uid, false);

    if reg.guard is not null then
      execute format('select private.%I($1, $2, $3, $4, $5)', reg.guard)
        into v_guard using p_ctx, 'insert'::text, null::jsonb, v_clean, v_reviewer;
      v_clean := v_guard -> 'fields';
      v_force := (v_guard -> 'force') || (v_guard -> 'on_change');
    end if;

    v_apply := v_clean || v_force;
    if v_has_geom then
      v_apply := v_apply || jsonb_build_object('geom',
        case when v_lon is null then null else format('SRID=4326;POINT(%s %s)', v_lon, v_lat) end);
    end if;

    -- Offline entry time. created_at is server-managed and never writable on
    -- update (private.tg_std keeps the old value), but an INSERT keeps the time
    -- at which the row was created on the device. private.tg_std replaces a
    -- value more than 5 minutes in the future by now(); a missing, blank or
    -- infinite value falls back to now() as well; a value that is not a
    -- timestamp has already rejected the operation (invalid_value, parsed
    -- above before the natural-key lookup), like any other field.
    if isfinite(v_created) then
      v_apply := v_apply || jsonb_build_object('created_at', v_created);
    end if;

    if v_apply = '{}'::jsonb then
      execute format('insert into public.%I (id) values ($1) returning version', v_table)
        into v_version using v_id;
    else
      execute format(
        'insert into public.%1$I (id, %2$s) select $1, %3$s from jsonb_populate_record(null::public.%1$I, $2) r returning version',
        v_table,
        (select string_agg(format('%I', k), ', ') from jsonb_object_keys(v_apply) as k),
        (select string_agg(format('r.%I', k), ', ') from jsonb_object_keys(v_apply) as k))
        into v_version using v_id, v_apply;
    end if;
    v_wrote := true;
    v_status := 'applied';
  else
    -- -------------------------------------------------------------------------
    -- 6. UPDATE with field-level merge
    -- -------------------------------------------------------------------------
    v_cur_version := (v_cur ->> 'version')::integer;

    if (v_cur ->> 'deleted_at') is not null then
      raise exception 'row_deleted' using errcode = 'PT409',
        detail = 'The record was deleted on the server; the edit cannot be applied.';
    end if;
    if v_base = 0 and not v_redirected and (v_cur ->> 'created_by')::uuid is distinct from p_ctx.uid then
      -- an "insert" for an id that belongs to somebody else's row
      raise exception 'id_taken' using errcode = 'PT409';
    end if;
    if v_base > v_cur_version then
      -- A base newer than the server row cannot come from an honest client of
      -- this server (versions only grow) - except after the database was
      -- restored to an older state, when queued edits still carry versions of
      -- the lost timeline. Applying it as "current" would silently overwrite
      -- what other devices wrote. Treat it as an unknown base instead (= 0):
      -- every field another device changed is a conflict (review 2026-10-05).
      v_base := 0;
    end if;

    v_scope    := private.sync_row_scope(reg, v_cur, v_id);
    if v_redirected and v_scope.parent_deleted then
      -- a redirected insert is still an insert: same rule (and same order of
      -- checks) as in 5., whether or not the natural key had a live row
      raise exception 'parent_deleted' using errcode = 'PT409',
        detail = 'The parent record was deleted on the server.';
    end if;
    v_writer   := private.sync_can(p_ctx, 'write',  reg.scope_kind, v_scope.country_id, v_scope.branch_id);
    v_reviewer := private.sync_can(p_ctx, 'review', reg.scope_kind, v_scope.country_id, v_scope.branch_id);
    if reg.scope_kind = 'donor'
       and not private.sync_donor_visible(p_ctx, v_id, (v_cur ->> 'created_by')::uuid) then
      -- a donor the caller could not have received (see sync_donor_visible)
      v_writer := false; v_reviewer := false;   -- out_of_scope
    end if;
    perform private.sync_authorise(
      reg.push_update, v_writer, v_reviewer,
      (v_cur ->> 'created_by')::uuid = p_ctx.uid,
      v_scope.project_creator = p_ctx.uid,
      v_scope.owner_id = p_ctx.uid);

    if v_blind then
      -- refuse exactly what the insert of 5. would refuse (the natural key had
      -- no live row): the outcome must not depend on the stored row
      perform private.sync_probe_insert(v_table,
        v_clean || case when isfinite(v_created) then jsonb_build_object('created_at', v_created)
                        else '{}'::jsonb end);
    end if;

    -- the parent link (and other immutable columns) cannot change
    foreach v_k in array reg.immutable_cols loop
      if v_clean ? v_k then
        if lower(v_clean ->> v_k) is distinct from lower(v_cur ->> v_k) then
          raise exception 'immutable_field' using errcode = 'PT422',
            detail = format('%s.%s cannot be changed after the row was created', v_table, v_k);
        end if;
        v_clean := v_clean - v_k;
      end if;
    end loop;

    if reg.guard is not null then
      execute format('select private.%I($1, $2, $3, $4, $5)', reg.guard)
        into v_guard using p_ctx, 'update'::text, v_cur, v_clean, v_reviewer;
      v_clean     := v_guard -> 'fields';
      v_force     := v_guard -> 'force';
      v_on_change := v_guard -> 'on_change';
    end if;

    -- delta = client fields whose (type-coerced) value differs from the row
    if v_clean <> '{}'::jsonb then
      execute format('select to_jsonb(r) from jsonb_populate_record(null::public.%I, $1) r', v_table)
        into v_new using v_clean;
      select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) into v_delta
      from jsonb_each(v_clean) e
      where (v_new -> e.key) is distinct from (v_cur -> e.key);
    end if;
    if v_has_geom
       and ((v_lon is null) <> ((v_cur ->> 'lon') is null)
            or (v_lon is not null and (v_cur ->> 'lon') is not null
                and (abs(v_lon - (v_cur ->> 'lon')::double precision) > 1e-9
                     or abs(v_lat - (v_cur ->> 'lat')::double precision) > 1e-9))) then
      v_delta := v_delta || jsonb_build_object('geom',
        case when v_lon is null then null else jsonb_build_object('lon', v_lon, 'lat', v_lat) end);
    end if;

    -- what did OTHER devices change since the client's base version?
    -- An INSERT by another device counts the fields it actually filled in
    -- (non-null values, geom included); a field it left empty is not a value
    -- "written elsewhere", so filling it in is not a conflict. (Until 0074 every
    -- field of a row inserted elsewhere conflicted, e.g. a 1:1 child created on
    -- two devices: "null vs <value>" conflicts nobody needs to decide.)
    if v_delta <> '{}'::jsonb and v_base < v_cur_version then
      select coalesce(array_agg(distinct f.name) filter (where f.name is not null), '{}'::text[]),
             count(*) > 0
        into v_others, v_others_any
      from public.audit_log a
      left join lateral (
        select u.name from unnest(a.changed_fields) as u(name) where a.op <> 'INSERT'
        union all
        select e.key from jsonb_each(coalesce(a.new_data, '{}'::jsonb)) e
        where a.op = 'INSERT' and jsonb_typeof(e.value) <> 'null'
      ) f on true
      where a.table_name = v_table
        and a.row_id = v_id
        and a.row_version > v_base
        and a.device_id is distinct from p_ctx.device;
    end if;

    for v_k in select jsonb_object_keys(v_delta) loop
      if v_k = any (v_others) then
        -- same field changed on both sides: a human decides
        v_server_val := case
          when v_k = 'geom' then
            case when (v_cur ->> 'lon') is null then 'null'::jsonb
                 else jsonb_build_object('lon', v_cur -> 'lon', 'lat', v_cur -> 'lat') end
          else v_cur -> v_k
        end;
        -- the same proposal is already waiting for a decision (e.g. the value
        -- was re-entered and pushed again as a new op): do not pile up conflicts
        select sc.id into v_conf_id
        from public.sync_conflicts sc
        where sc.table_name = v_table and sc.row_id = v_id and sc.field = v_k
          and sc.state = 'open' and sc.deleted_at is null
          and sc.client_value is not distinct from (v_delta -> v_k)
        order by sc.created_at
        limit 1;
        if v_conf_id is null then
          v_conf_id := private.uuid_v7();
          insert into public.sync_conflicts
            (id, table_name, row_id, project_id, field, base_version, server_value, client_value,
             client_user_id, client_device_id, client_op_id, state)
          values
            (v_conf_id, v_table, v_id, v_scope.project_id, v_k, v_base, v_server_val, v_delta -> v_k,
             p_ctx.uid, p_ctx.device, v_op_id, 'open');
        end if;
        v_conf_ids    := v_conf_ids || v_conf_id;
        v_conf_fields := v_conf_fields || v_k;
        if not v_restricted then
          v_server_vals := v_server_vals || jsonb_build_object(v_k, v_server_val);
        end if;
      else
        v_apply := v_apply || jsonb_build_object(v_k, v_delta -> v_k);
      end if;
    end loop;

    if v_apply <> '{}'::jsonb then
      v_apply := v_apply || v_on_change;
    end if;
    v_apply := v_apply || v_force;
    if v_apply ? 'geom' then
      v_apply := jsonb_set(v_apply, '{geom}',
        case when v_lon is null then 'null'::jsonb
             else to_jsonb(format('SRID=4326;POINT(%s %s)', v_lon, v_lat)) end);
    end if;

    if v_apply = '{}'::jsonb then
      v_version := v_cur_version;
    else
      execute format(
        'update public.%1$I t set %2$s from jsonb_populate_record(null::public.%1$I, $1) r where t.id = $2 returning t.version',
        v_table,
        (select string_agg(format('%1$I = r.%1$I', k), ', ') from jsonb_object_keys(v_apply) as k))
        into v_version using v_apply, v_id;
      v_wrote := true;
    end if;

    -- A field the caller has now written again supersedes the proposal he left
    -- open for it earlier (he saw server_values and decided anew): withdraw his
    -- own open conflicts on those fields, as a blind delete withdraws them
    -- (sync_delete_by_key). Otherwise a reviewer choosing "client" later would
    -- overwrite the newer value with the older proposal (review 2026-10-05).
    if v_wrote then
      update public.sync_conflicts sc
      set deleted_at = now()
      where sc.table_name = v_table
        and sc.row_id = v_id
        and sc.client_user_id = p_ctx.uid
        and sc.state = 'open'
        and sc.deleted_at is null
        and sc.field in (select jsonb_object_keys(v_delta) except select unnest(v_conf_fields));
    end if;

    v_status := case
      when cardinality(v_conf_ids) > 0 then 'conflict'
      when v_others_any then 'merged'
      else 'applied'
    end;
  end if;

  -- ---------------------------------------------------------------------------
  -- 7. Post-checks on what is actually stored (triggers derive country_id /
  --    admin_area_id from the location; nobody may end up writing outside
  --    their scope that way).
  -- ---------------------------------------------------------------------------
  if v_wrote and reg.scope_kind in ('row', 'country')
     and (v_is_insert or v_apply ?| array['country_id', 'branch_id', 'geom']) then
    execute format('select t.country_id, %s from public.%I t where t.id = $1',
                   case when reg.scope_kind = 'row' then 't.branch_id' else 'null::uuid' end, v_table)
      into v_c2, v_b2 using v_id;
    if not private.sync_can(p_ctx, 'write', reg.scope_kind, v_c2, v_b2)
       or (v_reviewer and not private.sync_can(p_ctx, 'review', reg.scope_kind, v_c2, v_b2)) then
      raise exception 'out_of_scope' using errcode = 'PT403',
        detail = 'The stored record falls outside your scope (country and area are derived from the location).';
    end if;
    if reg.scope_kind = 'row' and v_b2 is not null
       and not exists (select 1 from public.branches b
                       where b.id = v_b2 and b.country_id is not distinct from v_c2) then
      raise exception 'branch_country_mismatch' using errcode = 'PT422',
        detail = 'The branch does not belong to the country of the record.';
    end if;
  end if;

  -- A project names a locality of its own country only (the locality's names
  -- are copied into search_norm and shown with the project; a locality of
  -- another country is outside the caller's read scope). Checked on the stored
  -- row, because country_id is derived from the location.
  if v_wrote and v_table = 'projects'
     and (v_is_insert or v_apply ?| array['locality_id', 'country_id', 'geom']) then
    if exists (select 1
               from public.projects p
               join public.localities l on l.id = p.locality_id
               where p.id = v_id and l.country_id is distinct from p.country_id) then
      raise exception 'locality_country_mismatch' using errcode = 'PT422',
        detail = 'The locality belongs to another country than the record.';
    end if;
  end if;

  -- A collector changing a child that describes an approved project sends the
  -- project back to review (same rule as editing the project itself).
  if v_wrote and not v_reviewer and v_table <> 'projects' and v_scope.project_state = 'approved'
     and 'project_editor' in (reg.push_insert, reg.push_update) then
    update public.projects p set record_state = 'submitted'
    where p.id = v_scope.project_id and p.record_state = 'approved';
  end if;

  -- ---------------------------------------------------------------------------
  -- 8. Result. A blind write gets a constant answer: no version, no row id, no
  --    conflict ids or fields - what was written, already equal or left for a
  --    country manager (open sync_conflicts rows) is not disclosed.
  --    ignored_fields depends on the input only.
  -- ---------------------------------------------------------------------------
  if v_blind then
    v_result := jsonb_build_object('op_id', v_op_id, 'status', 'applied', 'version', null);
    if cardinality(v_ignored) > 0 then
      v_result := v_result || jsonb_build_object('ignored_fields', to_jsonb(v_ignored));
    end if;
    return v_result;
  end if;

  -- Optional keys are added one by one (jsonb_strip_nulls would also drop a
  -- null inside server_values, i.e. "the server value is empty").
  v_result := jsonb_build_object('op_id', v_op_id, 'status', v_status, 'version', v_version);
  if v_redirected then
    v_result := v_result || jsonb_build_object('row_id', v_id);
  end if;
  if cardinality(v_conf_ids) > 0 then
    v_result := v_result || jsonb_build_object(
      'conflict_ids', to_jsonb(v_conf_ids), 'conflict_fields', to_jsonb(v_conf_fields));
    if not v_restricted then
      -- never for restricted tables: the caller may be writing blind
      v_result := v_result || jsonb_build_object('server_values', v_server_vals);
    end if;
  end if;
  if cardinality(v_ignored) > 0 then
    v_result := v_result || jsonb_build_object('ignored_fields', to_jsonb(v_ignored));
  end if;
  return v_result;
end;
$$;

comment on function private.sync_apply_op(private.sync_ctx, jsonb) is
  'Applies one sync_push operation (migration 0023, revised by 0074: base_version validation, unknown future base, insert-filled fields only, superseded own conflicts withdrawn).';

-- -----------------------------------------------------------------------------
-- 2. project_photos: upload_state only moves forward (pending -> uploaded).
--
-- 'uploaded' means both objects are in Storage (photoQueue sets it after the
-- upload). A queued or replayed op must not send a photo back to 'pending':
-- reports, print and projects_page show uploaded photos only, and the device
-- would never upload again (its objects already exist). Refused explicitly
-- (invalid_transition) instead of being dropped silently, so that the device
-- and the server never disagree without a trace.
-- -----------------------------------------------------------------------------
create or replace function private.sync_guard_project_photos(
  p_ctx private.sync_ctx, p_op text, p_old jsonb, p_fields jsonb, p_reviewer boolean)
returns jsonb
language plpgsql
stable
set search_path = public, extensions, private, pg_temp
as $$
begin
  if p_op = 'update'
     and p_old ->> 'upload_state' = 'uploaded'
     and p_fields ? 'upload_state'
     and (p_fields ->> 'upload_state') is distinct from 'uploaded' then
    raise exception 'invalid_transition' using errcode = 'PT422',
      detail = 'upload_state cannot go back from uploaded to pending.';
  end if;
  return jsonb_build_object('fields', p_fields, 'force', '{}'::jsonb, 'on_change', '{}'::jsonb);
end;
$$;

revoke execute on function private.sync_guard_project_photos(private.sync_ctx, text, jsonb, jsonb, boolean)
  from public, anon, authenticated;

update private.sync_tables set guard = 'sync_guard_project_photos'
where table_name = 'project_photos' and guard is null;

-- -----------------------------------------------------------------------------
-- 3. resolve_conflict: "client" is validated like a write of that value.
--
-- Until 0074 the client value was written without any of the checks sync_push
-- applies, because the conflicting field had never been applied there:
--   * a location in another country (country_id / admin_area_id are derived
--     from the point) or another branch_id moved the record OUT of the
--     reviewer's own scope, and could leave a branch of one country on a
--     record of another (a Pemba supervisor could move a project to Kenya);
--   * a locality of another country, or one merged meanwhile;
--   * the table guards (person / donor visibility of project_staff and
--     project_donors links).
-- Now the same rules as in sync_apply_op step 7 hold for the stored row.
-- -----------------------------------------------------------------------------
create or replace function public.resolve_conflict(p_conflict_id uuid, p_choice text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  c         private.sync_ctx;
  k         public.sync_conflicts%rowtype;
  reg       private.sync_tables%rowtype;
  v_cur     jsonb;
  v_scope   private.sync_row_scope;
  v_version integer;
  v_value   jsonb;
  v_client  jsonb;
  v_lon     double precision;
  v_lat     double precision;
  v_state   text;
  v_c2      uuid;
  v_b2      uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = 'PT401';
  end if;
  if p_choice is null or p_choice not in ('server', 'client') then
    raise exception 'invalid_choice' using errcode = 'PT422', detail = 'p_choice must be "server" or "client"';
  end if;
  if not private.session_ok() then
    raise exception 'session_revoked' using errcode = 'PT403';
  end if;
  perform private.rate_limit('resolve_conflict', 120, interval '1 minute');
  c := private.sync_ctx();

  select * into k from public.sync_conflicts sc
  where sc.id = p_conflict_id and sc.deleted_at is null
  for update;
  if not found then
    raise exception 'conflict_not_found' using errcode = 'PT404';
  end if;

  select * into reg from private.sync_tables s where s.table_name = k.table_name;
  if not found then
    raise exception 'conflict_not_found' using errcode = 'PT404';
  end if;

  -- the row the conflict is about (wire shape), locked
  execute format(
    'select (select to_jsonb(x) from (select %s) x) from public.%I t where t.id = $1 for update of t',
    private.sync_select_list(k.table_name, 't'), k.table_name)
    into v_cur using k.row_id;
  if v_cur is null then
    raise exception 'row_missing' using errcode = 'PT409';
  end if;

  -- authorisation: reviewer of that row's scope (+ restricted access when needed).
  -- Checked BEFORE the state so that an outsider learns nothing about the conflict.
  v_scope := private.sync_row_scope(reg, v_cur, k.row_id);
  if not private.sync_can(c, 'review', reg.scope_kind, v_scope.country_id, v_scope.branch_id)
     -- rows without a country/branch (donors) are decided by global reviewers,
     -- the only ones who can see such a conflict
     or (reg.scope_kind in ('global', 'donor') and not c.review_all) then
    raise exception 'out_of_scope' using errcode = 'PT403',
      detail = 'Only a reviewer of the record''s country/branch may resolve this conflict.';
  end if;
  if reg.audience = 'restricted' then
    if not (c.restricted_all or coalesce(v_scope.country_id = any (c.restricted_c), false)) then
      raise exception 'out_of_scope' using errcode = 'PT403',
        detail = 'This conflict is about restricted data.';
    end if;
    perform private.log_restricted(k.table_name, array[k.row_id], 'resolve_conflict');
  end if;

  if k.state <> 'open' then
    raise exception 'conflict_already_resolved' using errcode = 'PT409',
      detail = format('state is %s', k.state);
  end if;

  v_version := (v_cur ->> 'version')::integer;

  if p_choice = 'client' then
    if (v_cur ->> 'deleted_at') is not null then
      raise exception 'row_deleted' using errcode = 'PT409',
        detail = 'The record was deleted; only "server" can be chosen.';
    end if;

    v_client := k.client_value;
    if k.field = 'geom' and reg.geom_point then
      if v_client is null or jsonb_typeof(v_client) = 'null' then
        v_value := jsonb_build_object('geom', null);
      else
        v_lon := (v_client ->> 'lon')::double precision;
        v_lat := (v_client ->> 'lat')::double precision;
        if v_lon is null or v_lat is null
           or not (v_lon between -180 and 180 and v_lat between -90 and 90) then
          raise exception 'invalid_coordinates' using errcode = 'PT422';
        end if;
        v_value := jsonb_build_object('geom', format('SRID=4326;POINT(%s %s)', v_lon, v_lat));
      end if;
    else
      if not (k.field = any (private.sync_writable_columns(k.table_name))) then
        raise exception 'field_not_writable' using errcode = 'PT422',
          detail = format('%s.%s cannot be written', k.table_name, k.field);
      end if;
      -- a locality merged since the conflict was recorded: its survivor (as sync_push does)
      if k.table_name = 'projects' and k.field = 'locality_id' and jsonb_typeof(v_client) = 'string'
         and to_regprocedure('private.locality_merged_into(uuid)') is not null then
        v_client := to_jsonb(private.locality_merged_into((v_client #>> '{}')::uuid));
      end if;
      v_value := jsonb_build_object(k.field, v_client);
    end if;

    -- the table's workflow guard, as for an update of this field by a reviewer
    if reg.guard is not null and k.field <> 'geom' then
      execute format('select private.%I($1, $2, $3, $4, $5)', reg.guard)
        using c, 'update'::text, v_cur, v_value, true;
    end if;

    execute format(
      'update public.%1$I t set %2$I = r.%2$I from jsonb_populate_record(null::public.%1$I, $1) r'
      || ' where t.id = $2 returning t.version',
      k.table_name, (select jsonb_object_keys(v_value) limit 1))
      into v_version using v_value, k.row_id;

    -- the stored row (country / admin area are derived from the point) must stay
    -- inside the reviewer's scope, its branch must belong to its country, and a
    -- project's locality to the project's country (sync_apply_op step 7)
    if reg.scope_kind in ('row', 'country') and k.field in ('geom', 'country_id', 'branch_id') then
      execute format('select t.country_id, %s from public.%I t where t.id = $1',
                     case when reg.scope_kind = 'row' then 't.branch_id' else 'null::uuid' end, k.table_name)
        into v_c2, v_b2 using k.row_id;
      if not private.sync_can(c, 'write', reg.scope_kind, v_c2, v_b2)
         or not private.sync_can(c, 'review', reg.scope_kind, v_c2, v_b2) then
        raise exception 'out_of_scope' using errcode = 'PT403',
          detail = 'The client value would move the record outside your scope (country and area are derived from the location).';
      end if;
      if reg.scope_kind = 'row' and v_b2 is not null
         and not exists (select 1 from public.branches b
                         where b.id = v_b2 and b.country_id is not distinct from v_c2) then
        raise exception 'branch_country_mismatch' using errcode = 'PT422',
          detail = 'The branch does not belong to the country of the record.';
      end if;
    end if;
    if k.table_name = 'projects' and k.field in ('locality_id', 'geom', 'country_id')
       and exists (select 1
                   from public.projects p
                   join public.localities l on l.id = p.locality_id
                   where p.id = k.row_id and l.country_id is distinct from p.country_id) then
      raise exception 'locality_country_mismatch' using errcode = 'PT422',
        detail = 'The locality belongs to another country than the record.';
    end if;

    v_state := 'resolved_client';
  else
    v_state := 'resolved_server';
  end if;

  update public.sync_conflicts sc
  set state = v_state, resolved_by = v_uid, resolved_at = now()
  where sc.id = k.id;

  return jsonb_build_object(
    'id', k.id,
    'state', v_state,
    'table', k.table_name,
    'row_id', k.row_id,
    'field', k.field,
    'version', v_version,
    'server_time', clock_timestamp());
end;
$$;

comment on function public.resolve_conflict(uuid, text) is
  'Reviewer decision on a sync conflict: "client" applies the client value as a new row version (validated like a sync_push write: scope of the stored row, branch/country, locality, guards), "server" keeps the current value; stamps state/resolved_by/resolved_at.';

revoke execute on function public.resolve_conflict(uuid, text) from public, anon;
grant  execute on function public.resolve_conflict(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 4. sync_rebase on a managed Supabase project.
--
-- session_replication_role is a superuser parameter. The role that restores a
-- dump into a new hosted / self-hosted Supabase project is "postgres", which is
-- not a superuser; if the platform does not grant it SET on that parameter the
-- old function failed with "permission denied to set parameter". Fallback: the
-- table owner (postgres) disables exactly the user triggers that are enabled on
-- each registry table for the statement and enables them again (ALTER TABLE is
-- transactional: an error restores everything). Internal FK triggers stay on;
-- an UPDATE of sync_xid alone does not run FK checks anyway.
-- Setting app.sync_rebase_mode = 'alter' forces the fallback (pgTAP file 25).
-- -----------------------------------------------------------------------------
create or replace function private.sync_rebase()
returns jsonb
language plpgsql
volatile
set search_path = public, extensions, private, pg_temp
as $$
declare
  r         record;
  v_xid     bigint := private.current_xid();
  v_rows    bigint;
  v_total   bigint := 0;
  v_replica boolean := coalesce(current_setting('app.sync_rebase_mode', true), '') <> 'alter';
  v_trg     text[];
  v_name    text;
begin
  if v_replica then
    begin
      -- skips user triggers (std/audit) and FK checks for this transaction only
      set local session_replication_role = replica;
    exception when insufficient_privilege then
      v_replica := false;
    end;
  end if;

  for r in select table_name from private.sync_tables order by pull_order loop
    v_trg := null;
    if not v_replica then
      select array_agg(tg.tgname::text order by tg.tgname) into v_trg
      from pg_catalog.pg_trigger tg
      where tg.tgrelid = format('public.%I', r.table_name)::regclass
        and not tg.tgisinternal
        and tg.tgenabled = 'O';
      foreach v_name in array coalesce(v_trg, '{}'::text[]) loop
        execute format('alter table public.%I disable trigger %I', r.table_name, v_name);
      end loop;
    end if;

    execute format('update public.%I set sync_xid = $1 where sync_xid <> $1', r.table_name) using v_xid;
    get diagnostics v_rows = row_count;
    v_total := v_total + v_rows;

    foreach v_name in array coalesce(v_trg, '{}'::text[]) loop
      execute format('alter table public.%I enable trigger %I', r.table_name, v_name);
    end loop;
  end loop;

  if v_replica then
    set local session_replication_role = origin;
  end if;
  perform private.sync_rotate_epoch();
  return jsonb_build_object('sync_xid', v_xid, 'rows', v_total,
                            'mode', case when v_replica then 'replica' else 'alter_table' end);
end;
$$;

comment on function private.sync_rebase() is
  'Maintenance after restoring a dump into a new cluster: re-stamps sync_xid on all syncable rows (triggers bypassed: session_replication_role, or ALTER TABLE ... DISABLE TRIGGER where that parameter is not allowed) and rotates the sync epoch (full client resync). See docs/contracts/sync.md.';

revoke execute on function private.sync_rebase() from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Registry consistency, privileges, schema version
-- -----------------------------------------------------------------------------
do $$
begin
  perform private.sync_refresh();
end
$$;

revoke execute on function private.sync_apply_op(private.sync_ctx, jsonb) from public, anon, authenticated;

select private.harden_private_schema();

create or replace function private.schema_version()
returns text
language sql
immutable
parallel safe
set search_path = public, extensions, private, pg_temp
as $$
  select '20261003007400'::text;
$$;

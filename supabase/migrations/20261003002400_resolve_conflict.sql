-- =============================================================================
-- 0024  resolve_conflict — a reviewer decides a field conflict
--       (docs/ARCHITECTURE.md §2.4, §3.1 rule 4; brief §4.3)
--
--   public.resolve_conflict(p_conflict_id uuid, p_choice text) -> jsonb
--     p_choice = 'server'  keep the value that is on the server now
--     p_choice = 'client'  write the client's value (a new row version, which
--                          then reaches every device through sync_pull)
--
-- Allowed for a reviewer of the row the conflict is about (branch supervisor,
-- country manager, HQ). Conflicts on restricted tables additionally require
-- restricted access (they show restricted values) and the read is logged.
-- =============================================================================

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
  v_lon     double precision;
  v_lat     double precision;
  v_state   text;
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

    if k.field = 'geom' and reg.geom_point then
      if k.client_value is null or jsonb_typeof(k.client_value) = 'null' then
        v_value := jsonb_build_object('geom', null);
      else
        v_lon := (k.client_value ->> 'lon')::double precision;
        v_lat := (k.client_value ->> 'lat')::double precision;
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
      v_value := jsonb_build_object(k.field, k.client_value);
    end if;

    execute format(
      'update public.%1$I t set %2$I = r.%2$I from jsonb_populate_record(null::public.%1$I, $1) r'
      || ' where t.id = $2 returning t.version',
      k.table_name, (select jsonb_object_keys(v_value) limit 1))
      into v_version using v_value, k.row_id;
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
  'Reviewer decision on a sync conflict: "client" applies the client value as a new row version, "server" keeps the current value; stamps state/resolved_by/resolved_at.';

revoke execute on function public.resolve_conflict(uuid, text) from public, anon;
grant  execute on function public.resolve_conflict(uuid, text) to authenticated;

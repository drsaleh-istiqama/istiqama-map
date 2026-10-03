-- =============================================================================
-- 0022  sync_pull — scoped, paged change feed (docs/ARCHITECTURE.md §3.2, brief §4)
--
-- WHY THE CURSOR IS A TRANSACTION-ID WINDOW (decision D2)
--
-- Every syncable row carries sync_xid = id of the (top-level) transaction that
-- last wrote it. A pull ROUND fixes
--
--     hi = private.safe_xid() = xmin of the current snapshot
--
-- i.e. the oldest transaction id that was still running when the round began.
-- Every transaction with an id below hi has already finished, so every row
-- with sync_xid < hi is either committed and visible, or aborted and gone —
-- nothing with such an id can appear later. The round returns exactly the rows
-- with lo <= sync_xid < hi and the next round starts at lo = hi.
--
-- A transaction that is still open while the round runs has id >= hi (that is
-- what xmin means), so the rows it is writing are outside this round's window
-- and INSIDE the next one: they are delayed, never skipped. The same holds for
-- transactions that committed with an id above a still-running one: their rows
-- wait until the older transaction finishes. A timestamp or sequence cursor
-- cannot give this guarantee, because commit order differs from the order in
-- which timestamps/sequence values are drawn.
--
-- A row updated while a round is being paged simply leaves the window (its new
-- sync_xid is >= hi) and is delivered by the next round; rows never move INTO
-- the window, so keyset paging inside a round is stable.
--
-- PAGING ORDER
--
--   * normally (sync_xid, id): an incremental round touches only the few index
--     entries of its window, whatever the size of the tables;
--   * in a FIRST round (lo = 0) of a scoped caller, child tables are paged by
--     (parent id, id) instead: the scan is driven by the caller's projects, so
--     a page costs about as much as the rows it returns. Walking the whole
--     (sync_xid, id) index of a million-row child table to pick the 2 % that
--     belong to one branch would cost 10-50x more per page.
--
-- Scope: rows are filtered with the caller's scope arrays, fetched once
-- (private.sync_ctx) and compared with = any(...) / inlined single values.
-- No per-row function calls.
--
-- IDLE POLLS
--
-- Most calls are incremental rounds in which nothing (or one table) changed.
-- private.sync_changed_tables(lo, hi) answers "which tables have any row in the
-- window" with one cached-plan statement (22 index probes); only those tables
-- are queried. The function is GENERATED from the registry by
-- private.sync_refresh(); call that again after changing private.sync_tables.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Generator for private.sync_changed_tables(p_lo, p_hi) -> text[]
-- Element 1 is '#<number of registry tables>' so that sync_pull can detect a
-- function that is older than the registry and fall back to querying every
-- table.
-- -----------------------------------------------------------------------------
create or replace function private.sync_refresh()
returns integer
language plpgsql
volatile
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_cases text;
  v_count integer;
  v_made  integer;
begin
  v_made := private.sync_ensure_indexes();

  select string_agg(
           format('case when exists (select 1 from public.%I t where t.sync_xid >= p_lo and t.sync_xid < p_hi) then %L end',
                  s.table_name, s.table_name),
           E',\n      ' order by s.pull_order),
         count(*)
    into v_cases, v_count
  from private.sync_tables s;

  execute format(
    'create or replace function private.sync_changed_tables(p_lo bigint, p_hi bigint)'
    || ' returns text[] language plpgsql stable security definer'
    || ' set search_path = public, extensions, private, pg_temp as $body$'
    || ' begin return array_remove(array[%L, %s]::text[], null); end; $body$',
    '#' || v_count, v_cases);

  execute 'revoke execute on function private.sync_changed_tables(bigint, bigint) from public, anon, authenticated';
  return v_made;
end;
$$;

comment on function private.sync_refresh() is
  'Run after changing private.sync_tables: validates the registry, creates missing sync indexes and regenerates private.sync_changed_tables().';

revoke execute on function private.sync_refresh() from public, anon, authenticated;

do $$
begin
  perform private.sync_refresh();
end
$$;

create or replace function public.sync_pull(p_cursor jsonb default null, p_limit integer default 500)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
-- short keyset pages: starting parallel workers costs more than it saves
set max_parallel_workers_per_gather = 0
as $$
declare
  v_uid        uuid := auth.uid();
  v_limit      integer := least(greatest(coalesce(p_limit, 500), 1), 1000);
  c            private.sync_ctx;
  v_epoch      text;
  v_now_hi     bigint;
  v_lo         bigint;
  v_hi         bigint;
  v_t          integer;
  v_x          bigint;
  v_k          uuid;
  v_id         uuid;
  v_reset      boolean := false;
  v_done       boolean := true;
  v_remaining  integer;
  v_changes    jsonb := '[]'::jsonb;
  reg          private.sync_tables%rowtype;
  v_restricted text[];
  -- per table
  a_all        boolean;
  a_c          uuid[];
  a_b          uuid[];
  v_any        boolean;
  v_by_parent  boolean;
  v_join       text;
  v_pred       text;
  v_log        text;
  v_keyset     text;
  v_sql        text;
  v_rows       jsonb;
  v_n          integer;
  v_last_x     bigint;
  v_last_k     uuid;
  v_last_id    uuid;
  v_ids        uuid[];
  v_r_pred     text;
  v_gone       jsonb;
  v_changed    text[];
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = 'PT401';
  end if;
  if not private.session_ok() then
    raise exception 'session_revoked' using errcode = 'PT403',
      detail = 'The session, the account or this device has been revoked.';
  end if;

  perform private.rate_limit('sync_pull', 600, interval '1 minute');

  c := private.sync_ctx();
  v_epoch := c.epoch;
  v_now_hi := private.safe_xid();

  -- ---------------------------------------------------------------------------
  -- Cursor. Opaque to the client: {lo, hi, t, x | k, id, e}
  --   lo, hi  window of the round (hi = null: start a new round at lo)
  --   t       pull_order of the table being read
  --   x, id   keyset position (sync_xid, id) of the last row sent, or
  --   k, id   keyset position (parent id, id) in a parent-ordered first round
  --   e       scope_epoch the cursor was issued for
  -- ---------------------------------------------------------------------------
  if p_cursor is not null and jsonb_typeof(p_cursor) = 'object' then
    begin
      v_lo := (p_cursor ->> 'lo')::bigint;
      v_hi := (p_cursor ->> 'hi')::bigint;
      v_t  := (p_cursor ->> 't')::integer;
      v_x  := (p_cursor ->> 'x')::bigint;
      v_k  := (p_cursor ->> 'k')::uuid;
      v_id := (p_cursor ->> 'id')::uuid;
    exception when others then
      raise exception 'invalid_cursor' using errcode = 'PT422';
    end;
    if v_lo is null or v_lo < 0
       or coalesce(p_cursor ->> 'e', '') <> v_epoch       -- issued for another scope
       or v_lo > v_now_hi                                 -- issued by another cluster
       or (v_hi is not null and (v_hi > v_now_hi or v_hi < v_lo)) then
      v_reset := true;
    end if;
  elsif p_cursor is not null and jsonb_typeof(p_cursor) <> 'null' then
    raise exception 'invalid_cursor' using errcode = 'PT422';
  else
    v_lo := 0;
  end if;

  if v_reset then
    -- The client must discard its scoped tables (same handling as a changed
    -- scope_epoch); the response says so with "reset": true.
    v_lo := 0; v_hi := null;
  end if;

  if v_hi is null then
    -- new round
    v_hi := v_now_hi;
    v_t  := 0;
    v_id := null;
  end if;
  v_t := coalesce(v_t, 0);
  if v_id is null or (v_x is null and v_k is null) then
    v_x := null; v_k := null; v_id := null;
  end if;

  select coalesce(array_agg(r.table_name), '{}'::text[]) into v_restricted
  from private.sync_tables r
  where r.audience = 'restricted';

  v_remaining := v_limit;

  -- Incremental round: find the tables that have anything in the window with
  -- one cached statement, so that an idle poll does not plan 22 queries.
  if v_lo > 0 and v_hi > v_lo then
    v_changed := private.sync_changed_tables(v_lo, v_hi);
    if v_changed[1] is distinct from '#' || (select count(*) from private.sync_tables)::text then
      v_changed := null;   -- generated function is older than the registry: query every table
    end if;
  end if;

  if v_hi > v_lo then
    for reg in
      select * from private.sync_tables s where s.pull_order >= v_t order by s.pull_order
    loop
      if reg.pull_order > v_t then
        v_x := null; v_k := null; v_id := null;
      end if;

      -- capability triple for this table's audience
      case reg.audience
        when 'people' then a_all := c.people_all; a_c := c.people_c; a_b := c.people_b;
        when 'review' then a_all := c.review_all; a_c := c.review_c; a_b := c.review_b;
        when 'restricted' then a_all := c.restricted_all; a_c := c.restricted_c; a_b := '{}'::uuid[];
        else a_all := c.read_all; a_c := c.read_c; a_b := c.read_b;
      end case;
      v_any := a_all or cardinality(a_c) > 0 or cardinality(a_b) > 0;

      v_join := '';
      v_log  := case when reg.audience = 'restricted' then 'true' else 'false' end;
      -- first round of a scoped caller on a child table: page by (parent id, id)
      v_by_parent := v_lo = 0 and not a_all and reg.scope_kind in ('project', 'staff');

      case reg.scope_kind
        when 'own' then
          v_pred := format('t.%I = $8', reg.scope_col);
        when 'global' then
          v_pred := case when v_any then 'true' else 'false' end;
        when 'country' then
          -- country ids reachable through the capability (already in the context
          -- for the two audiences that have country-scoped tables)
          a_c := case reg.audience
                   when 'all' then c.read_cs
                   when 'review' then c.review_cs
                   else private.sync_country_set(a_c, a_b)
                 end;
          v_pred := private.sync_scope_pred('t', a_all, a_c, '{}'::uuid[]);
        when 'row' then
          v_pred := private.sync_scope_pred('t', a_all, a_c, a_b);
        when 'project' then
          v_pred := private.sync_scope_pred('p', a_all, a_c, a_b);
          if not a_all then
            v_join := format('join public.projects p on p.id = t.%I', reg.scope_col);
          end if;
        when 'staff' then
          v_pred := private.sync_scope_pred('p', a_all, a_c, a_b);
          if not a_all then
            v_join := format(
              'join public.project_staff s on s.id = t.%I join public.projects p on p.id = s.project_id',
              reg.scope_col);
          end if;
        when 'person' then
          v_pred := private.sync_scope_pred('p', a_all, a_c, a_b);
          if not a_all then
            v_join := format('join public.persons p on p.id = t.%I', reg.scope_col);
          end if;
        when 'conflict' then
          -- A conflict is visible to whoever may review the row it is about
          -- (same rule as the RLS policy sync_conflicts_select): project scope
          -- via project_id, persons and localities via the row itself, anything
          -- else (donors) only for global reviewers. Conflicts on restricted
          -- tables additionally need restricted access (they carry restricted
          -- values) and are never readable through direct SQL.
          if not v_any then
            v_pred := 'false';
          else
            v_r_pred := case
              when c.restricted_all then 'true'
              when cardinality(c.restricted_c) = 0 then 'false'
              else 'exists (select 1 from public.projects rp where rp.id = t.project_id and rp.country_id = any ($9))'
            end;
            v_log := format('(t.table_name = any (%L::text[]))', v_restricted);
            if a_all then
              v_pred := format('(t.table_name <> all (%L::text[]) or %s)', v_restricted, v_r_pred);
            else
              v_pred := format(
                '(case'
                || ' when t.project_id is not null then exists (select 1 from public.projects p where p.id = t.project_id and %1$s)'
                || ' when t.table_name = ''persons'' then exists (select 1 from public.persons p where p.id = t.row_id and %1$s)'
                || ' when t.table_name = ''localities'' then exists (select 1 from public.localities p where p.id = t.row_id and p.country_id = any (%2$L::uuid[]))'
                || ' else false end'   -- unscoped rows (donors): global reviewers only
                || ' and (t.table_name <> all (%3$L::text[]) or %4$s))',
                private.sync_scope_pred('p', false, a_c, a_b),
                c.review_cs, v_restricted, v_r_pred);
            end if;
          end if;
      end case;

      if v_pred = 'false' then
        continue;
      end if;

      v_n := 0; v_rows := '[]'::jsonb; v_ids := null;
      v_last_x := null; v_last_k := null; v_last_id := null;

      if v_changed is null or reg.table_name = any (v_changed) then

      -- Keyset of the page: after the last row sent, in the order of this round.
      if v_by_parent then
        -- the parent-side bound is redundant but lets the scan start at the
        -- right parent instead of re-reading the earlier ones
        v_keyset := case when v_k is not null
          then format('and (t.%1$I, t.id) > ($10, $4) and %2$s.id >= $10',
                      reg.scope_col, case reg.scope_kind when 'staff' then 's' else 'p' end)
          else '' end;
      else
        v_keyset := case when v_x is not null then 'and (t.sync_xid, t.id) > ($3, $4)' else '' end;
      end if;

      -- One statement per table, built once per call. The inner query is the
      -- keyset page inside the round's window; the outer query folds it into
      -- one JSON array and remembers the last key.
      v_sql := format(
        'with page as materialized ('
        || ' select %8$s as k1, t.id as rid, t.sync_xid as sx, %9$s as pk, %1$s as lg,'
        || '        (select to_jsonb(x) from (select %2$s) x) as j'
        || ' from public.%3$I t %4$s'
        || ' where t.sync_xid >= $1 and t.sync_xid < $2 %5$s %6$s and %7$s'
        || ' order by %8$s, t.id'
        || ' limit $5)'
        || ' select coalesce(jsonb_agg(j order by k1, rid), ''[]''::jsonb), count(*)::integer,'
        || '        (array_agg(sx order by k1 desc, rid desc))[1],'
        || '        (array_agg(pk order by k1 desc, rid desc))[1],'
        || '        (array_agg(rid order by k1 desc, rid desc))[1],'
        || '        array_agg(rid) filter (where lg)'
        || ' from page',
        v_log,
        private.sync_select_list(reg.table_name, 't'),
        reg.table_name,
        v_join,
        v_keyset,
        -- a first round (lo = 0) feeds an empty local database: no tombstones needed
        case when v_lo = 0 then 'and t.deleted_at is null' else '' end,
        v_pred,
        case when v_by_parent then format('t.%I', reg.scope_col) else 't.sync_xid' end,
        case when v_by_parent then format('t.%I', reg.scope_col) else 'null::uuid' end);

      execute v_sql
        into v_rows, v_n, v_last_x, v_last_k, v_last_id, v_ids
        using v_lo, v_hi, v_x, v_id, v_remaining, a_c, a_b, v_uid, c.restricted_c, v_k;

      end if;   -- table has rows in the window

      v_remaining := v_remaining - v_n;

      -- Rows that left the caller's scope (re-assigned to another branch /
      -- country) inside this window: reported once per round, when the table
      -- is finished, so that the device can drop its stale copies.
      v_gone := null;
      if v_remaining > 0 and reg.scope_kind = 'row' and v_lo > 0 and not a_all
         and exists (select 1 from private.sync_scope_moves m
                     where m.table_name = reg.table_name and m.sync_xid >= v_lo and m.sync_xid < v_hi) then
        v_gone := private.sync_gone(reg.table_name, v_lo, v_hi, a_c, a_b, v_pred);
      end if;

      if v_n > 0 or v_gone is not null then
        v_changes := v_changes || jsonb_build_array(
          jsonb_build_object('table', reg.table_name, 'rows', v_rows)
          || case when v_gone is not null then jsonb_build_object('gone', v_gone) else '{}'::jsonb end);
      end if;

      -- brief §11: every read of restricted rows is logged (one row per page)
      if v_n > 0 and v_ids is not null then
        if reg.audience = 'restricted' then
          perform private.log_restricted(reg.table_name, v_ids, 'sync_pull');
        else
          perform private.sync_log_conflict_read(v_ids, 'sync_pull');
        end if;
      end if;

      if v_remaining <= 0 then
        -- page is full: continue in this table after the last row sent
        v_t  := reg.pull_order;
        v_id := v_last_id;
        if v_by_parent then
          v_k := v_last_k; v_x := null;
        else
          v_x := v_last_x; v_k := null;
        end if;
        v_done := false;
        exit;
      end if;
    end loop;
  end if;

  if v_done then
    -- Round complete: the next call starts a new round at lo = hi.
    -- Heartbeat at most once per round (never per page).
    if c.device is not null then
      update public.devices d
      set last_pull_at = now(), last_seen_at = now()
      where d.user_id = v_uid
        and d.device_id = c.device
        and (d.last_pull_at is null or d.last_pull_at < now() - interval '30 seconds');
    end if;

    return jsonb_build_object(
      'changes', v_changes,
      'cursor', jsonb_build_object('lo', v_hi, 'hi', null, 'e', v_epoch),
      'done', true,
      'reset', v_reset,
      'server_time', clock_timestamp(),
      'scope_epoch', v_epoch);
  end if;

  return jsonb_build_object(
    'changes', v_changes,
    'cursor', jsonb_strip_nulls(jsonb_build_object(
      'lo', v_lo, 'hi', v_hi, 't', v_t, 'x', v_x, 'k', v_k, 'id', v_id, 'e', v_epoch)),
    'done', false,
    'reset', v_reset,
    'server_time', clock_timestamp(),
    'scope_epoch', v_epoch);
end;
$$;

comment on function public.sync_pull(jsonb, integer) is
  'Change feed for the caller''s scope: rows with lo <= sync_xid < hi (hi = snapshot xmin), keyset-paged per table in registry order. Restricted tables only for country managers / HQ, every page logged.';

-- -----------------------------------------------------------------------------
-- Conflicts about restricted tables carry restricted values (server_value /
-- client_value). Reading them is logged against the restricted rows they are
-- about, one log row per restricted table.
-- -----------------------------------------------------------------------------
create or replace function private.sync_log_conflict_read(p_conflict_ids uuid[], p_context text)
returns void
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  r record;
begin
  for r in
    select sc.table_name, array_agg(distinct sc.row_id) as ids
    from public.sync_conflicts sc
    where sc.id = any (p_conflict_ids)
      and sc.table_name in (select s.table_name from private.sync_tables s where s.audience = 'restricted')
    group by sc.table_name
  loop
    perform private.log_restricted(r.table_name, r.ids, p_context || ':sync_conflicts');
  end loop;
end;
$$;

revoke execute on function private.sync_log_conflict_read(uuid[], text) from public, anon, authenticated;

revoke execute on function public.sync_pull(jsonb, integer) from public, anon;
grant  execute on function public.sync_pull(jsonb, integer) to authenticated;

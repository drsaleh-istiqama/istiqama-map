-- =============================================================================
-- 0025  Scope moves and sync housekeeping
--       (docs/ARCHITECTURE.md §3.2; contract: docs/contracts/sync.md)
--
-- A partial (scoped) sync has two blind spots when the scope columns of a row
-- change (a project is reassigned to another branch, its point is corrected
-- across a border, a person is moved to another branch):
--
--   1. Users of the NEW scope receive the row itself (it changed), but not its
--      children: their sync_xid is old, so no pull round would return them.
--      -> the children of a re-scoped project are re-stamped (sync_xid only,
--         no data change), so they travel with the project. The donors of the
--         project travel too without being touched: sync_pull delivers the
--         donor of every project_donors row whose sync_xid is in the window
--         (migration 0022, "DONORS"), and the links are re-stamped here.
--
--   2. Users of the OLD scope never hear about the row again and would keep a
--      stale copy for ever.
--      -> the move is recorded in private.sync_scope_moves and sync_pull adds
--         "gone": [ids] to the table's entry for callers who could see the row
--         before the move and cannot see it now.
--
--   The review state works the same way for viewers, who see approved projects
--   only (owner decision ح, migration 0013): a project that LEAVES 'approved'
--   (a collector's edit sends it back to 'submitted', a reviewer returns it) is
--   logged as a move (same country/branch) so that sync_pull lists it under
--   "gone" for the viewers who no longer see it; a project that ENTERS
--   'approved' gets its children re-stamped so that they reach the viewers with
--   it.
--
-- Also here: private.sync_prune() (ledger and move-log retention).
-- =============================================================================

create table private.sync_scope_moves (
  id             bigint generated always as identity primary key,
  table_name     text        not null,
  row_id         uuid        not null,
  old_country_id uuid,
  old_branch_id  uuid,
  sync_xid       bigint      not null,
  moved_at       timestamptz not null default now()
);

create index sync_scope_moves_sync_idx on private.sync_scope_moves (table_name, sync_xid);

comment on table private.sync_scope_moves is
  'One row per change of country_id/branch_id of a row-scoped syncable row; feeds the "gone" lists of sync_pull.';

alter table private.sync_scope_moves enable row level security;
revoke all on table private.sync_scope_moves from public, anon, authenticated;

-- Re-stamp the children of a project so that they travel with it to users who
-- could not see them before. Only sync_xid (and the bookkeeping columns of the
-- std trigger) change; the audit trigger does not log such an update.
create or replace function private.sync_restamp_children(p_project uuid, p_xid bigint)
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
    select s.table_name, s.scope_kind, s.scope_col
    from private.sync_tables s
    where s.scope_kind in ('project', 'staff')
    order by s.pull_order
  loop
    if r.scope_kind = 'project' then
      execute format('update public.%I t set sync_xid = $2 where t.%I = $1', r.table_name, r.scope_col)
        using p_project, p_xid;
    else
      execute format(
        'update public.%I t set sync_xid = $2 where t.%I in (select s.id from public.project_staff s where s.project_id = $1)',
        r.table_name, r.scope_col)
        using p_project, p_xid;
    end if;
  end loop;
end;
$$;

create or replace function private.tg_sync_scope_move()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_xid bigint := private.current_xid();
begin
  insert into private.sync_scope_moves (table_name, row_id, old_country_id, old_branch_id, sync_xid)
  values (tg_table_name, old.id, old.country_id, old.branch_id, v_xid);

  if tg_table_name = 'projects' then
    -- the children reach the users of the new scope with the project
    perform private.sync_restamp_children(new.id, v_xid);
  end if;

  return null;
end;
$$;

-- A project enters or leaves 'approved' (viewers see approved projects only).
create or replace function private.tg_sync_review_move()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_xid bigint := private.current_xid();
begin
  if old.record_state = 'approved' then
    -- leaves the viewers' view: listed under "gone" for them (sync_gone)
    insert into private.sync_scope_moves (table_name, row_id, old_country_id, old_branch_id, sync_xid)
    values ('projects', old.id, old.country_id, old.branch_id, v_xid);
  else
    -- enters it: the children travel with the project
    perform private.sync_restamp_children(new.id, v_xid);
  end if;
  return null;
end;
$$;

comment on function private.tg_sync_review_move() is
  'AFTER UPDATE trigger on projects when record_state enters or leaves approved: logs a leave as a scope move (viewers get "gone") and re-stamps the children on an approval.';

comment on function private.tg_sync_scope_move() is
  'AFTER UPDATE trigger on row-scoped syncable tables: logs a change of country_id/branch_id and re-stamps the children of a re-scoped project.';

create trigger t85_sync_scope_move after update on public.projects
  for each row
  when (old.country_id is distinct from new.country_id or old.branch_id is distinct from new.branch_id)
  execute function private.tg_sync_scope_move();

create trigger t85_sync_scope_move after update on public.persons
  for each row
  when (old.country_id is distinct from new.country_id or old.branch_id is distinct from new.branch_id)
  execute function private.tg_sync_scope_move();

create trigger t86_sync_review_move after update on public.projects
  for each row
  when ((old.record_state = 'approved') is distinct from (new.record_state = 'approved'))
  execute function private.tg_sync_review_move();

-- -----------------------------------------------------------------------------
-- Ids of rows of p_table that left the caller's scope inside the round window.
-- Called by sync_pull once per round and row-scoped table, with the caller's
-- scope (p_all, arrays) and the scope predicate (alias t) it already built.
-- p_all: a global reader whose view can still shrink (a global viewer, for
-- projects that left 'approved').
-- -----------------------------------------------------------------------------
create or replace function private.sync_gone(
  p_table text, p_lo bigint, p_hi bigint, p_all boolean, p_countries uuid[], p_branches uuid[],
  p_people_c uuid[], p_people_b uuid[], p_pred text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v jsonb;
begin
  execute format(
    'select jsonb_agg(distinct m.row_id)'
    || ' from private.sync_scope_moves m'
    || ' where m.table_name = $1 and m.sync_xid >= $2 and m.sync_xid < $3'
    || '   and ($6 or m.old_country_id = any ($4) or m.old_branch_id = any ($5))'
    || '   and not exists (select 1 from public.%I t where t.id = m.row_id and %s)',
    p_table,
    -- the predicate was built for the EXECUTE of sync_pull ($6 = countries,
    -- $7 = branches, $11 / $12 = people countries / branches)
    replace(replace(replace(replace(p_pred, '$6', '$4'), '$7', '$5'), '$11', '$7'), '$12', '$8'))
    into v
    using p_table, p_lo, p_hi, coalesce(p_countries, '{}'::uuid[]), coalesce(p_branches, '{}'::uuid[]),
          coalesce(p_all, false), coalesce(p_people_c, '{}'::uuid[]), coalesce(p_people_b, '{}'::uuid[]);
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- Housekeeping (schedule daily; see docs/contracts/sync.md):
--   * sync_applied_ops older than p_ledger_keep — must stay longer than a device
--     may sit on an unacknowledged batch (default 180 days)
--   * sync_scope_moves older than p_moves_keep — a device that was offline for
--     longer keeps stale copies of re-scoped rows until its next full resync
-- Run it without an end-user JWT (cron / service role): the hard-delete guard
-- of the ledger refuses deletes on behalf of end users.
-- -----------------------------------------------------------------------------
create or replace function private.sync_prune(
  p_ledger_keep interval default interval '180 days',
  p_moves_keep  interval default interval '180 days')
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_ops   bigint;
  v_moves bigint;
begin
  delete from public.sync_applied_ops o
  where o.applied_at < now() - greatest(p_ledger_keep, interval '30 days');
  get diagnostics v_ops = row_count;

  delete from private.sync_scope_moves m
  where m.moved_at < now() - greatest(p_moves_keep, interval '30 days');
  get diagnostics v_moves = row_count;

  return jsonb_build_object('applied_ops', v_ops, 'scope_moves', v_moves);
end;
$$;

comment on function private.sync_prune(interval, interval) is
  'Retention for the sync ledger (sync_applied_ops) and the scope-move log. Minimum 30 days each.';

revoke execute on function
  private.sync_restamp_children(uuid, bigint),
  private.tg_sync_scope_move(),
  private.tg_sync_review_move(),
  private.sync_gone(text, bigint, bigint, boolean, uuid[], uuid[], uuid[], uuid[], text),
  private.sync_prune(interval, interval)
from public, anon, authenticated;

grant execute on function private.sync_prune(interval, interval) to service_role;

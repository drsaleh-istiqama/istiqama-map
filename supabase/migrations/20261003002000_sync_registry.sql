-- =============================================================================
-- 0020  Sync registry and shared sync helpers
--       (docs/ARCHITECTURE.md §3, brief §3 + §4; contract: docs/contracts/sync.md)
--
--   private.sync_tables            one row per syncable table: pull order, scope,
--                                  audience and who may write it through sync_push
--   private.sync_state             single row: the sync epoch (forces a full client
--                                  resync when rotated, e.g. after a logical restore)
--   private.sync_ctx               composite: the caller's scope arrays + scope_epoch
--   private.sync_ctx()             builds it from one call of private.my_roles()
--   private.sync_can()             pure scope test on a sync_ctx (no queries)
--   private.sync_scope_epoch()     stable hash of epoch + user + effective roles
--   private.sync_select_list()     wire projection of a table (no sync_xid, no geometry,
--                                  lon/lat for point tables)
--   private.sync_writable_columns() columns a client may set through sync_push
--   private.sync_scope_pred()      SQL text of a scope predicate for dynamic queries
--   private.sync_ensure_indexes()  validates the registry, creates missing sync indexes
--   private.sync_rotate_epoch()    maintenance: force a full resync of every client
--   private.sync_rebase()          maintenance: re-stamp sync_xid after a logical restore
--
-- After changing private.sync_tables run private.sync_refresh() (migration 0022).
-- Everything here is internal: nothing is executable by API roles.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Registry
-- -----------------------------------------------------------------------------
create table private.sync_tables (
  table_name     text primary key,
  pull_order     integer not null unique,

  -- How a row is tied to the caller's scope:
  --   global    reference data, no row filter (any role)
  --   country   the row has country_id only (a branch-scoped role sees the
  --             countries of its branches)
  --   row       the row has country_id + branch_id itself
  --   project   via <scope_col> -> projects
  --   staff     via <scope_col> -> project_staff -> projects
  --   person    via <scope_col> -> persons
  --   own       the row belongs to the caller (<scope_col> = auth.uid())
  --   conflict  sync_conflicts: scope of the row the conflict is about
  --   donor     donors: no scope columns of their own. Visible to global
  --             readers, to their creator, and through project_donors ->
  --             projects in the read scope (the rule of the RLS policy
  --             donors_select, migration 0013)
  scope_kind     text not null,
  scope_col      text,

  -- Which capability triple filters the rows on pull:
  --   all = read_*   people = people_* (never viewers)   review = review_*
  --   restricted = restricted_* (country managers / HQ; every page is logged)
  audience       text not null default 'all',

  -- Who may write through sync_push (role classes, evaluated on the row scope):
  --   none            not writable through sync_push
  --   writer          any role with write scope over the row
  --   creator         the row's creator with write scope, or a reviewer in scope
  --   project_editor  whoever may edit the parent project: its creator with
  --                   write scope, or a reviewer in scope
  --   reviewer        supervisor / manager / HQ in scope
  --   self            the owner of the row (scope_kind = own)
  push_insert    text not null default 'none',
  push_update    text not null default 'none',
  push_delete    text not null default 'none',

  natural_key    text[],                          -- columns that identify one LIVE row (unique index
                                                  -- ... where deleted_at is null); see sync_push
  geom_point     boolean not null default false,  -- column geom is a Point, sent as lon/lat
  protected_cols text[]  not null default '{}',   -- server-managed, dropped from client payloads
  immutable_cols text[]  not null default '{}',   -- set on insert, never changed afterwards
  writable_cols  text[],                          -- when set: the only columns a client may write
  guard          text,                            -- private.<guard>(ctx, op, old, fields, reviewer);
                                                  -- runs on insert, update and delete (migration 0023)

  constraint sync_tables_scope_kind_ck check (
    scope_kind in ('global', 'country', 'row', 'project', 'staff', 'person', 'own', 'conflict', 'donor')),
  constraint sync_tables_scope_col_ck check (
    (scope_kind in ('project', 'staff', 'person', 'own')) = (scope_col is not null)),
  constraint sync_tables_audience_ck check (audience in ('all', 'people', 'restricted', 'review')),
  constraint sync_tables_push_insert_ck check (
    push_insert in ('none', 'writer', 'project_editor', 'reviewer')),
  constraint sync_tables_push_update_ck check (
    push_update in ('none', 'writer', 'creator', 'project_editor', 'reviewer', 'self')),
  constraint sync_tables_push_delete_ck check (
    push_delete in ('none', 'creator', 'project_editor', 'reviewer'))
);

comment on table private.sync_tables is
  'Registry of syncable tables: pull order, scope/audience on pull and role classes allowed to write through sync_push. The web twin is apps/web/src/db/tables.ts.';

alter table private.sync_tables enable row level security;
revoke all on table private.sync_tables from public, anon, authenticated;

-- Pull order = ARCHITECTURE §3.2 (parents before children).
insert into private.sync_tables
  (table_name, pull_order, scope_kind, scope_col, audience, push_insert, push_update, push_delete)
values
  -- reference data: read-only through sync (managed by hq_admin with direct DML)
  ('countries',              10, 'global',   null,               'all',        'none',           'none',           'none'),
  ('admin_areas',            20, 'country',  null,               'all',        'none',           'none',           'none'),
  ('branches',               30, 'global',   null,               'all',        'none',           'none',           'none'),
  ('option_values',          40, 'global',   null,               'all',        'none',           'none',           'none'),
  ('fx_rates',               50, 'global',   null,               'all',        'none',           'none',           'none'),
  -- localities: collectors propose, reviewers approve
  ('localities',             60, 'country',  null,               'all',        'writer',         'creator',        'creator'),
  -- donors: any writer may add one; changing or deleting one needs the donor to
  -- be visible to the caller (created by him or linked to a project he reads)
  ('donors',                 70, 'donor',    null,               'all',        'writer',         'writer',         'creator'),
  ('projects',               80, 'row',      null,               'all',        'writer',         'creator',        'creator'),
  -- children that describe the project: same rule as editing the project
  ('project_land',           90, 'project',  'project_id',       'all',        'project_editor', 'project_editor', 'project_editor'),
  ('project_facilities',    100, 'project',  'project_id',       'all',        'project_editor', 'project_editor', 'project_editor'),
  -- any writer in scope may add; changing somebody else's entry needs a reviewer
  ('project_maintenance',   110, 'project',  'project_id',       'all',        'writer',         'creator',        'creator'),
  ('project_photos',        120, 'project',  'project_id',       'all',        'writer',         'creator',        'creator'),
  ('project_donors',        130, 'project',  'project_id',       'all',        'project_editor', 'project_editor', 'project_editor'),
  -- people: never sent to viewers; never merged automatically
  ('persons',               140, 'row',      null,               'people',     'writer',         'writer',         'creator'),
  ('project_staff',         150, 'project',  'project_id',       'people',     'project_editor', 'project_editor', 'project_editor'),
  ('community_profiles',    160, 'project',  'project_id',       'all',        'project_editor', 'project_editor', 'project_editor'),
  -- restricted: blind writes for writers in scope, pulled only by country managers / HQ
  ('staff_compensation',    170, 'staff',    'project_staff_id', 'restricted', 'writer',         'writer',         'creator'),
  ('community_sensitive',   180, 'project',  'project_id',       'restricted', 'writer',         'writer',         'creator'),
  -- reviewer-only
  ('person_merge_requests', 190, 'person',   'source_person_id', 'review',     'reviewer',       'reviewer',       'reviewer'),
  ('sync_conflicts',        200, 'conflict', null,               'review',     'none',           'none',           'none'),
  -- own rows: only read_at may be written
  ('notifications',         210, 'own',      'user_id',          'all',        'none',           'self',           'none'),
  ('map_packs',             220, 'global',   null,               'all',        'none',           'none',           'none');

-- Points travel as lon/lat.
update private.sync_tables set geom_point = true
where table_name in ('projects', 'localities');

-- Natural keys (each backed by a unique index "... where deleted_at is null"):
-- an insert whose natural key already has a live row is applied to that row.
update private.sync_tables set natural_key = array['project_id']
where table_name in ('project_land', 'project_facilities', 'community_profiles', 'community_sensitive');
update private.sync_tables set natural_key = array['project_staff_id', 'effective_from']
where table_name = 'staff_compensation';

-- The parent link of a child never changes after insert.
update private.sync_tables set immutable_cols = array[scope_col]
where scope_kind in ('project', 'staff');
update private.sync_tables set immutable_cols = array['source_person_id', 'target_person_id']
where table_name = 'person_merge_requests';

-- Server-managed columns (dropped from client payloads; workflow columns are
-- handled by the guards instead).
update private.sync_tables set protected_cols = array['name_norm', 'approved_by', 'approved_at']
where table_name = 'localities';
update private.sync_tables set protected_cols = array['name_norm']
where table_name = 'donors';
update private.sync_tables
set protected_cols = array['code', 'completeness', 'search_norm', 'import_batch_id', 'reviewed_by', 'reviewed_at']
where table_name = 'projects';
update private.sync_tables set protected_cols = array['purged_at']
where table_name = 'project_photos';
update private.sync_tables set protected_cols = array['name_normalized', 'merged_into_id']
where table_name = 'persons';
update private.sync_tables set protected_cols = array['decided_by', 'decided_at', 'undo']
where table_name = 'person_merge_requests';

update private.sync_tables set writable_cols = array['read_at']
where table_name = 'notifications';

-- Workflow guards (defined in migration 0023).
update private.sync_tables set guard = 'sync_guard_' || table_name
where table_name in ('projects', 'localities', 'project_staff', 'project_donors', 'person_merge_requests');

-- -----------------------------------------------------------------------------
-- Sync epoch. It is part of scope_epoch, so rotating it makes every client wipe
-- its scoped tables and pull again from scratch.
-- -----------------------------------------------------------------------------
create table private.sync_state (
  id         boolean primary key default true,
  epoch      uuid not null default gen_random_uuid(),
  rotated_at timestamptz not null default now(),
  constraint sync_state_single_row_ck check (id)
);

comment on table private.sync_state is
  'Single row. epoch is mixed into scope_epoch; private.sync_rotate_epoch() forces a full resync of every client.';

alter table private.sync_state enable row level security;
revoke all on table private.sync_state from public, anon, authenticated;

insert into private.sync_state (id) values (true);

create or replace function private.sync_rotate_epoch()
returns uuid
language sql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
  update private.sync_state
  set epoch = gen_random_uuid(), rotated_at = now()
  where id
  returning epoch;
$$;

comment on function private.sync_rotate_epoch() is
  'Maintenance: forces every client to discard its local copy and pull again (scope_epoch changes for everyone).';

-- -----------------------------------------------------------------------------
-- Caller context: the scope arrays of Appendix A.3, fetched once per call and
-- then used with = any(...) (never per-row helper calls).
--   *_cs = country ids reachable through the capability: the country-scoped ids
--          plus the countries of the branch-scoped ids (used for tables that only
--          have country_id: localities, admin_areas).
-- -----------------------------------------------------------------------------
create type private.sync_ctx as (
  uid            uuid,
  device         text,
  epoch          text,      -- scope_epoch of the caller
  read_all       boolean, read_c       uuid[], read_b   uuid[], read_cs   uuid[],
  people_all     boolean, people_c     uuid[], people_b uuid[],
  write_all      boolean, write_c      uuid[], write_b  uuid[], write_cs  uuid[],
  review_all     boolean, review_c     uuid[], review_b uuid[], review_cs uuid[],
  restricted_all boolean, restricted_c uuid[]
);

create or replace function private.sync_country_set(p_countries uuid[], p_branches uuid[])
returns uuid[]
language sql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
  select coalesce(array_agg(distinct x.id), '{}'::uuid[])
  from (
    select unnest(coalesce(p_countries, '{}'::uuid[])) as id
    union
    select b.country_id
    from public.branches b
    where b.id = any (coalesce(p_branches, '{}'::uuid[]))
  ) x
  where x.id is not null;
$$;

-- The context is derived from ONE call of private.my_roles() (the single source
-- of the caller's effective roles: session, AAL and soft-deleted grants are
-- handled there). Calling the fourteen Appendix A.3 helpers one by one costs
-- ~6 ms per RPC, this costs ~0.5 ms. The capability -> roles mapping below is
-- the one of migration 0010; supabase/tests/20_sync_registry_context.test.sql
-- asserts that this function and the A.3 helpers agree for every role.
--
--   read       : any role
--   people     : any role except viewer
--   write      : field_collector, branch_supervisor, country_manager, hq_admin
--   review     : branch_supervisor, country_manager, hq_admin
--   restricted : country_manager, hq_admin (global or country scope)
--
-- epoch = md5(sync epoch | user id | sorted effective roles): it changes when
-- the effective roles change (including an AAL step-up/down or a revoked
-- session), when another user signs in on the device, or when the sync epoch is
-- rotated. The client then discards its scoped tables and pulls from scratch.
create or replace function private.sync_ctx()
returns private.sync_ctx
language plpgsql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  c       private.sync_ctx;
  v_roles text;
begin
  c.uid    := auth.uid();
  c.device := private.device_id();

  select
    coalesce(bool_or(r.scope_type = 'global'), false),
    coalesce(array_agg(distinct r.scope_id) filter (where r.scope_type = 'country' and r.scope_id is not null), '{}'::uuid[]),
    coalesce(array_agg(distinct r.scope_id) filter (where r.scope_type = 'branch' and r.scope_id is not null), '{}'::uuid[]),

    coalesce(bool_or(r.scope_type = 'global') filter (where r.role <> 'viewer'), false),
    coalesce(array_agg(distinct r.scope_id) filter (where r.role <> 'viewer' and r.scope_type = 'country' and r.scope_id is not null), '{}'::uuid[]),
    coalesce(array_agg(distinct r.scope_id) filter (where r.role <> 'viewer' and r.scope_type = 'branch' and r.scope_id is not null), '{}'::uuid[]),

    coalesce(bool_or(r.scope_type = 'global') filter (where r.role in ('branch_supervisor', 'country_manager', 'hq_admin')), false),
    coalesce(array_agg(distinct r.scope_id) filter (where r.role in ('branch_supervisor', 'country_manager', 'hq_admin') and r.scope_type = 'country' and r.scope_id is not null), '{}'::uuid[]),
    coalesce(array_agg(distinct r.scope_id) filter (where r.role in ('branch_supervisor', 'country_manager', 'hq_admin') and r.scope_type = 'branch' and r.scope_id is not null), '{}'::uuid[]),

    coalesce(bool_or(r.scope_type = 'global') filter (where r.role in ('country_manager', 'hq_admin')), false),
    coalesce(array_agg(distinct r.scope_id) filter (where r.role in ('country_manager', 'hq_admin') and r.scope_type = 'country' and r.scope_id is not null), '{}'::uuid[]),

    coalesce(string_agg(distinct r.role || ':' || r.scope_type || ':' || coalesce(r.scope_id::text, ''), ','
                        order by r.role || ':' || r.scope_type || ':' || coalesce(r.scope_id::text, '')), '')
  into
    c.read_all, c.read_c, c.read_b,
    c.people_all, c.people_c, c.people_b,
    c.review_all, c.review_c, c.review_b,
    c.restricted_all, c.restricted_c,
    v_roles
  from private.my_roles() r
  where r.role in ('field_collector', 'branch_supervisor', 'country_manager', 'hq_admin', 'viewer');

  -- every role that sees people may also write (viewer is the only read-only role)
  c.write_all := c.people_all;
  c.write_c   := c.people_c;
  c.write_b   := c.people_b;

  c.read_cs   := case when cardinality(c.read_b) = 0 then c.read_c
                      else private.sync_country_set(c.read_c, c.read_b) end;
  c.write_cs  := case when cardinality(c.write_b) = 0 then c.write_c
                      else private.sync_country_set(c.write_c, c.write_b) end;
  c.review_cs := case when cardinality(c.review_b) = 0 then c.review_c
                      else private.sync_country_set(c.review_c, c.review_b) end;

  c.epoch := md5(
    (select s.epoch::text from private.sync_state s where s.id)
    || '|' || coalesce(c.uid::text, '') || '|' || v_roles);
  return c;
end;
$$;

comment on function private.sync_ctx() is
  'Scope arrays (read / people / write / review / restricted) and scope_epoch of the caller, derived from one call of private.my_roles().';

-- Pure scope test on a context (no table access).
--   p_cap  : read | people | write | review
--   p_kind : registry scope_kind of the table the row belongs to
create or replace function private.sync_can(
  p_ctx private.sync_ctx, p_cap text, p_kind text, p_country uuid, p_branch uuid)
returns boolean
language plpgsql
immutable
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_all boolean;
  v_c   uuid[];
  v_b   uuid[];
  v_cs  uuid[];
begin
  case p_cap
    when 'read'   then v_all := p_ctx.read_all;   v_c := p_ctx.read_c;   v_b := p_ctx.read_b;   v_cs := p_ctx.read_cs;
    when 'people' then v_all := p_ctx.people_all; v_c := p_ctx.people_c; v_b := p_ctx.people_b;
                       v_cs := p_ctx.people_c;
    when 'write'  then v_all := p_ctx.write_all;  v_c := p_ctx.write_c;  v_b := p_ctx.write_b;  v_cs := p_ctx.write_cs;
    when 'review' then v_all := p_ctx.review_all; v_c := p_ctx.review_c; v_b := p_ctx.review_b; v_cs := p_ctx.review_cs;
    else
      raise exception 'sync_can: unknown capability "%"', p_cap using errcode = '22023';
  end case;

  if coalesce(v_all, false) then
    return true;
  end if;

  if p_kind in ('global', 'donor') then
    -- no row scope: any holder of the capability, wherever it is scoped
    -- (existing donors additionally have to be visible to the caller:
    -- private.sync_donor_visible, migration 0023)
    return cardinality(v_c) > 0 or cardinality(v_b) > 0;
  elsif p_kind = 'country' then
    return coalesce(p_country = any (v_cs), false);
  end if;

  return coalesce(p_country = any (v_c), false) or coalesce(p_branch = any (v_b), false);
end;
$$;

-- scope_epoch on its own (the RPCs take it from their context).
create or replace function private.sync_scope_epoch()
returns text
language sql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
  select (private.sync_ctx()).epoch;
$$;

comment on function private.sync_scope_epoch() is
  'scope_epoch of the caller: md5(sync epoch | user id | sorted effective roles). A change means "wipe and resync".';

-- -----------------------------------------------------------------------------
-- Catalog-driven projections. Columns are read from pg_attribute at call time,
-- so a column added by a later migration is synced without touching the sync
-- functions.
-- -----------------------------------------------------------------------------

-- Wire projection: every column except sync_xid and geometry/geography columns;
-- point tables get lon/lat instead of geom.
create or replace function private.sync_select_list(p_table text, p_alias text default 't')
returns text
language sql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
  select string_agg(format('%s.%I', p_alias, a.attname), ', ' order by a.attnum)
         || case
              when (select r.geom_point from private.sync_tables r where r.table_name = p_table)
              then format(', st_x(%1$s.geom)::float8 as lon, st_y(%1$s.geom)::float8 as lat', p_alias)
              else ''
            end
  from pg_attribute a
  join pg_type ty on ty.oid = a.atttypid
  where a.attrelid = (
          select c.oid
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = p_table and c.relkind in ('r', 'p'))
    and a.attnum > 0
    and not a.attisdropped
    and a.attname <> 'sync_xid'
    and ty.typname not in ('geometry', 'geography');
$$;

comment on function private.sync_select_list(text, text) is
  'Select list of the wire shape of a syncable table: all columns except sync_xid and geometry, plus lon/lat for point tables.';

-- Columns a client may set through sync_push: no standard/server-managed
-- columns, no generated columns, no geometry (points travel as lon/lat), none of
-- the registry's protected_cols, and only writable_cols when the registry
-- restricts the table. One standard column is accepted outside this list:
-- created_at on INSERT only (the offline entry time, see sync_apply_op in
-- migration 0023); on update it stays server-managed like the others.
create or replace function private.sync_writable_columns(p_table text)
returns text[]
language sql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
  select coalesce(array_agg(a.attname::text order by a.attnum), '{}'::text[])
  from pg_attribute a
  join pg_type ty on ty.oid = a.atttypid
  join private.sync_tables r on r.table_name = p_table
  where a.attrelid = (
          select c.oid
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = p_table and c.relkind in ('r', 'p'))
    and a.attnum > 0
    and not a.attisdropped
    and a.attgenerated = ''
    and ty.typname not in ('geometry', 'geography')
    and a.attname::text <> all (array[
          'id', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by',
          'sync_xid', 'deleted_at'])
    and a.attname::text <> all (r.protected_cols)
    and (r.writable_cols is null or a.attname::text = any (r.writable_cols));
$$;

comment on function private.sync_writable_columns(text) is
  'Columns of a syncable table that sync_push accepts from a client (everything else is server-managed and silently dropped).';

-- SQL text of a scope predicate for the dynamic queries of sync_pull.
-- Single values are inlined as literals (they come from the server-side scope
-- arrays, never from the client) so that an index led by country_id/branch_id
-- can return rows already ordered by (sync_xid, id); longer lists use the
-- array parameters of the caller's EXECUTE ... USING list.
create or replace function private.sync_scope_pred(
  p_alias text, p_all boolean, p_countries uuid[], p_branches uuid[],
  p_country_param text default '$6', p_branch_param text default '$7')
returns text
language plpgsql
immutable
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_parts text[] := '{}';
  v_nc    integer := coalesce(cardinality(p_countries), 0);
  v_nb    integer := coalesce(cardinality(p_branches), 0);
begin
  if coalesce(p_all, false) then
    return 'true';
  end if;
  if v_nc = 1 then
    v_parts := v_parts || format('%s.country_id = %L::uuid', p_alias, p_countries[1]);
  elsif v_nc > 1 then
    v_parts := v_parts || format('%s.country_id = any (%s)', p_alias, p_country_param);
  end if;
  if v_nb = 1 then
    v_parts := v_parts || format('%s.branch_id = %L::uuid', p_alias, p_branches[1]);
  elsif v_nb > 1 then
    v_parts := v_parts || format('%s.branch_id = any (%s)', p_alias, p_branch_param);
  end if;
  if cardinality(v_parts) = 0 then
    return 'false';
  end if;
  return '(' || array_to_string(v_parts, ' or ') || ')';
end;
$$;

-- -----------------------------------------------------------------------------
-- Indexes the sync protocol relies on. Tables belong to other migrations; an
-- index is created only when no valid, non-partial btree index already starts
-- with the same columns.
--   (sync_xid, id)                         keyset paging of a pull round
--   (country_id | branch_id, sync_xid, id) first sync of a scoped user without
--                                          walking the whole table
--   (<parent fk>)                          scope join for child tables
--   donors (created_by), project_donors (donor_id)  the donor visibility rule
--   audit_log (table_name, row_id, row_version)  field-level merge in sync_push
-- -----------------------------------------------------------------------------
create or replace function private.sync_has_index(p_table regclass, p_cols text[])
returns boolean
language sql
stable
set search_path = public, extensions, private, pg_temp
as $$
  select exists (
    select 1
    from pg_index i
    join pg_class ic on ic.oid = i.indexrelid
    join pg_am am on am.oid = ic.relam and am.amname = 'btree'
    where i.indrelid = p_table
      and i.indisvalid
      and i.indpred is null
      and i.indnkeyatts >= cardinality(p_cols)
      and (
        select array_agg(a.attname::text order by k.ord)
        from unnest(i.indkey::int2[]) with ordinality as k(attnum, ord)
        join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
        where k.ord <= cardinality(p_cols)
      ) = p_cols
  );
$$;

create or replace function private.sync_ensure_indexes()
returns integer
language plpgsql
volatile
set search_path = public, extensions, private, pg_temp
as $$
declare
  r        record;
  v_rel    regclass;
  v_cols   text[];
  v_sets   text[];      -- each element: comma-separated leading columns of a wanted index
  v_set    text;
  v_made   integer := 0;
  v_has    text[];
begin
  for r in select * from private.sync_tables order by pull_order loop
    v_rel := to_regclass(format('public.%I', r.table_name));
    if v_rel is null then
      raise exception 'sync registry: table public.% does not exist', r.table_name;
    end if;

    select array_agg(a.attname::text) into v_has
    from pg_attribute a
    where a.attrelid = v_rel and a.attnum > 0 and not a.attisdropped;

    if not ('sync_xid' = any (v_has) and 'id' = any (v_has) and 'version' = any (v_has)
            and 'deleted_at' = any (v_has)) then
      raise exception 'sync registry: public.% lacks id/version/deleted_at/sync_xid', r.table_name;
    end if;
    if r.scope_col is not null and not (r.scope_col = any (v_has)) then
      raise exception 'sync registry: public.%.% does not exist', r.table_name, r.scope_col;
    end if;

    v_sets := array['sync_xid,id'];
    if r.scope_kind = 'row' then
      v_sets := v_sets || array['country_id,sync_xid,id', 'branch_id,sync_xid,id'];
    elsif r.scope_kind = 'country' then
      v_sets := v_sets || array['country_id,sync_xid,id'];
    elsif r.scope_kind = 'own' then
      v_sets := v_sets || array[r.scope_col || ',sync_xid,id'];
    elsif r.scope_kind in ('project', 'staff', 'person') then
      v_sets := v_sets || array[r.scope_col];
    elsif r.scope_kind = 'donor' then
      -- "created by the caller" branch of the donor rule
      v_sets := v_sets || array['created_by'];
    end if;

    foreach v_set in array v_sets loop
      v_cols := string_to_array(v_set, ',');
      if not private.sync_has_index(v_rel, v_cols) then
        execute format('create index %I on public.%I (%s)',
                       left(r.table_name || '_sync_' || array_to_string(v_cols, '_'), 60),
                       r.table_name,
                       (select string_agg(format('%I', c), ', ' order by o)
                        from unnest(v_cols) with ordinality as u(c, o)));
        v_made := v_made + 1;
      end if;
    end loop;
  end loop;

  if to_regclass('public.audit_log') is not null
     and not private.sync_has_index('public.audit_log'::regclass, array['table_name', 'row_id', 'row_version']) then
    create index audit_log_sync_row_idx on public.audit_log (table_name, row_id, row_version);
    v_made := v_made + 1;
  end if;

  -- "linked to a project in scope" branch of the donor rule: donor -> links
  if exists (select 1 from private.sync_tables s where s.scope_kind = 'donor')
     and not private.sync_has_index('public.project_donors'::regclass, array['donor_id']) then
    create index project_donors_sync_donor_id on public.project_donors (donor_id);
    v_made := v_made + 1;
  end if;

  return v_made;
end;
$$;

comment on function private.sync_ensure_indexes() is
  'Validates the registry against the catalog and creates the indexes sync_pull/sync_push rely on when they are missing. Idempotent; called by private.sync_refresh().';

do $$
begin
  perform private.sync_ensure_indexes();
end
$$;

-- -----------------------------------------------------------------------------
-- Maintenance after a LOGICAL restore into a new cluster (pg_dump/pg_restore).
--
-- sync_xid values are transaction ids of the cluster that wrote them. A fresh
-- cluster starts counting from a small number, so restored rows would carry
-- ids "from the future" and no pull round (lo <= sync_xid < hi) would ever
-- return them. sync_rebase() stamps every row of every registry table with the
-- current transaction id (without touching version/updated_at: user triggers
-- are disabled for the statement) and rotates the sync epoch so that every
-- client discards its cursor and pulls again.
--
-- Not needed after point-in-time recovery or pg_upgrade (both keep the xid
-- counter). Run it as the database owner, in a quiet moment:
--     select private.sync_rebase();
-- -----------------------------------------------------------------------------
create or replace function private.sync_rebase()
returns jsonb
language plpgsql
volatile
set search_path = public, extensions, private, pg_temp
as $$
declare
  r       record;
  v_xid   bigint := private.current_xid();
  v_rows  bigint;
  v_total bigint := 0;
begin
  -- skips user triggers (std/audit) and FK checks for this transaction only
  set local session_replication_role = replica;
  for r in select table_name from private.sync_tables order by pull_order loop
    execute format('update public.%I set sync_xid = $1 where sync_xid <> $1', r.table_name) using v_xid;
    get diagnostics v_rows = row_count;
    v_total := v_total + v_rows;
  end loop;
  set local session_replication_role = origin;
  perform private.sync_rotate_epoch();
  return jsonb_build_object('sync_xid', v_xid, 'rows', v_total);
end;
$$;

comment on function private.sync_rebase() is
  'Maintenance after restoring a dump into a new cluster: re-stamps sync_xid on all syncable rows and rotates the sync epoch (full client resync). See docs/contracts/sync.md.';

-- -----------------------------------------------------------------------------
-- Privileges: internal only.
-- -----------------------------------------------------------------------------
revoke execute on function
  private.sync_rotate_epoch(),
  private.sync_country_set(uuid[], uuid[]),
  private.sync_ctx(),
  private.sync_can(private.sync_ctx, text, text, uuid, uuid),
  private.sync_scope_epoch(),
  private.sync_select_list(text, text),
  private.sync_writable_columns(text),
  private.sync_scope_pred(text, boolean, uuid[], uuid[], text, text),
  private.sync_has_index(regclass, text[]),
  private.sync_ensure_indexes(),
  private.sync_rebase()
from public, anon, authenticated;

-- The epoch may be rotated by trusted server code; sync_rebase() needs the
-- database owner (it sets session_replication_role).
grant execute on function private.sync_rotate_epoch() to service_role;

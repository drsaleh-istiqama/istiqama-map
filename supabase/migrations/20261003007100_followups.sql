-- =============================================================================
-- 0071  Follow-ups for the reports / import / admin unit
--       (contracts: docs/contracts/people-admin.md §10, §11; sync.md §4.4)
--
--   public.user_display_names(p_ids uuid[]) -> jsonb
--       [{id, full_name}] of the users the caller may name ("entered by" on a
--       project, author of a sync conflict, colleagues the profiles policy shows).
--   public.merge_localities(p_source uuid, p_target uuid) -> jsonb
--   public.revert_locality_merge(p_merge_id uuid) -> jsonb
--       reviewer of the source's country: re-points the projects of a duplicate
--       locality to the surviving one, soft-deletes the duplicate, keeps an undo
--       record (private.locality_merges).
--
-- Every function: SECURITY DEFINER, pinned search_path, session gate
-- (private.require_session: PT401 without user, PT403 session_revoked), rate
-- limit, EXECUTE for authenticated only.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Index for "who raised this conflict" look-ups (user_display_names, the
-- sync-status board counts by client_user_id as well).
-- -----------------------------------------------------------------------------
create index if not exists sync_conflicts_client_user_idx
  on public.sync_conflicts (client_user_id)
  where client_user_id is not null;
create index if not exists sync_conflicts_resolved_by_idx
  on public.sync_conflicts (resolved_by)
  where resolved_by is not null;

-- -----------------------------------------------------------------------------
-- user_display_names
--
-- A name is people data: viewers (and callers without any role) get nothing but
-- their own name. Otherwise the user U is named when
--   (a) U is the caller;
--   (b) the caller is hq_admin (aal2) — the profiles_select_hq policy;
--   (c) U holds a live role in a country whose restricted data the caller sees
--       (country scope, or a branch of that country) — profiles_select_manager;
--   (d) U created a project the caller can read WITH people scope ("entered by";
--       report_project returns entered_by under the same condition);
--   (e) U raised (client_user_id) or resolved (resolved_by) a sync conflict the
--       caller may see: project conflicts in his review scope (on a restricted
--       table only with restricted access to the project's country), person
--       conflicts in his review scope, locality conflicts in the countries of
--       his review scope, anything else (donors) for global reviewers — the rule
--       of the policy sync_conflicts_select and of sync_pull.
-- Unknown or invisible ids are left out (never an error: the answer must not
-- tell whether an id exists). At most 200 ids per call (PT422 too_many_ids).
-- Deactivated users keep their name (attribution of what they entered).
-- -----------------------------------------------------------------------------
create or replace function public.user_display_names(p_ids uuid[])
returns jsonb
language plpgsql
volatile            -- private.rate_limit() writes; the function itself only reads
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  c_max   constant integer := 200;
  v_uid   uuid;
  v_ids   uuid[];
  c       private.sync_ctx;
  v_hq    boolean;
  v_result jsonb;
begin
  perform private.require_session();
  v_uid := auth.uid();

  select coalesce(array_agg(distinct x.id), '{}'::uuid[]) into v_ids
  from unnest(coalesce(p_ids, '{}'::uuid[])) as x(id)
  where x.id is not null;
  if cardinality(v_ids) > c_max then
    raise exception 'too_many_ids' using errcode = 'PT422',
      detail = format('At most %s user ids per call.', c_max);
  end if;
  if cardinality(v_ids) = 0 then
    return '[]'::jsonb;
  end if;

  perform private.rate_limit('user_display_names', 120, interval '1 minute');

  c := private.sync_ctx();
  v_hq := private.is_hq();

  -- viewer-only / no role: own name at most
  if not (c.people_all or cardinality(c.people_c) > 0 or cardinality(c.people_b) > 0) then
    v_ids := array(select x from unnest(v_ids) as x where x = v_uid);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'full_name', p.full_name)
                            order by p.full_name collate "C", p.id), '[]'::jsonb)
    into v_result
  from public.profiles p
  where p.id = any (v_ids)
    and (
      p.id = v_uid
      or v_hq
      -- (c) colleagues of a restricted reader (profiles_select_manager)
      or ((c.restricted_all or cardinality(c.restricted_c) > 0) and exists (
            select 1
            from public.user_roles ur
            left join public.branches b on ur.scope_type = 'branch' and b.id = ur.scope_id
            where ur.user_id = p.id
              and ur.deleted_at is null
              and (c.restricted_all
                   or (ur.scope_type = 'country' and ur.scope_id = any (c.restricted_c))
                   or (ur.scope_type = 'branch' and b.country_id = any (c.restricted_c)))))
      -- (d) entered a project the caller reads with people scope
      or exists (
            select 1
            from public.projects pr
            where pr.created_by = p.id
              and (c.people_all or pr.country_id = any (c.people_c) or pr.branch_id = any (c.people_b)))
      -- (e) raised or resolved a conflict the caller may see
      or ((c.review_all or cardinality(c.review_c) > 0 or cardinality(c.review_b) > 0)
          and (exists (
                 select 1
                 from public.sync_conflicts sc
                 where sc.client_user_id = p.id
                   and private.conflict_visible_to(c, sc.table_name, sc.row_id, sc.project_id))
               or exists (
                 select 1
                 from public.sync_conflicts sc
                 where sc.resolved_by = p.id
                   and private.conflict_visible_to(c, sc.table_name, sc.row_id, sc.project_id))))
    );

  return v_result;
end;
$$;

comment on function public.user_display_names(uuid[]) is
  'Display names [{id, full_name}] of up to 200 users the caller may name: himself; for people-scoped callers the creators of projects in that scope, authors/resolvers of conflicts he may review, colleagues a restricted reader may see; everybody for hq_admin. Viewers: own name only. Unknown/invisible ids are omitted.';

-- Is a sync conflict visible to the context's holder? Same rule as the RLS
-- policy sync_conflicts_select + restricted access for restricted tables
-- (sync_pull 'conflict' scope kind). Internal helper, no table-wide use.
create or replace function private.conflict_visible_to(
  p_ctx private.sync_ctx, p_table text, p_row_id uuid, p_project_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_country uuid;
  v_branch  uuid;
  v_restricted boolean := p_table in (
    select s.table_name from private.sync_tables s where s.audience = 'restricted');
begin
  if p_project_id is not null then
    select pr.country_id, pr.branch_id into v_country, v_branch
    from public.projects pr where pr.id = p_project_id;
    if not (coalesce(p_ctx.review_all, false)
            or coalesce(v_country = any (p_ctx.review_c), false)
            or coalesce(v_branch = any (p_ctx.review_b), false)) then
      return false;
    end if;
    return not v_restricted
        or coalesce(p_ctx.restricted_all, false)
        or coalesce(v_country = any (p_ctx.restricted_c), false);
  end if;
  if v_restricted then
    return false;
  end if;
  if coalesce(p_ctx.review_all, false) then
    return true;
  end if;
  if p_table = 'persons' then
    select pe.country_id, pe.branch_id into v_country, v_branch
    from public.persons pe where pe.id = p_row_id;
    return coalesce(v_country = any (p_ctx.review_c), false)
        or coalesce(v_branch = any (p_ctx.review_b), false);
  elsif p_table = 'localities' then
    select l.country_id into v_country from public.localities l where l.id = p_row_id;
    return coalesce(v_country = any (p_ctx.review_cs), false);
  end if;
  return false;   -- unscoped rows (donors): global reviewers only
end;
$$;

-- -----------------------------------------------------------------------------
-- Locality merge: undo records
-- -----------------------------------------------------------------------------
create table if not exists private.locality_merges (
  id             uuid        primary key default private.uuid_v7(),
  source_id      uuid        not null,
  target_id      uuid        not null,
  country_id     uuid        not null,
  project_ids    uuid[]      not null default '{}',
  source_status  text,
  merged_by      uuid        not null,
  merged_at      timestamptz not null default now(),
  reverted_by    uuid,
  reverted_at    timestamptz
);

create index if not exists locality_merges_source_idx on private.locality_merges (source_id);

comment on table private.locality_merges is
  'One row per merge_localities() call: the projects re-pointed from the source to the target locality, so that revert_locality_merge() can undo it.';

-- Where did a merged locality go? Follows the merges that are not reverted and
-- whose source is still soft-deleted (A -> B -> C gives C, at most 10 hops); a
-- live, unknown or null id is returned unchanged. sync_push (migration 0023)
-- uses it for projects that name a merged locality — typically a project
-- entered offline before the device pulled the merge.
create or replace function private.locality_merged_into(p_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v      uuid := p_id;
  v_next uuid;
  i      integer := 0;
begin
  while v is not null and i < 10 loop
    select lm.target_id into v_next
    from private.locality_merges lm
    join public.localities l on l.id = lm.source_id and l.deleted_at is not null
    where lm.source_id = v and lm.reverted_at is null
    order by lm.merged_at desc
    limit 1;
    exit when v_next is null;
    v := v_next;
    i := i + 1;
  end loop;
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- merge_localities(p_source, p_target)
--
-- A duplicate village (typically a "proposed" one entered by hand in the field)
-- is folded into the surviving one:
--   1. every project (live or soft-deleted) whose locality_id is the source is
--      re-pointed to the target — ordinary UPDATEs, so version / sync_xid /
--      search_norm / audit_log follow and devices receive the change on their
--      next pull (a device that changed locality_id offline gets a conflict);
--   2. the source is soft-deleted (its tombstone reaches the devices);
--   3. the undo record keeps the moved project ids.
-- Who: a reviewer of the source's country (branch supervisor of a branch in
-- that country, country manager, hq_admin). A country-level reviewer
-- (country_manager / hq_admin) may fold any locality of the country; a
-- branch-level reviewer (branch_supervisor) only a PROPOSED locality whose
-- projects (live or soft-deleted) all belong to his own branches — he never
-- moves another branch's projects nor folds an approved village (brief §3,
-- private.locality_merge_allowed). Both localities must be live and of the
-- same country (a project names a locality of its own country only).
--
-- Errors: PT401 / PT403 session_revoked (session gate), PT422 invalid_argument
-- (null or equal ids), PT403 forbidden (no review right at all, not for the
-- source's country, or — branch level — an approved source or a source used
-- by another branch: one answer, never a count), PT404 locality_not_found (source or target missing or
-- deleted — same answer for both, never tells which), PT422
-- locality_country_mismatch, PT429.
-- -----------------------------------------------------------------------------

-- Can the context's holder fold / unfold a locality (country p_country, status
-- p_status) whose projects are p_projects?
--   country-level reviewer of the country (review_all, or review on the
--   country itself): always;
--   branch-level reviewer: only a locality that was 'proposed', and only when
--   every project concerned is in one of his branches.
create or replace function private.locality_merge_allowed(
  p_ctx private.sync_ctx, p_country uuid, p_status text, p_projects uuid[])
returns boolean
language plpgsql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  if coalesce(p_ctx.review_all, false) or coalesce(p_country = any (p_ctx.review_c), false) then
    return true;
  end if;
  if p_status is distinct from 'proposed' then
    return false;
  end if;
  return not exists (
    select 1
    from public.projects pr
    where pr.id = any (coalesce(p_projects, '{}'::uuid[]))
      and not coalesce(pr.branch_id = any (p_ctx.review_b), false));
end;
$$;

comment on function private.locality_merge_allowed(private.sync_ctx, uuid, text, uuid[]) is
  'Locality merge rule: country-level reviewers always; branch supervisors only for a proposed locality whose projects are all in their branches.';

create or replace function public.merge_localities(p_source uuid, p_target uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  c        private.sync_ctx;
  v_uid    uuid;
  v_src    public.localities%rowtype;
  v_tgt    public.localities%rowtype;
  v_using  uuid[];
  v_moved  uuid[];
  v_merge  uuid;
begin
  perform private.require_session();
  v_uid := auth.uid();
  if p_source is null or p_target is null then
    raise exception 'invalid_argument' using errcode = 'PT422',
      detail = 'Source and target localities are required.';
  end if;
  if p_source = p_target then
    raise exception 'invalid_argument' using errcode = 'PT422',
      detail = 'A locality cannot be merged into itself.';
  end if;

  c := private.sync_ctx();
  -- coarse check first: callers without any review capability learn nothing
  if not (c.review_all or cardinality(c.review_c) > 0 or cardinality(c.review_b) > 0) then
    raise exception 'forbidden' using errcode = 'PT403',
      detail = 'Only reviewers (branch supervisor, country manager, HQ) may merge localities.';
  end if;

  perform private.rate_limit('merge_localities', 30, interval '1 minute');

  -- lock both rows in id order (no deadlock between two concurrent merges)
  perform 1 from public.localities l where l.id in (p_source, p_target) order by l.id for update;
  select * into v_src from public.localities l where l.id = p_source;
  select * into v_tgt from public.localities l where l.id = p_target;

  if v_src.id is null or v_src.deleted_at is not null
     or not private.sync_can(c, 'review', 'country', v_src.country_id, null) then
    -- a locality outside the review scope is answered like a missing one
    -- unless the caller can see it at all (then: forbidden)
    if v_src.id is not null and v_src.deleted_at is null
       and private.sync_can(c, 'read', 'country', v_src.country_id, null) then
      raise exception 'forbidden' using errcode = 'PT403',
        detail = 'Merging requires review rights over the country of the locality.';
    end if;
    raise exception 'locality_not_found' using errcode = 'PT404';
  end if;
  if v_tgt.id is null or v_tgt.deleted_at is not null
     or not private.sync_can(c, 'read', 'country', v_tgt.country_id, null) then
    raise exception 'locality_not_found' using errcode = 'PT404';
  end if;
  if v_tgt.country_id is distinct from v_src.country_id then
    raise exception 'locality_country_mismatch' using errcode = 'PT422',
      detail = 'Both localities must belong to the same country.';
  end if;

  -- every project (live or soft-deleted) that names the source, locked: the
  -- branch rule is decided on exactly the rows the update below re-points
  select coalesce(array_agg(x.id order by x.id), '{}'::uuid[]) into v_using
  from (select pr.id from public.projects pr where pr.locality_id = p_source order by pr.id for update) x;

  if not private.locality_merge_allowed(c, v_src.country_id, v_src.status, v_using) then
    -- one answer for "approved" and "used by another branch"; never a count
    raise exception 'forbidden' using errcode = 'PT403',
      detail = 'A branch supervisor may only merge a proposed locality used by projects of his own branches; ask the country manager.';
  end if;

  with moved as (
    update public.projects p
    set locality_id = p_target
    where p.id = any (v_using)
      and p.locality_id = p_source
    returning p.id
  )
  select coalesce(array_agg(m.id order by m.id), '{}'::uuid[]) into v_moved from moved m;

  update public.localities l set deleted_at = now() where l.id = p_source;

  insert into private.locality_merges (source_id, target_id, country_id, project_ids, source_status, merged_by)
  values (p_source, p_target, v_src.country_id, v_moved, v_src.status, v_uid)
  returning id into v_merge;

  return jsonb_build_object(
    'merge_id', v_merge,
    'source_id', p_source,
    'target_id', p_target,
    'projects_moved', cardinality(v_moved),   -- all inside the caller's review scope
    'source_deleted', true);
end;
$$;

comment on function public.merge_localities(uuid, uuid) is
  'Folds a duplicate locality into another of the same country: re-points its projects, soft-deletes it, records the undo data. Country manager / HQ of the country; a branch supervisor only for a proposed locality whose projects are all in his branches.';

-- -----------------------------------------------------------------------------
-- revert_locality_merge(p_merge_id)
--
-- Restores the source locality and re-points to it the recorded projects that
-- still name the target (a project re-pointed by hand since the merge keeps its
-- newer value). Same reviewer rule as the merge (a branch supervisor undoes
-- only a merge of a proposed locality whose recorded projects are all in his
-- branches). Errors: PT404
-- locality_merge_not_found (unknown, or not in the caller's review scope),
-- PT403 forbidden (branch-level caller, see above),
-- PT409 merge_not_revertible (already reverted, or the target was deleted
-- meanwhile), PT429.
-- -----------------------------------------------------------------------------
create or replace function public.revert_locality_merge(p_merge_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  c        private.sync_ctx;
  v_uid    uuid;
  m        private.locality_merges%rowtype;
  v_back   integer;
begin
  perform private.require_session();
  v_uid := auth.uid();
  c := private.sync_ctx();
  if not (c.review_all or cardinality(c.review_c) > 0 or cardinality(c.review_b) > 0) then
    raise exception 'forbidden' using errcode = 'PT403',
      detail = 'Only reviewers (branch supervisor, country manager, HQ) may undo a locality merge.';
  end if;

  perform private.rate_limit('merge_localities', 30, interval '1 minute');

  select * into m from private.locality_merges lm where lm.id = p_merge_id for update;
  if m.id is null or not private.sync_can(c, 'review', 'country', m.country_id, null) then
    raise exception 'locality_merge_not_found' using errcode = 'PT404';
  end if;
  if not private.locality_merge_allowed(c, m.country_id, m.source_status, m.project_ids) then
    raise exception 'forbidden' using errcode = 'PT403',
      detail = 'This merge concerns projects outside your branches or an approved locality; ask the country manager.';
  end if;
  if m.reverted_at is not null then
    raise exception 'merge_not_revertible' using errcode = 'PT409',
      detail = 'This merge has already been undone.';
  end if;

  perform 1 from public.localities l where l.id in (m.source_id, m.target_id) order by l.id for update;
  if exists (select 1 from public.localities l where l.id = m.target_id and l.deleted_at is not null) then
    raise exception 'merge_not_revertible' using errcode = 'PT409',
      detail = 'The surviving locality has been deleted since the merge.';
  end if;

  update public.localities l set deleted_at = null where l.id = m.source_id and l.deleted_at is not null;

  update public.projects p
  set locality_id = m.source_id
  where p.id = any (m.project_ids)
    and p.locality_id = m.target_id;
  get diagnostics v_back = row_count;

  update private.locality_merges lm
  set reverted_by = v_uid, reverted_at = now()
  where lm.id = m.id;

  return jsonb_build_object(
    'merge_id', m.id,
    'source_id', m.source_id,
    'target_id', m.target_id,
    'projects_restored', v_back,
    'source_restored', true);
end;
$$;

comment on function public.revert_locality_merge(uuid) is
  'Undoes merge_localities(): restores the source locality and re-points the recorded projects that still name the target.';

-- -----------------------------------------------------------------------------
-- Privileges, hardening, schema version
-- -----------------------------------------------------------------------------
revoke execute on function private.conflict_visible_to(private.sync_ctx, text, uuid, uuid)
  from public, anon, authenticated;
revoke execute on function private.locality_merged_into(uuid)
  from public, anon, authenticated;
revoke execute on function private.locality_merge_allowed(private.sync_ctx, uuid, text, uuid[])
  from public, anon, authenticated;

revoke execute on function
  public.user_display_names(uuid[]),
  public.merge_localities(uuid, uuid),
  public.revert_locality_merge(uuid)
from public, anon;

grant execute on function
  public.user_display_names(uuid[]),
  public.merge_localities(uuid, uuid),
  public.revert_locality_merge(uuid)
to authenticated;

select private.harden_private_schema();

create or replace function private.schema_version()
returns text
language sql
immutable
parallel safe
set search_path = public, extensions, private, pg_temp
as $$
  select '20261003007100'::text;
$$;

revoke execute on function private.schema_version() from public, anon, authenticated;

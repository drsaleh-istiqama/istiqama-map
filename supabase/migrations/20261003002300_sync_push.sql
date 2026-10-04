-- =============================================================================
-- 0023  sync_push — idempotent batch apply with field-level merge
--       (docs/ARCHITECTURE.md §3.1, brief §3 + §4; contract: docs/contracts/sync.md)
--
--   public.sync_push(p_ops jsonb, p_device_id text) -> jsonb
--
-- One call = one transaction, at most 50 operations. Every operation runs in
-- its own sub-transaction (BEGIN ... EXCEPTION), so a bad operation is reported
-- as "rejected" and the rest of the batch still commits.
--
-- The implementation is generic: it is driven by private.sync_tables and the
-- system catalog (jsonb_populate_record for type coercion, format('%I') for
-- identifiers). Table-specific workflow rules live in small guard functions
-- (private.sync_guard_<table>) named by the registry; they run for inserts,
-- updates AND deletes.
--
-- Field-level merge (brief §4.3):
--   * base_version = current version          -> apply                    (applied)
--   * base_version < current version: the fields changed since base_version
--     by OTHER devices are read from audit_log (changed_fields, row_version,
--     device_id; this device's own changes are ignored)
--       - disjoint from the client's fields   -> apply                    (merged)
--       - same field, different value         -> one sync_conflicts row per
--         field; the other fields are still applied                       (conflict)
--
-- created_at: accepted from the client on INSERT only (the offline entry time;
-- private.tg_std clamps the future) and immutable afterwards.
--
-- Donors (registry scope kind "donor") have no country or branch: any writer
-- may add one, but changing, deleting or linking an existing donor requires
-- that the caller can see it (private.sync_donor_visible = the RLS rule).
--
-- Restricted tables (staff_compensation, community_sensitive): a writer who
-- cannot see the restricted data of the row's country writes BLIND. His
-- operation is addressed by its natural key, validated as an insert before an
-- existing row is touched, and answered with a constant result, so that the
-- answer never depends on the stored values (brief §3, acceptance criterion 5).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Scope facts of one row (existing row or the payload of an insert).
-- -----------------------------------------------------------------------------
create type private.sync_row_scope as (
  country_id      uuid,
  branch_id       uuid,
  project_id      uuid,     -- project the row belongs to (the row itself for projects)
  project_creator uuid,
  project_state   text,
  parent_deleted  boolean,
  owner_id        uuid      -- scope_kind = own
);

create or replace function private.sync_row_scope(p_reg private.sync_tables, p_row jsonb, p_row_id uuid)
returns private.sync_row_scope
language plpgsql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  s     private.sync_row_scope;
  v_ref uuid;
begin
  s.parent_deleted := false;

  if p_reg.scope_kind in ('row', 'country') then
    s.country_id := (p_row ->> 'country_id')::uuid;
    if p_reg.scope_kind = 'row' then
      s.branch_id := (p_row ->> 'branch_id')::uuid;
    end if;
    if p_reg.table_name = 'projects' then
      s.project_id      := p_row_id;
      s.project_creator := (p_row ->> 'created_by')::uuid;
      s.project_state   := p_row ->> 'record_state';
    end if;
    return s;
  end if;

  if p_reg.scope_kind in ('global', 'conflict', 'donor') then
    return s;
  end if;

  v_ref := (p_row ->> p_reg.scope_col)::uuid;

  if p_reg.scope_kind = 'own' then
    s.owner_id := v_ref;
    return s;
  end if;

  if v_ref is null then
    raise exception 'parent_required' using errcode = 'PT422',
      detail = format('%s.%s is required', p_reg.table_name, p_reg.scope_col);
  end if;

  if p_reg.scope_kind = 'project' then
    select p.country_id, p.branch_id, p.id, p.created_by, p.record_state, p.deleted_at is not null
      into s.country_id, s.branch_id, s.project_id, s.project_creator, s.project_state, s.parent_deleted
    from public.projects p
    where p.id = v_ref;
  elsif p_reg.scope_kind = 'staff' then
    select p.country_id, p.branch_id, p.id, p.created_by, p.record_state,
           (p.deleted_at is not null or st.deleted_at is not null)
      into s.country_id, s.branch_id, s.project_id, s.project_creator, s.project_state, s.parent_deleted
    from public.project_staff st
    join public.projects p on p.id = st.project_id
    where st.id = v_ref;
  elsif p_reg.scope_kind = 'person' then
    select pe.country_id, pe.branch_id, pe.deleted_at is not null
      into s.country_id, s.branch_id, s.parent_deleted
    from public.persons pe
    where pe.id = v_ref;
  end if;

  if not found then
    -- Usually an ordering problem (child sent before its parent) or the parent
    -- operation was rejected: the client keeps the op and retries after the parent.
    raise exception 'parent_missing' using errcode = 'PT422',
      detail = format('%s.%s points to a row that does not exist on the server', p_reg.table_name, p_reg.scope_col);
  end if;

  return s;
end;
$$;

-- -----------------------------------------------------------------------------
-- Is an existing donor visible to the caller? Same rule as the RLS policy
-- donors_select (migration 0013) and as sync_pull: global readers see every
-- donor, everybody else the donors he created and the donors linked through
-- project_donors to a project in his read scope.
--
-- sync_push uses it so that nobody can change, delete or link a donor he could
-- not have received: a conflict result would otherwise echo the stored name of
-- a foreign donor, and linking a foreign donor to an own project would make it
-- visible.
-- -----------------------------------------------------------------------------
create or replace function private.sync_donor_visible(
  p_ctx private.sync_ctx, p_donor_id uuid, p_created_by uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  if coalesce(p_ctx.read_all, false) or coalesce(p_created_by = p_ctx.uid, false) then
    return true;
  end if;
  return exists (
    select 1
    from public.project_donors pd
    join public.projects p on p.id = pd.project_id
    where pd.donor_id = p_donor_id
      and (p.country_id = any (p_ctx.read_c) or p.branch_id = any (p_ctx.read_b)));
end;
$$;

-- -----------------------------------------------------------------------------
-- Restricted tables (staff_compensation, community_sensitive): may the caller
-- see restricted data of this country? (country_manager of the country or
-- hq_admin, both effective only at aal2 — the same rule as sync_pull and
-- restricted_read.) Everybody else who writes such a row writes BLIND.
-- -----------------------------------------------------------------------------
create or replace function private.sync_sees_restricted(p_ctx private.sync_ctx, p_country uuid)
returns boolean
language sql
immutable
set search_path = public, extensions, private, pg_temp
as $$
  select coalesce(p_ctx.restricted_all, false)
      or coalesce(p_country = any (p_ctx.restricted_c), false);
$$;

-- -----------------------------------------------------------------------------
-- Blind writes: prove that the client's values are insertable as a NEW row,
-- without keeping that row. A blind write that lands on an existing row (the
-- natural key already has a live row) must be refused for exactly the same
-- reasons as a real insert (missing NOT NULL column, check constraint, type,
-- foreign key), otherwise the outcome would tell the caller whether a row
-- exists and which of his values the stored row already has.
--
-- The probe row is inserted soft-deleted (the natural-key unique indexes only
-- cover live rows) inside a sub-transaction that is always rolled back; a
-- constraint error propagates to the caller unchanged.
-- -----------------------------------------------------------------------------
create or replace function private.sync_probe_insert(p_table text, p_values jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_values jsonb := coalesce(p_values, '{}'::jsonb) - 'id' - 'deleted_at';
begin
  begin
    execute format(
      'insert into public.%1$I (id, deleted_at%2$s) select private.uuid_v7(), now()%3$s'
      || ' from jsonb_populate_record(null::public.%1$I, $1) r',
      p_table,
      (select coalesce(string_agg(format(', %I', k), ''), '') from jsonb_object_keys(v_values) as k),
      (select coalesce(string_agg(format(', r.%I', k), ''), '') from jsonb_object_keys(v_values) as k))
      using v_values;
    raise exception 'sync_probe_insert' using errcode = 'PTPRB';
  exception when sqlstate 'PTPRB' then
    null;   -- probe passed; the probe row (and its audit row) is rolled back
  end;
end;
$$;

-- -----------------------------------------------------------------------------
-- Role-class check (registry push_insert / push_update / push_delete).
-- -----------------------------------------------------------------------------
create or replace function private.sync_authorise(
  p_class text, p_writer boolean, p_reviewer boolean,
  p_is_creator boolean, p_is_project_creator boolean, p_is_self boolean)
returns void
language plpgsql
immutable
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_ok boolean;
begin
  v_ok := case p_class
    when 'writer'         then p_writer or p_reviewer
    when 'creator'        then p_reviewer or (p_writer and coalesce(p_is_creator, false))
    when 'project_editor' then p_reviewer or (p_writer and coalesce(p_is_project_creator, false))
    when 'reviewer'       then p_reviewer
    when 'self'           then coalesce(p_is_self, false)
    else false
  end;
  if coalesce(v_ok, false) then
    return;
  end if;

  if p_class = 'none' then
    raise exception 'operation_not_allowed' using errcode = 'PT403',
      detail = 'This table does not accept this kind of operation through sync_push.';
  elsif p_class = 'self' then
    raise exception 'not_owner' using errcode = 'PT403';
  elsif not (coalesce(p_writer, false) or coalesce(p_reviewer, false)) then
    raise exception 'out_of_scope' using errcode = 'PT403',
      detail = 'The row is outside the country/branch scope of your roles.';
  elsif p_class = 'reviewer' then
    raise exception 'reviewer_required' using errcode = 'PT403';
  else
    raise exception 'not_owner' using errcode = 'PT403',
      detail = 'Only the creator of the record or a reviewer may change it.';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Guards. Signature (binding for new guards):
--   private.sync_guard_<table>(p_ctx, p_op 'insert'|'update'|'delete', p_old jsonb, p_fields jsonb, p_reviewer boolean)
-- returns {"fields": <client fields that take part in the field merge>,
--          "force": <server-decided values, always applied>,
--          "on_change": <applied only when at least one client field is applied>}
-- and raises PT403/PT422 with a machine-readable message for forbidden input.
-- Workflow columns never take part in the field merge: a transition is
-- validated against the CURRENT server state.
--
-- 'delete' (soft delete) is called after the role-class check with p_old = the
-- current row and p_fields = '{}'. The guard raises to refuse a delete that the
-- workflow does not allow in the row's current state (a delete is a state
-- change too: without this, a collector could remove a record he may no
-- longer edit); its result is ignored. A guard without a delete rule returns.
-- -----------------------------------------------------------------------------

-- projects: record_state workflow (brief §3, ARCHITECTURE §2.3)
--   collector : draft|returned -> submitted (may keep draft); any edit of a
--               submitted/approved record leaves it "submitted"; deletes his
--               record only while it is draft or returned
--   reviewer  : submitted -> approved|returned, approved -> returned (and may
--               approve a draft/returned record directly); stamps reviewed_by/at;
--               may delete in any state
--   nobody else may set "approved"; review_note is a reviewer field
create or replace function private.sync_guard_projects(
  p_ctx private.sync_ctx, p_op text, p_old jsonb, p_fields jsonb, p_reviewer boolean)
returns jsonb
language plpgsql
stable
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_old       text  := p_old ->> 'record_state';
  v_req       text  := p_fields ->> 'record_state';
  v_fields    jsonb := p_fields - 'record_state' - 'review_note';
  v_force     jsonb := '{}'::jsonb;
  v_on_change jsonb := '{}'::jsonb;
  v_ok        boolean;
begin
  if p_op = 'delete' then
    -- brief §3: a collector creates and edits his drafts. A record he submitted
    -- waits for a reviewer, an approved one has been accepted by a reviewer:
    -- removing either is a review decision (a collector cannot even move a
    -- submitted record back to draft). Checking the current state also closes
    -- the two-step path "edit approved (-> submitted), then delete".
    if not p_reviewer and v_old is distinct from 'draft' and v_old is distinct from 'returned' then
      raise exception 'forbidden_transition' using errcode = 'PT403',
        detail = format('Only a reviewer may delete a record that is %s.', v_old);
    end if;
    return jsonb_build_object('fields', '{}'::jsonb, 'force', '{}'::jsonb, 'on_change', '{}'::jsonb);
  end if;

  if v_req is not null and v_req not in ('draft', 'submitted', 'approved', 'returned') then
    raise exception 'invalid_record_state' using errcode = 'PT422';
  end if;

  if p_op = 'insert' then
    v_req := coalesce(v_req, 'draft');
    if not p_reviewer and v_req not in ('draft', 'submitted') then
      raise exception 'forbidden_transition' using errcode = 'PT403',
        detail = 'Only a reviewer may approve or return a record.';
    end if;
    v_force := jsonb_build_object('record_state', v_req);
    if p_reviewer and v_req in ('approved', 'returned') then
      v_force := v_force || jsonb_build_object(
        'reviewed_by', p_ctx.uid, 'reviewed_at', now(), 'review_note', p_fields -> 'review_note');
    end if;
    return jsonb_build_object('fields', v_fields, 'force', v_force, 'on_change', v_on_change);
  end if;

  if v_req is null or v_req = v_old then
    -- no explicit transition
    if not p_reviewer and v_old = 'approved' then
      v_on_change := jsonb_build_object('record_state', 'submitted');
    elsif p_reviewer and p_fields ? 'review_note'
          and (p_fields ->> 'review_note') is distinct from (p_old ->> 'review_note') then
      v_force := jsonb_build_object('review_note', p_fields -> 'review_note');
    end if;
  else
    if p_reviewer then
      v_ok := (v_old in ('draft', 'returned') and v_req = 'submitted')
           or (v_old in ('draft', 'submitted', 'returned') and v_req = 'approved')
           or (v_old in ('submitted', 'approved') and v_req = 'returned');
    else
      v_ok := v_old in ('draft', 'returned', 'approved') and v_req = 'submitted';
    end if;
    if not v_ok then
      if not p_reviewer and v_req in ('approved', 'returned') then
        raise exception 'forbidden_transition' using errcode = 'PT403',
          detail = 'Only a reviewer may approve or return a record.';
      end if;
      raise exception 'invalid_transition' using errcode = 'PT422',
        detail = format('record_state %s -> %s is not allowed', v_old, v_req);
    end if;
    v_force := jsonb_build_object('record_state', v_req);
    if p_reviewer and v_req in ('approved', 'returned') then
      v_force := v_force || jsonb_build_object('reviewed_by', p_ctx.uid, 'reviewed_at', now());
      if p_fields ? 'review_note' then
        v_force := v_force || jsonb_build_object('review_note', p_fields -> 'review_note');
      end if;
    end if;
  end if;

  return jsonb_build_object('fields', v_fields, 'force', v_force, 'on_change', v_on_change);
end;
$$;

-- localities: collectors create/edit/delete only "proposed" rows; reviewers
-- approve (and may change or delete any locality in scope).
create or replace function private.sync_guard_localities(
  p_ctx private.sync_ctx, p_op text, p_old jsonb, p_fields jsonb, p_reviewer boolean)
returns jsonb
language plpgsql
stable
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_old    text  := p_old ->> 'status';
  v_req    text  := p_fields ->> 'status';
  v_fields jsonb := p_fields - 'status';
  v_force  jsonb := '{}'::jsonb;
begin
  if p_op = 'delete' then
    -- same lock as for an edit (brief §2.1: a supervisor approves localities)
    if not p_reviewer and v_old is distinct from 'proposed' then
      raise exception 'locality_locked' using errcode = 'PT403',
        detail = 'An approved locality can only be deleted by a reviewer.';
    end if;
    return jsonb_build_object('fields', '{}'::jsonb, 'force', '{}'::jsonb, 'on_change', '{}'::jsonb);
  end if;

  if v_req is not null and v_req not in ('proposed', 'approved') then
    raise exception 'invalid_status' using errcode = 'PT422';
  end if;

  if not p_reviewer then
    if coalesce(v_req, 'proposed') <> 'proposed' then
      raise exception 'forbidden_transition' using errcode = 'PT403',
        detail = 'Only a reviewer may approve a locality.';
    end if;
    if p_op = 'update' and v_old <> 'proposed' then
      raise exception 'locality_locked' using errcode = 'PT403',
        detail = 'An approved locality can only be changed by a reviewer.';
    end if;
    if p_op = 'insert' then
      v_force := jsonb_build_object('status', 'proposed');
    end if;
    return jsonb_build_object('fields', v_fields, 'force', v_force, 'on_change', '{}'::jsonb);
  end if;

  if p_op = 'insert' then
    v_req := coalesce(v_req, 'proposed');
    v_force := jsonb_build_object('status', v_req);
    if v_req = 'approved' then
      v_force := v_force || jsonb_build_object('approved_by', p_ctx.uid, 'approved_at', now());
    end if;
  elsif v_req is not null and v_req <> v_old then
    if v_req = 'approved' then
      v_force := jsonb_build_object('status', 'approved', 'approved_by', p_ctx.uid, 'approved_at', now());
    else
      v_force := jsonb_build_object('status', 'proposed', 'approved_by', null, 'approved_at', null);
    end if;
  end if;

  return jsonb_build_object('fields', v_fields, 'force', v_force, 'on_change', '{}'::jsonb);
end;
$$;

-- project_staff: the linked person must exist and be visible to the caller.
create or replace function private.sync_guard_project_staff(
  p_ctx private.sync_ctx, p_op text, p_old jsonb, p_fields jsonb, p_reviewer boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_person  uuid;
  v_country uuid;
  v_branch  uuid;
  v_deleted boolean;
begin
  if p_fields ? 'person_id'
     and (p_op = 'insert' or lower(p_fields ->> 'person_id') is distinct from (p_old ->> 'person_id')) then
    v_person := (p_fields ->> 'person_id')::uuid;
    select pe.country_id, pe.branch_id, pe.deleted_at is not null
      into v_country, v_branch, v_deleted
    from public.persons pe
    where pe.id = v_person;
    if not found then
      raise exception 'parent_missing' using errcode = 'PT422',
        detail = 'project_staff.person_id points to a person that does not exist on the server';
    end if;
    if v_deleted or not private.sync_can(p_ctx, 'people', 'row', v_country, v_branch) then
      raise exception 'person_not_available' using errcode = 'PT403',
        detail = 'The person is deleted, merged or outside your scope.';
    end if;
  end if;
  return jsonb_build_object('fields', p_fields, 'force', '{}'::jsonb, 'on_change', '{}'::jsonb);
end;
$$;

-- project_donors: the linked donor must exist, be live and be visible to the
-- caller (a link to a project in scope is what makes a donor visible, so a
-- donor the caller cannot see must not be linkable by id).
create or replace function private.sync_guard_project_donors(
  p_ctx private.sync_ctx, p_op text, p_old jsonb, p_fields jsonb, p_reviewer boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_donor   uuid;
  v_creator uuid;
  v_deleted boolean;
begin
  if (p_fields ->> 'donor_id') is not null
     and (p_op = 'insert' or lower(p_fields ->> 'donor_id') is distinct from (p_old ->> 'donor_id')) then
    v_donor := (p_fields ->> 'donor_id')::uuid;
    select d.created_by, d.deleted_at is not null
      into v_creator, v_deleted
    from public.donors d
    where d.id = v_donor;
    if not found then
      raise exception 'parent_missing' using errcode = 'PT422',
        detail = 'project_donors.donor_id points to a donor that does not exist on the server';
    end if;
    if v_deleted or not private.sync_donor_visible(p_ctx, v_donor, v_creator) then
      raise exception 'donor_not_available' using errcode = 'PT403',
        detail = 'The donor is deleted or not visible to you.';
    end if;
  end if;
  return jsonb_build_object('fields', p_fields, 'force', '{}'::jsonb, 'on_change', '{}'::jsonb);
end;
$$;

-- person_merge_requests: a reviewer may file a pending request, reject it, or
-- withdraw (delete) it while it is pending. Merging / reverting happens only
-- through merge_persons / revert_person_merge. A decided request is the trace
-- of the decision and cannot be deleted: a merged one holds the undo data that
-- revert_person_merge needs (it ignores soft-deleted requests), so deleting it
-- would make the merge irreversible (brief §2.4).
create or replace function private.sync_guard_person_merge_requests(
  p_ctx private.sync_ctx, p_op text, p_old jsonb, p_fields jsonb, p_reviewer boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_old     text  := p_old ->> 'state';
  v_req     text  := p_fields ->> 'state';
  v_fields  jsonb := p_fields - 'state';
  v_force   jsonb := '{}'::jsonb;
  v_country uuid;
  v_branch  uuid;
begin
  if p_op = 'delete' then
    if v_old is distinct from 'pending' then
      raise exception 'invalid_transition' using errcode = 'PT422',
        detail = format('A merge request that is %s is kept as the trace of the decision; only a pending request can be withdrawn.', v_old);
    end if;
    return jsonb_build_object('fields', '{}'::jsonb, 'force', '{}'::jsonb, 'on_change', '{}'::jsonb);
  end if;

  if p_op = 'insert' then
    if coalesce(v_req, 'pending') <> 'pending' then
      raise exception 'invalid_transition' using errcode = 'PT422',
        detail = 'A merge request is created as pending; use merge_persons() to merge.';
    end if;
    select pe.country_id, pe.branch_id into v_country, v_branch
    from public.persons pe
    where pe.id = (p_fields ->> 'target_person_id')::uuid and pe.deleted_at is null;
    if not found then
      raise exception 'parent_missing' using errcode = 'PT422',
        detail = 'person_merge_requests.target_person_id points to a person that does not exist on the server';
    end if;
    if not private.sync_can(p_ctx, 'review', 'row', v_country, v_branch) then
      raise exception 'out_of_scope' using errcode = 'PT403',
        detail = 'Both persons of a merge request must be inside your review scope.';
    end if;
    v_force := jsonb_build_object('state', 'pending');
  elsif v_req is not null and v_req <> v_old then
    if not (v_old = 'pending' and v_req = 'rejected') then
      raise exception 'invalid_transition' using errcode = 'PT422',
        detail = 'Only pending -> rejected is possible through sync; use merge_persons() / revert_person_merge().';
    end if;
    v_force := jsonb_build_object('state', 'rejected', 'decided_by', p_ctx.uid, 'decided_at', now());
  end if;
  return jsonb_build_object('fields', v_fields, 'force', v_force, 'on_change', '{}'::jsonb);
end;
$$;

-- -----------------------------------------------------------------------------
-- Error object of a rejected operation. Never contains DETAIL of database
-- errors (it can quote stored values).
-- -----------------------------------------------------------------------------
create or replace function private.sync_error(
  p_state text, p_message text, p_detail text, p_constraint text, p_column text)
returns jsonb
language sql
immutable
set search_path = public, extensions, private, pg_temp
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'code', case
      when p_state like 'PT%' and p_message ~ '^[a-z][a-z0-9_]*$' then p_message
      when p_state like 'PT%' then 'validation_failed'
      when p_state = '23505' then 'unique_violation'
      when p_state = '23503' then 'fk_violation'
      when p_state = '23502' then 'not_null_violation'
      when p_state = '23514' then 'check_violation'
      when p_state like '22%' then 'invalid_value'
      when p_state = 'P0001' then 'validation_failed'
      else 'internal_error'
    end,
    'message', case
      when p_state like 'PT%' then coalesce(nullif(p_detail, ''), p_message)
      else p_message
    end,
    'sqlstate', p_state,
    'constraint', nullif(p_constraint, ''),
    'column', nullif(p_column, '')));
$$;

-- -----------------------------------------------------------------------------
-- Apply ONE operation. Called by sync_push inside the operation's
-- sub-transaction; raises on any authorisation/validation problem.
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
  v_def         text;
  v_defval      jsonb;
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
  v_base := coalesce((p_op ->> 'base_version')::integer, 0);
  if v_base < 0 then
    raise exception 'invalid_base_version' using errcode = 'PT422';
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
    if v_cur is null then
      -- never reached the server (or already purged): nothing to do
      return jsonb_build_object('op_id', v_op_id, 'status', 'applied', 'version', null);
    end if;
    v_cur_version := (v_cur ->> 'version')::integer;
    v_scope       := private.sync_row_scope(reg, v_cur, v_id);
    -- restricted row of a country whose restricted data the caller cannot see:
    -- the answer is the same constant as for a blind upsert (see 8.)
    v_blind := v_restricted and not private.sync_sees_restricted(p_ctx, v_scope.country_id);
    if (v_cur ->> 'deleted_at') is not null then
      return jsonb_build_object('op_id', v_op_id, 'status', 'applied',
                                'version', case when v_blind then null else v_cur_version end);
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
      'status', case when v_others_any and not v_blind then 'merged' else 'applied' end,
      'version', case when v_blind then null else v_version end);
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

  -- Blind writes (sync.md §4.4). A caller who cannot see the restricted data of
  -- the row's country (field collector, branch supervisor, ...) must get an
  -- answer that depends on his own input and scope only — never on what is
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
    foreach v_k in array reg.natural_key loop
      if not (v_clean ? v_k) then
        select pg_get_expr(d.adbin, d.adrelid) into v_def
        from pg_attrdef d
        join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
        where d.adrelid = format('public.%I', v_table)::regclass and a.attname = v_k;
        if v_def is not null then
          execute format('select to_jsonb(%s)', v_def) into v_defval;
          v_clean := v_clean || jsonb_build_object(v_k, v_defval);
        end if;
      end if;
    end loop;
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
    if v_delta <> '{}'::jsonb and v_base < v_cur_version then
      select coalesce(bool_or(a.op = 'INSERT'), false),
             coalesce(array_agg(distinct f.name) filter (where f.name is not null), '{}'::text[]),
             count(*) > 0
        into v_others_all, v_others, v_others_any
      from public.audit_log a
      left join lateral unnest(a.changed_fields) as f(name) on true
      where a.table_name = v_table
        and a.row_id = v_id
        and a.row_version > v_base
        and a.device_id is distinct from p_ctx.device;
    end if;

    for v_k in select jsonb_object_keys(v_delta) loop
      if v_others_all or v_k = any (v_others) then
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
  --    conflict ids or fields — what was written, already equal or left for a
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

-- -----------------------------------------------------------------------------
-- sync_push
-- -----------------------------------------------------------------------------
create or replace function public.sync_push(p_ops jsonb, p_device_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_uid        uuid := auth.uid();
  c            private.sync_ctx;
  v_device     text;
  v_op         jsonb;
  v_op_id      uuid;
  v_res        jsonb;
  v_prev_user  uuid;
  v_prev_res   jsonb;
  v_results    jsonb := '[]'::jsonb;
  v_state      text;
  v_msg        text;
  v_detail     text;
  v_constraint text;
  v_column     text;
  v_log_rejections boolean;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = 'PT401';
  end if;
  if p_ops is null or jsonb_typeof(p_ops) <> 'array' then
    raise exception 'invalid_ops' using errcode = 'PT422', detail = 'p_ops must be a JSON array';
  end if;
  if jsonb_array_length(p_ops) > 50 then
    raise exception 'too_many_ops' using errcode = 'PT422',
      detail = 'At most 50 operations per call.';
  end if;
  if p_device_id is null or p_device_id !~ '^[A-Za-z0-9._:-]{1,128}$' then
    raise exception 'invalid_device_id' using errcode = 'PT422',
      detail = 'device id must be 1-128 characters of [A-Za-z0-9._:-]';
  end if;

  -- The audit trigger records private.device_id(): the x-device-id header, or
  -- this transaction-local setting when the header is absent. The merge logic
  -- compares against the same value, so both must name the same device.
  perform set_config('app.device_id', p_device_id, true);
  v_device := private.device_id();
  if v_device is distinct from p_device_id then
    raise exception 'device_mismatch' using errcode = 'PT422',
      detail = 'x-device-id header and p_device_id differ';
  end if;

  if not private.session_ok() then
    raise exception 'session_revoked' using errcode = 'PT403',
      detail = 'The session, the account or this device has been revoked.';
  end if;

  perform private.rate_limit('sync_push', 120, interval '1 minute');

  c := private.sync_ctx();
  c.device := v_device;

  for v_op in
    select e.value from jsonb_array_elements(p_ops) with ordinality as e(value, ord) order by e.ord
  loop
    v_res := null;

    if jsonb_typeof(v_op) <> 'object'
       or coalesce(v_op ->> 'op_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      v_res := jsonb_build_object(
        'op_id', case when jsonb_typeof(v_op) = 'object' then v_op -> 'op_id' end,
        'status', 'rejected',
        'error', jsonb_build_object('code', 'invalid_op', 'message', 'every operation needs a UUID op_id'));
    else
      v_op_id := (v_op ->> 'op_id')::uuid;

      -- idempotency: an op that was applied before returns its stored result
      select o.user_id, o.result into v_prev_user, v_prev_res
      from public.sync_applied_ops o
      where o.op_id = v_op_id;

      if found then
        if v_prev_user is distinct from v_uid then
          v_res := jsonb_build_object('op_id', v_op_id, 'status', 'rejected',
            'error', jsonb_build_object('code', 'op_id_taken', 'message', 'op_id was used by another user'));
        else
          v_res := v_prev_res || jsonb_build_object('status', 'duplicate', 'original_status', v_prev_res -> 'status');
        end if;
      else
        begin
          -- Claim the op id first: a concurrent call with the same op waits here
          -- and then sees the committed ledger row instead of applying twice.
          insert into public.sync_applied_ops (op_id, user_id, device_id, result)
          values (v_op_id, v_uid, v_device, '{}'::jsonb)
          on conflict (op_id) do nothing;

          if not found then
            select o.user_id, o.result into v_prev_user, v_prev_res
            from public.sync_applied_ops o
            where o.op_id = v_op_id;
            if v_prev_user is distinct from v_uid then
              v_res := jsonb_build_object('op_id', v_op_id, 'status', 'rejected',
                'error', jsonb_build_object('code', 'op_id_taken', 'message', 'op_id was used by another user'));
            else
              v_res := v_prev_res || jsonb_build_object('status', 'duplicate', 'original_status', v_prev_res -> 'status');
            end if;
          else
            v_res := private.sync_apply_op(c, v_op);
            update public.sync_applied_ops o set result = v_res where o.op_id = v_op_id;
          end if;
        exception when others then
          get stacked diagnostics
            v_state      = returned_sqlstate,
            v_msg        = message_text,
            v_detail     = pg_exception_detail,
            v_constraint = constraint_name,
            v_column     = column_name;
          -- serialization failure, deadlock, lock timeout: the whole call must be
          -- retried by the client (it is idempotent), not parked as a bad op
          if v_state in ('40001', '40P01', '55P03') then
            raise;
          end if;
          -- nothing of this op was applied (sub-transaction rolled back), and it
          -- is NOT recorded in the ledger: the same op_id may be retried later
          v_res := jsonb_build_object(
            'op_id', v_op_id,
            'status', 'rejected',
            'error', private.sync_error(v_state, v_msg, v_detail, v_constraint, v_column));
        end;
      end if;
    end if;

    -- Rejected operations leave no trace in the ledger; the sync-status board
    -- counts them from private.sync_rejections (migration 0045). Logged here,
    -- outside the rolled-back sub-transaction.
    if v_res ->> 'status' = 'rejected' then
      if v_log_rejections is null then
        v_log_rejections := to_regprocedure('private.log_sync_rejection(uuid,text,jsonb,jsonb)') is not null;
      end if;
      if v_log_rejections then
        perform private.log_sync_rejection(v_uid, v_device, v_op, v_res -> 'error');
      end if;
    end if;

    v_results := v_results || jsonb_build_array(v_res);
  end loop;

  update public.devices d
  set last_push_at = now(), last_seen_at = now()
  where d.user_id = v_uid and d.device_id = v_device;

  return jsonb_build_object('results', v_results, 'server_time', clock_timestamp());
end;
$$;

comment on function public.sync_push(jsonb, text) is
  'Applies up to 50 outbox operations idempotently (ledger: sync_applied_ops) with field-level merge; one sub-transaction per operation. Returns per-op results in input order.';

-- -----------------------------------------------------------------------------
-- Privileges
-- -----------------------------------------------------------------------------
revoke execute on function
  private.sync_row_scope(private.sync_tables, jsonb, uuid),
  private.sync_donor_visible(private.sync_ctx, uuid, uuid),
  private.sync_sees_restricted(private.sync_ctx, uuid),
  private.sync_probe_insert(text, jsonb),
  private.sync_authorise(text, boolean, boolean, boolean, boolean, boolean),
  private.sync_guard_projects(private.sync_ctx, text, jsonb, jsonb, boolean),
  private.sync_guard_localities(private.sync_ctx, text, jsonb, jsonb, boolean),
  private.sync_guard_project_staff(private.sync_ctx, text, jsonb, jsonb, boolean),
  private.sync_guard_project_donors(private.sync_ctx, text, jsonb, jsonb, boolean),
  private.sync_guard_person_merge_requests(private.sync_ctx, text, jsonb, jsonb, boolean),
  private.sync_error(text, text, text, text, text),
  private.sync_apply_op(private.sync_ctx, jsonb)
from public, anon, authenticated;

revoke execute on function public.sync_push(jsonb, text) from public, anon;
grant  execute on function public.sync_push(jsonb, text) to authenticated;

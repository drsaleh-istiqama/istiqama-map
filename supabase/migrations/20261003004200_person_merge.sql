-- =============================================================================
-- 0042  Manual person merge with a full undo trail (brief §2.4, §3)
--
--   public.merge_persons(p_source, p_target, p_reason)          reviewer of both persons
--   public.revert_person_merge(p_request_id)                    reviewer of both persons
--   public.request_person_merge(p_source, p_target, p_reason)   anyone who may see both persons
--   public.resolve_person_merge_request(p_request_id, p_decision, p_note)
--                                                               reviewer; 'approve' | 'reject'
--
-- A merge is always an explicit human decision. It
--   1. re-points the source person's live project_staff rows to the target
--      (a row that would duplicate an assignment the target already has is
--      soft-deleted instead, and its salary rows follow the surviving row only
--      when that row has none of its own);
--   2. soft-deletes the source person and sets merged_into_id;
--   3. fills blank descriptive fields of the target from the source;
--   4. stores everything it did in person_merge_requests.undo, so that
--      revert_person_merge can restore the previous state exactly.
--
-- All writes are ordinary UPDATEs/INSERTs, so the standard triggers bump
-- version/sync_xid (devices receive the changes on the next pull) and the
-- audit trigger records them.
--
-- JSON shapes: docs/contracts/people-admin.md
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Worker shared by merge_persons() and resolve_person_merge_request('approve').
-- Does its own authorisation; not executable by API roles.
-- -----------------------------------------------------------------------------
create or replace function private.merge_persons_apply(
  p_source     uuid,
  p_target     uuid,
  p_reason     text,
  p_request_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  -- descriptive columns copied to the target when the target has no value
  c_fill constant text[] := array[
    'name_latin', 'phone_e164', 'gender', 'birth_year', 'birth_date',
    'home_admin_area_id', 'home_area_text', 'education_level', 'graduated_from'
  ];
  v_uid        uuid := auth.uid();
  v_now        timestamptz := clock_timestamp();
  v_src        public.persons%rowtype;
  v_tgt        public.persons%rowtype;
  v_src_j      jsonb;
  v_tgt_j      jsonb;
  v_col        text;
  v_filled     jsonb := '{}'::jsonb;
  v_moved      uuid[] := '{}'::uuid[];
  v_collapsed  jsonb := '[]'::jsonb;
  v_comp       uuid[];
  v_kept       uuid;
  v_undo       jsonb;
  v_request_id uuid := p_request_id;
  v_reason     text := nullif(left(btrim(coalesce(p_reason, '')), 1000), '');
  r            record;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = 'PT401';
  end if;
  if p_source is null or p_target is null then
    raise exception 'invalid_argument' using errcode = 'PT422',
      detail = 'Source and target persons are required.';
  end if;
  if p_source = p_target then
    raise exception 'invalid_argument' using errcode = 'PT422',
      detail = 'A person cannot be merged into itself.';
  end if;

  -- Coarse check first so that callers without any review capability learn nothing.
  if not (coalesce(private.review_all(), false)
          or cardinality(coalesce(private.review_countries(), '{}'::uuid[])) > 0
          or cardinality(coalesce(private.review_branches(), '{}'::uuid[])) > 0) then
    raise exception 'forbidden' using errcode = 'PT403',
      detail = 'Only reviewers (branch supervisor, country manager, HQ) may merge persons.';
  end if;

  -- Lock both rows in id order (no deadlock between two concurrent merges).
  perform 1 from public.persons p where p.id in (p_source, p_target) order by p.id for update;
  select * into v_src from public.persons p where p.id = p_source;
  select * into v_tgt from public.persons p where p.id = p_target;
  if v_src.id is null or v_tgt.id is null then
    raise exception 'person_not_found' using errcode = 'PT404';
  end if;

  if not (private.can_review(v_src.country_id, v_src.branch_id)
          and private.can_review(v_tgt.country_id, v_tgt.branch_id)) then
    raise exception 'forbidden' using errcode = 'PT403',
      detail = 'Merging requires review rights over both persons.';
  end if;

  if v_src.deleted_at is not null or v_src.merged_into_id is not null then
    raise exception 'person_already_merged' using errcode = 'PT409',
      detail = 'The source person is deleted or already merged.';
  end if;
  if v_tgt.deleted_at is not null or v_tgt.merged_into_id is not null then
    raise exception 'person_already_merged' using errcode = 'PT409',
      detail = 'The target person is deleted or already merged.';
  end if;

  -- 1. Staff links ------------------------------------------------------------
  for r in
    select s.id, s.project_id, s.role, s.start_date, s.end_date
    from public.project_staff s
    where s.person_id = p_source
      and s.deleted_at is null
    order by s.id
    for update
  loop
    -- An assignment the target already holds (same project, same role, same end)?
    select k.id
    into v_kept
    from public.project_staff k
    where k.person_id = p_target
      and k.project_id = r.project_id
      and k.role = r.role
      and k.deleted_at is null
      and k.end_date is not distinct from r.end_date
      and (k.start_date is null or r.start_date is null or k.start_date = r.start_date)
    order by k.created_at, k.id
    limit 1;

    if v_kept is null then
      begin
        update public.project_staff s set person_id = p_target where s.id = r.id;
        v_moved := v_moved || r.id;
      exception
        when unique_violation then
          -- A uniqueness rule treats the two rows as the same assignment.
          select k.id
          into v_kept
          from public.project_staff k
          where k.person_id = p_target
            and k.project_id = r.project_id
            and k.role = r.role
            and k.deleted_at is null
          order by k.created_at, k.id
          limit 1;
          if v_kept is null then
            raise;
          end if;
      end;
    end if;

    if v_kept is not null then
      v_comp := '{}'::uuid[];
      if not exists (
        select 1 from public.staff_compensation c
        where c.project_staff_id = v_kept and c.deleted_at is null
      ) then
        with moved as (
          update public.staff_compensation c
          set project_staff_id = v_kept
          where c.project_staff_id = r.id
            and c.deleted_at is null
          returning c.id
        )
        select coalesce(array_agg(m.id), '{}'::uuid[]) into v_comp from moved m;
      end if;

      update public.project_staff s set deleted_at = v_now where s.id = r.id;

      v_collapsed := v_collapsed || jsonb_build_object(
        'id', r.id,
        'kept_id', v_kept,
        'moved_compensation', to_jsonb(v_comp));
    end if;
  end loop;

  -- 2. Source person ------------------------------------------------------------
  update public.persons p
  set deleted_at = v_now,
      merged_into_id = p_target
  where p.id = p_source;

  -- 3. Fill blank fields of the target --------------------------------------------
  v_src_j := to_jsonb(v_src);
  v_tgt_j := to_jsonb(v_tgt);
  foreach v_col in array c_fill loop
    if nullif(btrim(coalesce(v_tgt_j ->> v_col, '')), '') is null
       and nullif(btrim(coalesce(v_src_j ->> v_col, '')), '') is not null then
      v_filled := v_filled || jsonb_build_object(v_col, v_src_j -> v_col);
    end if;
  end loop;
  -- Paired fields are never mixed from two persons.
  if v_tgt.home_admin_area_id is not null or nullif(btrim(coalesce(v_tgt.home_area_text, '')), '') is not null then
    v_filled := v_filled - 'home_admin_area_id' - 'home_area_text';
  end if;
  if v_tgt.birth_date is not null then
    v_filled := v_filled - 'birth_year';
  end if;
  if v_tgt.birth_year is not null and v_src.birth_date is not null
     and extract(year from v_src.birth_date)::integer <> v_tgt.birth_year then
    v_filled := v_filled - 'birth_date';
  end if;

  if v_filled <> '{}'::jsonb then
    update public.persons t
    set name_latin         = case when v_filled ? 'name_latin'         then v_src.name_latin         else t.name_latin end,
        phone_e164         = case when v_filled ? 'phone_e164'         then v_src.phone_e164         else t.phone_e164 end,
        gender             = case when v_filled ? 'gender'             then v_src.gender             else t.gender end,
        birth_year         = case when v_filled ? 'birth_year'         then v_src.birth_year         else t.birth_year end,
        birth_date         = case when v_filled ? 'birth_date'         then v_src.birth_date         else t.birth_date end,
        home_admin_area_id = case when v_filled ? 'home_admin_area_id' then v_src.home_admin_area_id else t.home_admin_area_id end,
        home_area_text     = case when v_filled ? 'home_area_text'     then v_src.home_area_text     else t.home_area_text end,
        education_level    = case when v_filled ? 'education_level'    then v_src.education_level    else t.education_level end,
        graduated_from     = case when v_filled ? 'graduated_from'     then v_src.graduated_from     else t.graduated_from end
    where t.id = p_target;
  end if;

  -- 4. Trail ----------------------------------------------------------------------
  v_undo := jsonb_build_object(
    'v', 1,
    'source_id', p_source,
    'target_id', p_target,
    'moved_staff', to_jsonb(v_moved),
    'collapsed_staff', v_collapsed,
    'target_filled', v_filled,
    'merged_by', v_uid,
    'merged_at', v_now);

  if v_request_id is null then
    v_request_id := private.uuid_v7();
    insert into public.person_merge_requests
      (id, source_person_id, target_person_id, state, reason, decided_by, decided_at, undo)
    values
      (v_request_id, p_source, p_target, 'merged', v_reason, v_uid, v_now, v_undo);
  else
    update public.person_merge_requests q
    set state = 'merged',
        reason = coalesce(q.reason, v_reason),
        decided_by = v_uid,
        decided_at = v_now,
        undo = v_undo
    where q.id = v_request_id;
  end if;

  return jsonb_build_object(
    'request_id', v_request_id,
    'state', 'merged',
    'source_id', p_source,
    'target_id', p_target,
    'moved_staff', cardinality(v_moved),
    'collapsed_staff', jsonb_array_length(v_collapsed),
    'filled_fields', coalesce((select jsonb_agg(k order by k) from jsonb_object_keys(v_filled) k), '[]'::jsonb));
end;
$$;

comment on function private.merge_persons_apply(uuid, uuid, text, uuid) is
  'Merges person p_source into p_target (review rights over both required) and records the undo data in person_merge_requests.';

-- -----------------------------------------------------------------------------
-- public.merge_persons
-- -----------------------------------------------------------------------------
create or replace function public.merge_persons(p_source uuid, p_target uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = 'PT401';
  end if;
  perform private.rate_limit('merge_persons', 60, interval '1 minute');
  return private.merge_persons_apply(p_source, p_target, p_reason, null);
end;
$$;

comment on function public.merge_persons(uuid, uuid, text) is
  'Manual, reversible merge of person p_source into p_target. Reviewers (branch_supervisor, country_manager, hq_admin) of both persons only.';

-- -----------------------------------------------------------------------------
-- public.revert_person_merge
-- -----------------------------------------------------------------------------
create or replace function public.revert_person_merge(p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_uid         uuid := auth.uid();
  v_now         timestamptz := clock_timestamp();
  v_req         public.person_merge_requests%rowtype;
  v_src         public.persons%rowtype;
  v_tgt         public.persons%rowtype;
  v_tgt_j       jsonb;
  v_undo        jsonb;
  v_filled      jsonb;
  v_moved       uuid[];
  v_reset       text[] := '{}'::text[];
  v_restored    integer := 0;
  v_uncollapsed integer := 0;
  v_n           integer;
  v_key         text;
  r             record;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = 'PT401';
  end if;
  if p_request_id is null then
    raise exception 'invalid_argument' using errcode = 'PT422',
      detail = 'The merge request id is required.';
  end if;
  if not (coalesce(private.review_all(), false)
          or cardinality(coalesce(private.review_countries(), '{}'::uuid[])) > 0
          or cardinality(coalesce(private.review_branches(), '{}'::uuid[])) > 0) then
    raise exception 'forbidden' using errcode = 'PT403',
      detail = 'Only reviewers may revert a merge.';
  end if;

  perform private.rate_limit('merge_persons', 60, interval '1 minute');

  select * into v_req
  from public.person_merge_requests q
  where q.id = p_request_id and q.deleted_at is null
  for update;
  if v_req.id is null then
    raise exception 'merge_request_not_found' using errcode = 'PT404';
  end if;

  perform 1 from public.persons p
  where p.id in (v_req.source_person_id, v_req.target_person_id)
  order by p.id for update;
  select * into v_src from public.persons p where p.id = v_req.source_person_id;
  select * into v_tgt from public.persons p where p.id = v_req.target_person_id;
  if v_src.id is null or v_tgt.id is null then
    raise exception 'person_not_found' using errcode = 'PT404';
  end if;

  if not (private.can_review(v_src.country_id, v_src.branch_id)
          and private.can_review(v_tgt.country_id, v_tgt.branch_id)) then
    raise exception 'forbidden' using errcode = 'PT403',
      detail = 'Reverting requires review rights over both persons.';
  end if;

  if v_req.state <> 'merged' then
    raise exception 'merge_not_revertible' using errcode = 'PT409',
      detail = format('Only a merged request can be reverted (current state: %s).', v_req.state);
  end if;
  if v_src.deleted_at is null or v_src.merged_into_id is distinct from v_req.target_person_id then
    raise exception 'merge_not_revertible' using errcode = 'PT409',
      detail = 'The source person is no longer merged into the target.';
  end if;
  if v_tgt.merged_into_id is not null then
    raise exception 'merge_not_revertible' using errcode = 'PT409',
      detail = 'The target person has itself been merged; revert that merge first.';
  end if;

  v_undo := v_req.undo;
  if v_undo is null or jsonb_typeof(v_undo) <> 'object' or not (v_undo ? 'moved_staff') then
    raise exception 'merge_not_revertible' using errcode = 'PT409',
      detail = 'This merge has no undo information.';
  end if;

  -- 1. Staff rows that were re-pointed go back to the source person. Rows that
  --    were changed to yet another person since the merge are left alone.
  select coalesce(array_agg(x::uuid), '{}'::uuid[])
  into v_moved
  from jsonb_array_elements_text(coalesce(v_undo -> 'moved_staff', '[]'::jsonb)) x;

  update public.project_staff s
  set person_id = v_req.source_person_id
  where s.id = any (v_moved)
    and s.person_id = v_req.target_person_id;
  get diagnostics v_restored = row_count;

  -- 2. Duplicate assignments that were soft-deleted come back, with their salary rows.
  for r in
    select (e ->> 'id')::uuid as id,
           (e ->> 'kept_id')::uuid as kept_id,
           coalesce(e -> 'moved_compensation', '[]'::jsonb) as comp
    from jsonb_array_elements(coalesce(v_undo -> 'collapsed_staff', '[]'::jsonb)) e
  loop
    update public.project_staff s
    set deleted_at = null
    where s.id = r.id
      and s.person_id = v_req.source_person_id
      and s.deleted_at is not null;
    get diagnostics v_n = row_count;
    v_uncollapsed := v_uncollapsed + v_n;

    update public.staff_compensation c
    set project_staff_id = r.id
    where c.id in (select x::uuid from jsonb_array_elements_text(r.comp) x)
      and c.project_staff_id = r.kept_id;
  end loop;

  -- 3. The source person is live again.
  update public.persons p
  set deleted_at = null,
      merged_into_id = null
  where p.id = v_req.source_person_id;

  -- 4. Fields that the merge copied to the target are cleared again, unless
  --    somebody changed them in the meantime.
  v_filled := coalesce(v_undo -> 'target_filled', '{}'::jsonb);
  v_tgt_j := to_jsonb(v_tgt);
  for v_key in select k from jsonb_object_keys(v_filled) k loop
    if (v_tgt_j -> v_key) = (v_filled -> v_key) then
      v_reset := v_reset || v_key;
    end if;
  end loop;

  if cardinality(v_reset) > 0 then
    update public.persons t
    set name_latin         = case when 'name_latin'         = any (v_reset) then null else t.name_latin end,
        phone_e164         = case when 'phone_e164'         = any (v_reset) then null else t.phone_e164 end,
        gender             = case when 'gender'             = any (v_reset) then null else t.gender end,
        birth_year         = case when 'birth_year'         = any (v_reset) then null else t.birth_year end,
        birth_date         = case when 'birth_date'         = any (v_reset) then null else t.birth_date end,
        home_admin_area_id = case when 'home_admin_area_id' = any (v_reset) then null else t.home_admin_area_id end,
        home_area_text     = case when 'home_area_text'     = any (v_reset) then null else t.home_area_text end,
        education_level    = case when 'education_level'    = any (v_reset) then null else t.education_level end,
        graduated_from     = case when 'graduated_from'     = any (v_reset) then null else t.graduated_from end
    where t.id = v_req.target_person_id;
  end if;

  -- 5. Trail: the undo data is kept and stamped with who reverted and when.
  update public.person_merge_requests q
  set state = 'reverted',
      undo = v_undo || jsonb_build_object('reverted_by', v_uid, 'reverted_at', v_now)
  where q.id = p_request_id;

  return jsonb_build_object(
    'request_id', p_request_id,
    'state', 'reverted',
    'source_id', v_req.source_person_id,
    'target_id', v_req.target_person_id,
    'restored_staff', v_restored,
    'skipped_staff', cardinality(v_moved) - v_restored,
    'restored_collapsed', v_uncollapsed,
    'reset_fields', to_jsonb(v_reset));
end;
$$;

comment on function public.revert_person_merge(uuid) is
  'Undoes a merge recorded in person_merge_requests (state merged -> reverted) using its undo data. Reviewers of both persons only.';

-- -----------------------------------------------------------------------------
-- public.request_person_merge — propose a merge for a reviewer to decide.
-- -----------------------------------------------------------------------------
create or replace function public.request_person_merge(p_source uuid, p_target uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_src    public.persons%rowtype;
  v_tgt    public.persons%rowtype;
  v_id     uuid;
  v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 1000), '');
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = 'PT401';
  end if;
  if p_source is null or p_target is null then
    raise exception 'invalid_argument' using errcode = 'PT422',
      detail = 'Source and target persons are required.';
  end if;
  if p_source = p_target then
    raise exception 'invalid_argument' using errcode = 'PT422',
      detail = 'A person cannot be merged into itself.';
  end if;
  if not (coalesce(private.people_all(), false)
          or cardinality(coalesce(private.people_countries(), '{}'::uuid[])) > 0
          or cardinality(coalesce(private.people_branches(), '{}'::uuid[])) > 0) then
    raise exception 'forbidden' using errcode = 'PT403',
      detail = 'Proposing a merge requires a role that may see people.';
  end if;

  perform private.rate_limit('request_person_merge', 60, interval '1 minute');

  select * into v_src from public.persons p where p.id = p_source;
  select * into v_tgt from public.persons p where p.id = p_target;
  if v_src.id is null or v_tgt.id is null
     or not private.can_see_people(v_src.country_id, v_src.branch_id)
     or not private.can_see_people(v_tgt.country_id, v_tgt.branch_id) then
    -- same answer for "does not exist" and "not yours": no existence oracle
    raise exception 'person_not_found' using errcode = 'PT404';
  end if;
  if v_src.deleted_at is not null or v_src.merged_into_id is not null
     or v_tgt.deleted_at is not null or v_tgt.merged_into_id is not null then
    raise exception 'person_already_merged' using errcode = 'PT409',
      detail = 'One of the persons is deleted or already merged.';
  end if;

  -- One pending request per pair, whatever the direction.
  select q.id into v_id
  from public.person_merge_requests q
  where q.state = 'pending'
    and q.deleted_at is null
    and ((q.source_person_id = p_source and q.target_person_id = p_target)
      or (q.source_person_id = p_target and q.target_person_id = p_source))
  order by q.created_at
  limit 1;

  if v_id is not null then
    return jsonb_build_object('request_id', v_id, 'state', 'pending', 'created', false);
  end if;

  v_id := private.uuid_v7();
  insert into public.person_merge_requests (id, source_person_id, target_person_id, state, reason)
  values (v_id, p_source, p_target, 'pending', v_reason);

  return jsonb_build_object('request_id', v_id, 'state', 'pending', 'created', true);
end;
$$;

comment on function public.request_person_merge(uuid, uuid, text) is
  'Creates a pending person_merge_requests row for a reviewer to approve or reject. Nothing is merged.';

-- -----------------------------------------------------------------------------
-- public.resolve_person_merge_request — approve (merge now) or reject.
-- -----------------------------------------------------------------------------
create or replace function public.resolve_person_merge_request(
  p_request_id uuid,
  p_decision   text,
  p_note       text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_uid  uuid := auth.uid();
  v_req  public.person_merge_requests%rowtype;
  v_src  public.persons%rowtype;
  v_tgt  public.persons%rowtype;
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 1000), '');
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = 'PT401';
  end if;
  if p_request_id is null or p_decision is null or p_decision not in ('approve', 'reject') then
    raise exception 'invalid_argument' using errcode = 'PT422',
      detail = 'The decision must be "approve" or "reject".';
  end if;
  if not (coalesce(private.review_all(), false)
          or cardinality(coalesce(private.review_countries(), '{}'::uuid[])) > 0
          or cardinality(coalesce(private.review_branches(), '{}'::uuid[])) > 0) then
    raise exception 'forbidden' using errcode = 'PT403',
      detail = 'Only reviewers may decide a merge request.';
  end if;

  perform private.rate_limit('merge_persons', 60, interval '1 minute');

  select * into v_req
  from public.person_merge_requests q
  where q.id = p_request_id and q.deleted_at is null
  for update;
  if v_req.id is null then
    raise exception 'merge_request_not_found' using errcode = 'PT404';
  end if;

  select * into v_src from public.persons p where p.id = v_req.source_person_id;
  select * into v_tgt from public.persons p where p.id = v_req.target_person_id;
  if v_src.id is null or v_tgt.id is null then
    raise exception 'person_not_found' using errcode = 'PT404';
  end if;
  if not (private.can_review(v_src.country_id, v_src.branch_id)
          and private.can_review(v_tgt.country_id, v_tgt.branch_id)) then
    raise exception 'forbidden' using errcode = 'PT403',
      detail = 'Deciding requires review rights over both persons.';
  end if;

  if v_req.state <> 'pending' then
    raise exception 'request_not_pending' using errcode = 'PT409',
      detail = format('The request is not pending (current state: %s).', v_req.state);
  end if;

  if p_decision = 'approve' then
    return private.merge_persons_apply(
      v_req.source_person_id, v_req.target_person_id, coalesce(v_note, v_req.reason), v_req.id);
  end if;

  update public.person_merge_requests q
  set state = 'rejected',
      decided_by = v_uid,
      decided_at = clock_timestamp(),
      undo = case when v_note is null then q.undo
                  else coalesce(q.undo, '{}'::jsonb) || jsonb_build_object('decision_note', v_note) end
  where q.id = p_request_id;

  return jsonb_build_object(
    'request_id', p_request_id,
    'state', 'rejected',
    'source_id', v_req.source_person_id,
    'target_id', v_req.target_person_id);
end;
$$;

comment on function public.resolve_person_merge_request(uuid, text, text) is
  'Decides a pending merge request: approve performs the merge (reversible), reject closes it. Reviewers of both persons only.';

-- -----------------------------------------------------------------------------
-- Supporting indexes (no-ops when the core migration already has equivalents).
-- -----------------------------------------------------------------------------
create index if not exists person_merge_requests_pending_idx
  on public.person_merge_requests (source_person_id, target_person_id)
  where state = 'pending' and deleted_at is null;

-- -----------------------------------------------------------------------------
-- Privileges
-- -----------------------------------------------------------------------------
revoke execute on function private.merge_persons_apply(uuid, uuid, text, uuid) from public, anon, authenticated;
grant  execute on function private.merge_persons_apply(uuid, uuid, text, uuid) to service_role;

revoke execute on function public.merge_persons(uuid, uuid, text) from public, anon;
revoke execute on function public.revert_person_merge(uuid) from public, anon;
revoke execute on function public.request_person_merge(uuid, uuid, text) from public, anon;
revoke execute on function public.resolve_person_merge_request(uuid, text, text) from public, anon;

grant execute on function public.merge_persons(uuid, uuid, text) to authenticated, service_role;
grant execute on function public.revert_person_merge(uuid) to authenticated, service_role;
grant execute on function public.request_person_merge(uuid, uuid, text) to authenticated, service_role;
grant execute on function public.resolve_person_merge_request(uuid, text, text) to authenticated, service_role;

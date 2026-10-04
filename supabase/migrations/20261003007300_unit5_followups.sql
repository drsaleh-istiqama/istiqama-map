-- =============================================================================
-- 0073  Unit 5 follow-ups (server)
--
--   1. Export "all fields" (brief §9.3):
--      - projects sheet: + migration_note, reviewed_at, reviewed_by (people),
--        maintenance_closed (closed maintenance history count);
--      - a second table, the STAFF sheet: public.export_staff_rows(job, after, limit),
--        one row per current staff assignment with the person's fields (persons_select
--        scope; phone masked outside it), role and dates, and the current salary
--        (amount / currency / effective_from / USD) ONLY for callers with restricted
--        access to the project's country — every page with salaries is logged
--        (private.log_restricted);
--      - dictionary private.export_staff_column_defs (ar / sw / en) returned by
--        export_columns(lang) as "staff_columns" (only for callers with people scope);
--      - the project selection of a job (filters + caller scope + owner decision ح) moved
--        into private.export_job_project_ids so that both tables page over exactly the
--        same projects;
--      - export_request accepts filters.dataset = 'projects' (default) | 'staff'.
--   2. Last-hq_admin guard on the DIRECT UPDATE path (user_roles / profiles through
--      PostgREST): the AFTER ROW check now takes private.lock_hq_admins() first, and a
--      BEFORE STATEMENT trigger takes the same advisory lock before the statement locks
--      any row (one lock order everywhere: advisory lock, then rows).
--   3. projects.migration_note: a client-writable flag for the v2 migration (OWNER_DECISIONS
--      item أ). sync_push keeps review_note a reviewer field; a collector's review_note on
--      INSERT is kept as migration_note (the v2 migration of the current web client writes
--      its salary-currency flag there).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 3. projects.migration_note (first: the export below reads it)
-- -----------------------------------------------------------------------------
alter table public.projects add column if not exists migration_note text;

alter table public.projects drop constraint if exists projects_migration_note_ck;
alter table public.projects
  add constraint projects_migration_note_ck check (migration_note is null or char_length(migration_note) <= 2000);

comment on column public.projects.migration_note is
  'Note written by the v2 data migration (e.g. salaries without a currency got the country''s default currency and must be checked, OWNER_DECISIONS item أ). Client-writable through sync_push; a reviewer clears it once checked.';

-- projects: record_state workflow (brief §3, ARCHITECTURE §2.3) — unchanged except for the
-- migration_note alias on INSERT (see the header).
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
    -- A non-reviewer cannot write review_note. The v2 migration of the web client puts its
    -- "check the salary currency" flag there (OWNER_DECISIONS item أ): keep it as
    -- migration_note instead of dropping it, unless the client already sends migration_note.
    if not p_reviewer and not (p_fields ? 'migration_note')
       and nullif(btrim(coalesce(p_fields ->> 'review_note', '')), '') is not null then
      v_fields := v_fields || jsonb_build_object('migration_note', left(p_fields ->> 'review_note', 2000));
    end if;
    v_force := jsonb_build_object('record_state', v_req);
    if p_reviewer and v_req in ('approved', 'returned') then
      v_force := v_force || jsonb_build_object(
        'reviewed_by', p_ctx.uid, 'reviewed_at', now(), 'review_note', p_fields -> 'review_note');
    end if;
    return jsonb_build_object('fields', v_fields, 'force', v_force, 'on_change', v_on_change);
  end if;

  if v_req is null or v_req = v_old then
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

revoke execute on function private.sync_guard_projects(private.sync_ctx, text, jsonb, jsonb, boolean)
  from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. Last-hq_admin guard: serialise the direct UPDATE path
--
-- Before: two concurrent direct UPDATEs (each removing / deactivating a different hq_admin)
-- each ran the AFTER ROW check on its own snapshot, each still saw the other administrator,
-- and both committed — nobody left to administer. Now:
--   * t84_lock_hq_admins (BEFORE UPDATE FOR EACH STATEMENT, API roles only) takes the
--     advisory lock of private.lock_hq_admins() BEFORE the statement locks any row, so the
--     lock order is the same as in admin_remove_role / admin_set_user_active (advisory
--     lock, then rows) and two guarded statements cannot deadlock;
--   * the AFTER ROW check calls private.lock_hq_admins() (advisory lock, already held, plus
--     FOR UPDATE on the live hq_admin grants and profiles) and then checks. Under READ
--     COMMITTED the check is a new statement of a VOLATILE function, so it reads a snapshot
--     taken after the lock: a concurrent removal we waited for is visible. Under REPEATABLE
--     READ / SERIALIZABLE the FOR UPDATE raises 40001 instead of trusting a stale snapshot.
-- -----------------------------------------------------------------------------
create or replace function private.tg_lock_hq_admins_stmt()
returns trigger
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  -- same key as private.lock_hq_admins()
  perform pg_advisory_xact_lock(hashtextextended('istiqama:last_hq_admin', 0));
  return null;
end;
$$;

comment on function private.tg_lock_hq_admins_stmt() is
  'BEFORE UPDATE statement trigger on user_roles/profiles for API roles: takes the last-hq_admin advisory lock before any row is locked (lock order of private.lock_hq_admins).';

revoke execute on function private.tg_lock_hq_admins_stmt() from public, anon, authenticated;

create or replace function private.tg_keep_hq_admin()
returns trigger
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  -- serialise with every other path that can remove an hq_admin (see above)
  perform private.lock_hq_admins();

  if not exists (
    select 1
    from public.user_roles ur
    join public.profiles p on p.id = ur.user_id
    where ur.role = 'hq_admin'
      and ur.scope_type = 'global'
      and ur.deleted_at is null
      and p.active
      and p.deleted_at is null
  ) then
    raise exception 'last_hq_admin' using errcode = 'PT409',
      detail = 'The last active hq_admin cannot be removed or deactivated.',
      hint = 'Grant hq_admin to another active user first.';
  end if;
  return null;
end;
$$;

comment on function private.tg_keep_hq_admin() is
  'AFTER UPDATE trigger on user_roles/profiles for API roles: takes private.lock_hq_admins(), then refuses a change that leaves no live global hq_admin grant with an active profile (PT409 last_hq_admin).';

revoke execute on function private.tg_keep_hq_admin() from public, anon, authenticated;

drop trigger if exists t84_lock_hq_admins on public.user_roles;
create trigger t84_lock_hq_admins
  before update on public.user_roles
  for each statement
  when (current_user in ('authenticated', 'anon'))
  execute function private.tg_lock_hq_admins_stmt();

-- profiles: only statements that can deactivate / delete / re-key a profile (the columns the
-- row trigger t85_keep_hq_admin looks at); ordinary profile edits are not serialised.
drop trigger if exists t84_lock_hq_admins on public.profiles;
create trigger t84_lock_hq_admins
  before update of active, deleted_at, id on public.profiles
  for each statement
  when (current_user in ('authenticated', 'anon'))
  execute function private.tg_lock_hq_admins_stmt();

-- -----------------------------------------------------------------------------
-- 1. Export: dictionaries
-- -----------------------------------------------------------------------------
insert into private.enum_labels (enum_key, code, sort_order, ar, sw, en) values
  ('gender', 'male', 1, 'ذكر', 'Mwanamume', 'Male'),
  ('gender', 'female', 2, 'أنثى', 'Mwanamke', 'Female')
on conflict (enum_key, code) do update
  set sort_order = excluded.sort_order, ar = excluded.ar, sw = excluded.sw, en = excluded.en;

insert into private.export_column_defs (position, key, capability, kind, enum_key, ar, sw, en) values
  (245, 'migration_note', 'all', 'text', null, 'ملاحظة الترحيل', 'Maelezo ya uhamishaji', 'Migration note'),
  (250, 'reviewed_at', 'all', 'datetime', null, 'تاريخ المراجعة', 'Tarehe ya mapitio', 'Reviewed at'),
  (625, 'maintenance_closed', 'all', 'integer', null, 'الصيانة المغلقة (عدد)', 'Matengenezo yaliyofungwa', 'Closed maintenance entries'),
  (740, 'reviewed_by', 'people', 'text', null, 'المراجِع', 'Aliyepitia', 'Reviewed by')
on conflict (position) do update
  set key = excluded.key, capability = excluded.capability, kind = excluded.kind,
      enum_key = excluded.enum_key, ar = excluded.ar, sw = excluded.sw, en = excluded.en;

-- The staff sheet. capability: people (every caller who gets the sheet) | restricted.
create table if not exists private.export_staff_column_defs (
  position smallint primary key,
  key text not null unique,
  capability text not null default 'people' check (capability in ('people', 'restricted')),
  kind text not null check (kind in ('text', 'integer', 'number', 'date', 'datetime', 'boolean', 'enum', 'list')),
  enum_key text,
  ar text not null,
  sw text not null,
  en text not null
);
alter table private.export_staff_column_defs enable row level security;
revoke all on private.export_staff_column_defs from public, anon, authenticated;

insert into private.export_staff_column_defs (position, key, capability, kind, enum_key, ar, sw, en) values
  (10, 'project_code', 'people', 'text', null, 'رمز المشروع', 'Namba ya mradi', 'Project code'),
  (20, 'project_name', 'people', 'text', null, 'اسم المشروع', 'Jina la mradi', 'Project name'),
  (30, 'country', 'people', 'text', null, 'الدولة', 'Nchi', 'Country'),
  (40, 'branch', 'people', 'text', null, 'الفرع', 'Tawi', 'Branch'),
  (50, 'person_name_ar', 'people', 'text', null, 'الاسم (عربي)', 'Jina (Kiarabu)', 'Name (Arabic)'),
  (60, 'person_name_latin', 'people', 'text', null, 'الاسم (لاتيني)', 'Jina (Kilatini)', 'Name (Latin)'),
  (70, 'role', 'people', 'enum', 'staff_role', 'الدور', 'Wadhifa', 'Role'),
  (80, 'start_date', 'people', 'date', null, 'تاريخ البدء', 'Tarehe ya kuanza', 'Start date'),
  (90, 'end_date', 'people', 'date', null, 'تاريخ الانتهاء', 'Tarehe ya kumaliza', 'End date'),
  (100, 'gender', 'people', 'enum', 'gender', 'الجنس', 'Jinsia', 'Gender'),
  (110, 'birth_year', 'people', 'integer', null, 'سنة الميلاد', 'Mwaka wa kuzaliwa', 'Birth year'),
  (115, 'birth_date', 'people', 'date', null, 'تاريخ الميلاد', 'Tarehe ya kuzaliwa', 'Birth date'),
  (120, 'education_level', 'people', 'text', null, 'المستوى التعليمي', 'Kiwango cha elimu', 'Education level'),
  (130, 'graduated_from', 'people', 'text', null, 'جهة التخرج', 'Alikohitimu', 'Graduated from'),
  (140, 'home_area_level1', 'people', 'text', null, 'منطقة السكن: الإقليم / المحافظة', 'Makazi: mkoa', 'Home: region'),
  (150, 'home_area_level2', 'people', 'text', null, 'منطقة السكن: المقاطعة', 'Makazi: wilaya', 'Home: district'),
  (160, 'home_area_level3', 'people', 'text', null, 'منطقة السكن: البلدة / القرية', 'Makazi: kata / kijiji', 'Home: ward / village'),
  (170, 'home_area_text', 'people', 'text', null, 'منطقة السكن (نص)', 'Makazi (maelezo)', 'Home area (text)'),
  (180, 'phone', 'people', 'text', null, 'الهاتف', 'Simu', 'Phone'),
  (200, 'salary_amount', 'restricted', 'number', null, 'الراتب الشهري', 'Mshahara wa mwezi', 'Monthly salary'),
  (210, 'salary_currency', 'restricted', 'text', null, 'عملة الراتب', 'Sarafu ya mshahara', 'Salary currency'),
  (220, 'salary_effective_from', 'restricted', 'date', null, 'الراتب ساري منذ', 'Mshahara tangu', 'Salary effective from'),
  (230, 'salary_usd', 'restricted', 'number', null, 'الراتب الشهري (دولار أمريكي)', 'Mshahara wa mwezi (USD)', 'Monthly salary (USD)'),
  (900, 'person_id', 'people', 'text', null, 'معرّف الشخص', 'Kitambulisho cha mtu', 'Person ID'),
  (910, 'staff_id', 'people', 'text', null, 'معرّف التكليف', 'Kitambulisho cha wadhifa', 'Assignment ID'),
  (920, 'project_id', 'people', 'text', null, 'معرّف المشروع', 'Kitambulisho cha mradi', 'Project ID')
on conflict (position) do update
  set key = excluded.key, capability = excluded.capability, kind = excluded.kind,
      enum_key = excluded.enum_key, ar = excluded.ar, sw = excluded.sw, en = excluded.en;

-- -----------------------------------------------------------------------------
-- export_columns(p_lang): + "staff_columns" (callers with people scope only)
-- -----------------------------------------------------------------------------
create or replace function public.export_columns(p_lang text default 'ar')
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_lang text := coalesce(nullif(btrim(p_lang), ''), 'ar');
  v_people boolean;
  v_restricted boolean;
  v_columns jsonb;
  v_staff jsonb;
  v_enums jsonb;
begin
  perform private.require_session();   -- PT401 no user, PT403 session_revoked
  if v_lang not in ('ar', 'sw', 'en') then
    raise exception 'unsupported language: %', v_lang using errcode = 'PT422';
  end if;

  v_people := private.people_all()
              or cardinality(private.people_countries()) > 0
              or cardinality(private.people_branches()) > 0;
  v_restricted := private.restricted_all() or cardinality(private.restricted_countries()) > 0;

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'key', d.key,
             'header', case v_lang when 'ar' then d.ar when 'sw' then d.sw else d.en end,
             'kind', d.kind,
             'enum', d.enum_key))
           order by d.position), '[]'::jsonb)
    into v_columns
  from private.export_column_defs d
  where d.capability = 'all'
     or (d.capability = 'people' and v_people)
     or (d.capability = 'restricted' and v_restricted);

  -- The staff sheet lists persons: nobody without people scope gets it (viewers, brief §3).
  if v_people then
    select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
               'key', d.key,
               'header', case v_lang when 'ar' then d.ar when 'sw' then d.sw else d.en end,
               'kind', d.kind,
               'enum', d.enum_key))
             order by d.position), '[]'::jsonb)
      into v_staff
    from private.export_staff_column_defs d
    where d.capability = 'people'
       or (d.capability = 'restricted' and v_restricted);
  else
    v_staff := '[]'::jsonb;
  end if;

  select coalesce(jsonb_object_agg(e.enum_key, e.labels), '{}'::jsonb)
    into v_enums
  from (
    select l.enum_key,
           jsonb_object_agg(l.code, case v_lang when 'ar' then l.ar when 'sw' then l.sw else l.en end) as labels
    from private.enum_labels l
    group by l.enum_key
  ) e;

  return jsonb_build_object(
    'lang', v_lang,
    'dir', case when v_lang = 'ar' then 'rtl' else 'ltr' end,
    'list_separator', ' | ',
    'capabilities', jsonb_build_object('people', v_people, 'restricted', v_restricted,
                                       'staff', v_people),
    'columns', v_columns,
    'staff_columns', v_staff,
    'enums', v_enums);
end;
$$;

-- -----------------------------------------------------------------------------
-- export_request: filters.dataset = 'projects' (default) | 'staff'
-- -----------------------------------------------------------------------------
create or replace function public.export_request(
  p_format text,
  p_lang text default 'ar',
  p_filters jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_format text := lower(coalesce(btrim(p_format), ''));
  v_lang text := coalesce(nullif(btrim(p_lang), ''), 'ar');
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_dataset text;
  v_active integer;
  v_job public.export_jobs%rowtype;
begin
  perform private.require_session();   -- PT401 no user, PT403 session_revoked
  if v_format not in ('csv', 'xlsx') then
    raise exception 'unsupported export format: %', v_format using errcode = 'PT422';
  end if;
  if v_lang not in ('ar', 'sw', 'en') then
    raise exception 'unsupported language: %', v_lang using errcode = 'PT422';
  end if;
  if jsonb_typeof(v_filters) <> 'object' then
    raise exception 'filters must be a JSON object' using errcode = 'PT422';
  end if;
  if not private.read_all()
     and cardinality(private.read_countries()) = 0
     and cardinality(private.read_branches()) = 0 then
    raise exception 'no read access' using errcode = 'PT403';
  end if;

  if v_filters ? 'dataset' and jsonb_typeof(v_filters -> 'dataset') <> 'null' then
    v_dataset := v_filters ->> 'dataset';
    if jsonb_typeof(v_filters -> 'dataset') <> 'string' or v_dataset not in ('projects', 'staff') then
      raise exception 'unsupported dataset: %', v_filters -> 'dataset' using errcode = 'PT422';
    end if;
    if v_dataset = 'staff'
       and not (private.people_all()
                or cardinality(private.people_countries()) > 0
                or cardinality(private.people_branches()) > 0) then
      raise exception 'no access to staff data' using errcode = 'PT403';
    end if;
  end if;

  perform private.rate_limit('export_request', 20, interval '1 hour');

  select count(*) into v_active
  from public.export_jobs j
  where j.user_id = v_uid and j.deleted_at is null and j.state in ('queued', 'running')
    and j.created_at > now() - interval '1 day';
  if v_active >= 3 then
    raise exception 'too many exports in progress' using errcode = 'PT429';
  end if;

  insert into public.export_jobs (user_id, format, lang, filters, state)
  values (v_uid, v_format, v_lang, v_filters, 'queued')
  returning * into v_job;

  return to_jsonb(v_job) - 'deleted_at';
end;
$$;

-- -----------------------------------------------------------------------------
-- private.export_job_project_ids: the projects of a job, in id order
--
-- The caller's read scope, the job filters (projects_page keys + "ids") and owner decision ح
-- (viewer-only readers: approved projects only). p_people_only adds the people scope on the
-- project (project_staff_select). Keyset: ids after p_after (or from it, p_inclusive).
-- Returns at most p_limit + 1 ids so that the caller can tell whether more follow.
-- Runs as its owner from the SECURITY DEFINER export RPCs; the scope comes from the JWT.
-- -----------------------------------------------------------------------------
create or replace function private.export_job_project_ids(
  p_job public.export_jobs,
  p_after uuid,
  p_inclusive boolean,
  p_limit integer,
  p_people_only boolean default false
)
returns uuid[]
language plpgsql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  c_max_tokens constant integer := 6;
  v_uid uuid := auth.uid();
  f jsonb;
  v_limit integer := greatest(coalesce(p_limit, 1000), 1);
  v_all boolean := private.read_all();
  v_countries uuid[] := private.read_countries();
  v_branches uuid[] := private.read_branches();
  v_p_all boolean := private.people_all();
  v_p_countries uuid[] := private.people_countries();
  v_p_branches uuid[] := private.people_branches();
  v_people boolean;
  v_country uuid;
  v_branch uuid;
  v_area uuid;
  v_locality uuid;
  v_donor uuid;
  v_types text[];
  v_statuses text[];
  v_states text[];
  v_incomplete boolean;
  v_mine boolean;
  v_open_maint boolean;
  v_q text;
  v_ids_filter uuid[];
  v_area_ids uuid[];
  v_main text;
  v_p1 text;
  v_pats text[];
  v_where text;
  v_ids uuid[];
begin
  v_people := v_p_all or cardinality(v_p_countries) > 0 or cardinality(v_p_branches) > 0;
  if not v_all and cardinality(v_countries) = 0 and cardinality(v_branches) = 0 then
    return '{}'::uuid[];
  end if;
  if p_people_only and not v_people then
    return '{}'::uuid[];
  end if;

  f := case when jsonb_typeof(p_job.filters) = 'object' then p_job.filters else '{}'::jsonb end;

  v_country := nullif(f ->> 'country_id', '')::uuid;
  v_branch := nullif(f ->> 'branch_id', '')::uuid;
  v_area := nullif(f ->> 'admin_area_id', '')::uuid;
  v_locality := nullif(f ->> 'locality_id', '')::uuid;
  v_donor := nullif(f ->> 'donor_id', '')::uuid;
  v_types := private.jsonb_text_array(f -> 'type');
  v_statuses := private.jsonb_text_array(f -> 'status');
  v_states := private.jsonb_text_array(f -> 'record_state');
  v_incomplete := coalesce((f ->> 'incomplete')::boolean, false);
  v_mine := coalesce((f ->> 'created_by_me')::boolean, false);
  v_open_maint := coalesce((f ->> 'has_open_maintenance')::boolean, false);
  v_q := nullif(btrim(coalesce(private.norm(f ->> 'q'), '')), '');
  if jsonb_typeof(f -> 'ids') = 'array' then
    select array_agg(e.v::uuid) into v_ids_filter from jsonb_array_elements_text(f -> 'ids') e(v);
  end if;

  if v_area is not null then
    with recursive tree as (
      select a.id from public.admin_areas a where a.id = v_area
      union
      select c.id from public.admin_areas c join tree t on c.parent_id = t.id
      where c.deleted_at is null
    )
    select array_agg(t.id) into v_area_ids from tree t;
  end if;

  if v_q is not null then
    select array_agg('%' || private.like_escape(t.tok) || '%' order by t.ord),
           (array_agg(t.tok order by char_length(t.tok) desc, t.ord))[1]
      into v_pats, v_main
    from (
      select w.tok, w.ord
      from unnest(string_to_array(v_q, ' ')) with ordinality as w(tok, ord)
      where w.tok <> ''
      order by w.ord
      limit c_max_tokens
    ) t;
    v_p1 := '%' || private.like_escape(v_main) || '%';
  end if;

  -- WHERE assembled from fixed fragments (values are bound parameters only), exactly like
  -- projects_page, so the planner sees the smallest possible query.
  --   $1 countries  $2 branches  $3 country  $4 branch  $5 area ids  $6 types  $7 statuses
  --   $8 states  $9 like pattern  $10 like patterns  $11 uid  $12 donor  $13 locality
  --   $14 explicit ids  $15 after id  $16 limit  $17 people countries  $18 people branches
  v_where := 'p.deleted_at is null';
  if not v_all then
    v_where := v_where || ' and (p.country_id = any ($1) or p.branch_id = any ($2))';
  end if;
  if p_people_only then
    if not v_p_all then
      v_where := v_where || ' and (p.country_id = any ($17) or p.branch_id = any ($18))';
    end if;
  -- Unreviewed records (migration 0013, owner decision ح): where the caller reads as a viewer
  -- only, approved projects only. Nothing is added when his people scope covers his read scope.
  elsif not private.reads_unreviewed_everywhere(v_all, v_countries, v_branches,
                                                v_p_all, v_p_countries, v_p_branches) then
    v_where := v_where || case
      when not v_people then ' and p.record_state = ''approved'''
      else ' and (p.record_state = ''approved'' or p.country_id = any ($17) or p.branch_id = any ($18))' end;
  end if;
  if v_country is not null then v_where := v_where || ' and p.country_id = $3'; end if;
  if v_branch is not null then v_where := v_where || ' and p.branch_id = $4'; end if;
  if v_area is not null then v_where := v_where || ' and p.admin_area_id = any ($5)'; end if;
  if v_types is not null then v_where := v_where || ' and p.type = any ($6)'; end if;
  if v_statuses is not null then v_where := v_where || ' and p.status = any ($7)'; end if;
  if v_states is not null then v_where := v_where || ' and p.record_state = any ($8)'; end if;
  if v_q is not null then
    v_where := v_where || ' and p.search_norm like $9 and p.search_norm like all ($10)';
  end if;
  if v_incomplete then v_where := v_where || ' and coalesce(p.completeness, 0) < 100'; end if;
  if v_mine then v_where := v_where || ' and p.created_by = $11'; end if;
  if v_open_maint then
    v_where := v_where
      || ' and exists (select 1 from public.project_maintenance m'
      || ' where m.project_id = p.id and m.deleted_at is null'
      || ' and m.state in (''open'', ''in_progress''))';
  end if;
  if v_donor is not null then
    v_where := v_where
      || ' and exists (select 1 from public.project_donors pd'
      || ' where pd.donor_id = $12 and pd.project_id = p.id and pd.deleted_at is null)';
  end if;
  if v_locality is not null then v_where := v_where || ' and p.locality_id = $13'; end if;
  if v_ids_filter is not null then v_where := v_where || ' and p.id = any ($14)'; end if;
  if p_after is not null then
    v_where := v_where || case when coalesce(p_inclusive, false) then ' and p.id >= $15' else ' and p.id > $15' end;
  end if;

  execute 'select array_agg(s.id order by s.id) from (select p.id from public.projects p where '
          || v_where || ' order by p.id limit $16 + 1) s'
    into v_ids
    using v_countries, v_branches, v_country, v_branch, v_area_ids, v_types, v_statuses,
          v_states, v_p1, v_pats, v_uid, v_donor, v_locality, v_ids_filter, p_after, v_limit,
          v_p_countries, v_p_branches;

  return coalesce(v_ids, '{}'::uuid[]);
end;
$$;

revoke execute on function private.export_job_project_ids(public.export_jobs, uuid, boolean, integer, boolean)
  from public, anon, authenticated;

comment on function private.export_job_project_ids(public.export_jobs, uuid, boolean, integer, boolean) is
  'Ids (at most limit + 1, in id order) of the projects an export job covers for the calling user: read scope, job filters, owner decision ح; optionally only projects inside the people scope.';

-- -----------------------------------------------------------------------------
-- export_rows(p_job_id, p_after, p_limit): next keyset page of flat project rows
-- (selection through private.export_job_project_ids; + migration_note, reviewed_at,
-- reviewed_by, maintenance_closed)
-- -----------------------------------------------------------------------------
create or replace function public.export_rows(
  p_job_id uuid,
  p_after jsonb default null,
  p_limit integer default 1000
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  c_max_limit constant integer := 2000;
  v_uid uuid := auth.uid();
  v_job public.export_jobs%rowtype;
  v_lang text;
  v_limit integer := least(greatest(coalesce(p_limit, 1000), 1), c_max_limit);
  v_all boolean;
  v_countries uuid[];
  v_branches uuid[];
  v_p_all boolean;
  v_p_countries uuid[];
  v_p_branches uuid[];
  v_r_all boolean;
  v_r_countries uuid[];
  v_people boolean;
  v_restricted boolean;
  v_after_id uuid;
  v_ids uuid[];
  v_more boolean := false;
  v_rows jsonb;
  v_next jsonb;
  v_comp_ids uuid[];
  v_sens_ids uuid[];
begin
  -- A revoked session must fail the job (PT403), not page through an empty scope as "done".
  perform private.require_session();   -- PT401 no user, PT403 session_revoked

  select * into v_job
  from public.export_jobs j
  where j.id = p_job_id and j.deleted_at is null;
  if not found or v_job.user_id <> v_uid then
    raise exception 'export job not found' using errcode = 'PT404';
  end if;
  if v_job.state not in ('queued', 'running') then
    raise exception 'export job is %', v_job.state using errcode = 'PT409';
  end if;

  -- 100,000 projects are 100 pages of 1,000 rows; this only stops runaway loops.
  perform private.rate_limit('export_rows', 600, interval '1 minute');

  v_lang := v_job.lang;
  v_all := private.read_all();
  v_countries := private.read_countries();
  v_branches := private.read_branches();
  v_p_all := private.people_all();
  v_p_countries := private.people_countries();
  v_p_branches := private.people_branches();
  v_r_all := private.restricted_all();
  v_r_countries := private.restricted_countries();
  v_people := v_p_all or cardinality(v_p_countries) > 0 or cardinality(v_p_branches) > 0;
  v_restricted := v_r_all or cardinality(v_r_countries) > 0;

  if not v_all and cardinality(v_countries) = 0 and cardinality(v_branches) = 0 then
    return jsonb_build_object('job_id', p_job_id, 'rows', '[]'::jsonb, 'count', 0,
                              'next', null, 'done', true);
  end if;

  if jsonb_typeof(p_after) = 'object' then
    v_after_id := nullif(p_after ->> 'id', '')::uuid;
  end if;

  v_ids := private.export_job_project_ids(v_job, v_after_id, false, v_limit, false);
  if cardinality(v_ids) > v_limit then
    v_more := true;
    v_ids := v_ids[1:v_limit];
  end if;
  if v_more then
    v_next := jsonb_build_object('id', v_ids[v_limit]);
  end if;

  -- Flat rows -----------------------------------------------------------------------------------
  with fx as materialized (
    select distinct on (r.currency) r.currency::text as currency, r.usd_per_unit
    from public.fx_rates r
    where r.deleted_at is null and r.effective_date <= current_date
    order by r.currency, r.effective_date desc, r.created_at desc
  )
  select coalesce(jsonb_agg(x.j order by x.ord), '[]'::jsonb)
    into v_rows
  from (
    select
      u.ord,
      jsonb_build_object(
        'code', p.code,
        'name_ar', p.name_ar,
        'name_latin', p.name_latin,
        'type', p.type,
        'status', p.status,
        'record_state', p.record_state,
        'capacity', p.capacity,
        'country', case v_lang when 'ar' then coalesce(c.name_ar, c.name_en, c.name_sw)
                               when 'sw' then coalesce(c.name_sw, c.name_en, c.name_ar)
                               else coalesce(c.name_en, c.name_sw, c.name_ar) end,
        'country_iso2', c.iso2,
        'area_level1', ar.l1,
        'area_level2', ar.l2,
        'area_level3', ar.l3,
        'admin_area_code', a.code,
        'locality', case when v_lang = 'ar' then coalesce(l.name_ar, l.name_latin)
                         else coalesce(l.name_latin, l.name_ar) end,
        'branch', case v_lang when 'ar' then coalesce(b.name_ar, b.name_en, b.name_sw)
                              when 'sw' then coalesce(b.name_sw, b.name_en, b.name_ar)
                              else coalesce(b.name_en, b.name_sw, b.name_ar) end,
        'lat', st_y(p.geom),
        'lon', st_x(p.geom),
        'gps_accuracy_m', p.gps_accuracy_m,
        'location_source', p.location_source,
        'builder', p.builder,
        'build_year', p.build_year,
        'build_date', p.build_date,
        'completeness', p.completeness,
        'review_note', p.review_note,
        'migration_note', p.migration_note,
        'reviewed_at', p.reviewed_at)
      || jsonb_build_object(
        'land_ownership', pl.ownership,
        'land_area_m2', pl.area_m2,
        'land_utilization_pct', pl.utilization_pct,
        'land_expandable', pl.expandable,
        'land_notes', pl.notes,
        'teacher_housing', pf.teacher_housing,
        'imam_housing', pf.imam_housing,
        'guest_housing', pf.guest_housing,
        'library', pf.library,
        'quran_count', pf.quran_count,
        'quran_need', pf.quran_need,
        'hall', pf.hall,
        'hall_capacity', pf.hall_capacity,
        'student_transport', pf.student_transport,
        'students_origin', pf.students_origin)
      || jsonb_build_object(
        'community_branch_name', cp.branch_name,
        'population', cp.population,
        'muslim_pct', cp.muslim_pct,
        'daawa_activities', ol.daawa_activities,
        'social_features', ol.social_features,
        'livelihoods', ol.livelihoods,
        'religious_issues', ol.religious_issues,
        'religious_challenges', ol.religious_challenges,
        'social_challenges', ol.social_challenges,
        'proposed_activities', ol.proposed_activities)
      || jsonb_build_object(
        'donors', dn.txt,
        'maintenance_open', coalesce(mt.open_n, 0),
        'maintenance_total', coalesce(mt.total_n, 0),
        'maintenance_closed', coalesce(mt.closed_n, 0),
        'maintenance_last_reported', mt.last_reported,
        'maintenance_open_details', mt.open_details,
        'maintenance_open_cost', mc.txt,
        'photo_count', coalesce(phc.n, 0),
        'staff_count', coalesce(stc.n, 0),
        'external_id', p.external_id,
        'id', p.id,
        'created_at', p.created_at,
        'updated_at', p.updated_at)
      || case when v_people then jsonb_build_object(
           -- a private landowner is a person: people data whatever ownership says
           'land_owner_name', case when v_p_all or p.country_id = any (v_p_countries)
                                        or p.branch_id = any (v_p_branches)
                                   then pl.owner_name end,
           'manager_name', st.manager_name,
           'manager_phone', st.manager_phone,
           'staff_list', st.staff_list,
           'entered_by', st.entered_by,
           'reviewed_by', st.reviewed_by)
         else '{}'::jsonb end
      || case when v_restricted then jsonb_build_object(
           'monthly_payroll', pay.txt,
           'monthly_payroll_usd', pay.usd,
           'ibadi_families', cs.ibadi_families,
           'omani_families', cs.omani_families,
           'omani_student_pct', cs.omani_student_pct,
           'ibadi_student_pct', cs.ibadi_student_pct,
           'omani_teacher_pct', cs.omani_teacher_pct,
           'ibadi_teacher_pct', cs.ibadi_teacher_pct,
           'guest_financial_capacity', cs.guest_financial_capacity)
         else '{}'::jsonb end as j
    from unnest(v_ids) with ordinality as u(id, ord)
    join public.projects p on p.id = u.id
    left join public.countries c on c.id = p.country_id
    left join public.admin_areas a on a.id = p.admin_area_id
    left join public.admin_areas ap on ap.id = a.parent_id
    left join public.admin_areas ag on ag.id = ap.parent_id
    left join public.localities l on l.id = p.locality_id and l.deleted_at is null
    left join public.branches b on b.id = p.branch_id
    left join public.project_land pl on pl.project_id = p.id and pl.deleted_at is null
    left join public.project_facilities pf on pf.project_id = p.id and pf.deleted_at is null
    left join public.community_profiles cp on cp.project_id = p.id and cp.deleted_at is null
    left join lateral (
      select max(n.nm) filter (where n.level = 1) as l1,
             max(n.nm) filter (where n.level = 2) as l2,
             max(n.nm) filter (where n.level = 3) as l3
      from (
        select v.level,
               case v_lang when 'ar' then coalesce(v.name_ar, v.name_en, v.name_sw)
                           when 'sw' then coalesce(v.name_sw, v.name_en, v.name_ar)
                           else coalesce(v.name_en, v.name_sw, v.name_ar) end as nm
        from (values (a.level, a.name_ar, a.name_en, a.name_sw),
                     (ap.level, ap.name_ar, ap.name_en, ap.name_sw),
                     (ag.level, ag.name_ar, ag.name_en, ag.name_sw)) v(level, name_ar, name_en, name_sw)
      ) n
    ) ar on true
    left join lateral (
      select max(t.txt) filter (where t.k = 'daawa_activities') as daawa_activities,
             max(t.txt) filter (where t.k = 'social_features') as social_features,
             max(t.txt) filter (where t.k = 'livelihoods') as livelihoods,
             max(t.txt) filter (where t.k = 'religious_issues') as religious_issues,
             max(t.txt) filter (where t.k = 'religious_challenges') as religious_challenges,
             max(t.txt) filter (where t.k = 'social_challenges') as social_challenges,
             max(t.txt) filter (where t.k = 'proposed_activities') as proposed_activities
      from (
        select v.k,
               nullif(concat_ws(' | ',
                 (select string_agg(
                           case v_lang when 'ar' then coalesce(o.name_ar, o.name_en, o.name_sw)
                                       when 'sw' then coalesce(o.name_sw, o.name_en, o.name_ar)
                                       else coalesce(o.name_en, o.name_sw, o.name_ar) end,
                           ' | ' order by o.sort_order, o.code)
                  from public.option_values o
                  where o.id = any (v.ids)),
                 nullif(btrim(v.other), '')), '') as txt
        from (values
          ('daawa_activities', cp.daawa_activities, cp.daawa_activities_other),
          ('social_features', cp.social_features, cp.social_features_other),
          ('livelihoods', cp.livelihoods, cp.livelihoods_other),
          ('religious_issues', cp.religious_issues, cp.religious_issues_other),
          ('religious_challenges', cp.religious_challenges, cp.religious_challenges_other),
          ('social_challenges', cp.social_challenges, cp.social_challenges_other),
          ('proposed_activities', cp.proposed_activities, cp.proposed_activities_other)
        ) v(k, ids, other)
        where cp.id is not null
      ) t
    ) ol on true
    left join lateral (
      select string_agg(
               coalesce(case when v_lang = 'ar' then coalesce(d.name_ar, d.name_latin)
                             else coalesce(d.name_latin, d.name_ar) end, '?')
               || coalesce(' (' || nullif(concat_ws(', ',
                    pd.year::text,
                    case when pd.amount is not null
                         then trim_scale(pd.amount)::text || coalesce(' ' || pd.currency, '') end), '') || ')', ''),
               ' | ' order by pd.year nulls last, d.name_ar, d.id) as txt
      from public.project_donors pd
      join public.donors d on d.id = pd.donor_id and d.deleted_at is null
      where pd.project_id = p.id and pd.deleted_at is null
    ) dn on true
    left join lateral (
      select count(*) filter (where m.state in ('open', 'in_progress')) as open_n,
             count(*) filter (where m.state in ('done', 'cancelled')) as closed_n,
             count(*) as total_n,
             max(m.reported_on) as last_reported,
             string_agg('[' || coalesce(el.label, m.priority) || '] ' || m.description, ' | '
                        order by case m.priority when 'urgent' then 1 when 'high' then 2
                                   when 'medium' then 3 else 4 end, m.reported_on, m.id)
               filter (where m.state in ('open', 'in_progress')) as open_details
      from public.project_maintenance m
      left join lateral (
        select case v_lang when 'ar' then e.ar when 'sw' then e.sw else e.en end as label
        from private.enum_labels e
        where e.enum_key = 'maintenance_priority' and e.code = m.priority
      ) el on true
      where m.project_id = p.id and m.deleted_at is null
    ) mt on true
    left join lateral (
      select string_agg(y.currency || ' ' || trim_scale(y.amount)::text, ' | ' order by y.currency) as txt
      from (
        select coalesce(m.currency::text, '?') as currency, sum(m.estimated_cost) as amount
        from public.project_maintenance m
        where m.project_id = p.id and m.deleted_at is null
          and m.state in ('open', 'in_progress') and m.estimated_cost is not null
        group by 1
      ) y
    ) mc on true
    left join lateral (
      select count(*) as n
      from public.project_photos ph
      where ph.project_id = p.id and ph.deleted_at is null
    ) phc on true
    left join lateral (
      select count(*) as n
      from public.project_staff s
      where s.project_id = p.id and s.deleted_at is null
        and (s.end_date is null or s.end_date >= current_date)
    ) stc on true
    -- people columns: only for rows inside the caller's people scope, and person names / phones
    -- only for persons inside it too (persons keep their own scope when a project moves, sync.md
    -- §5.3; the persons_select rule). A person outside it is listed as "?" with the role and is
    -- never the manager_name / manager_phone.
    left join lateral (
      select
        string_agg(q.nm || ' (' || q.role_label || ')', ' | ' order by q.role_rank, q.nm, q.pid) as staff_list,
        (array_agg(q.nm order by q.nm, q.pid) filter (where q.role = 'manager' and q.vis))[1] as manager_name,
        (array_agg(q.phone order by q.nm, q.pid) filter (where q.role = 'manager' and q.vis))[1] as manager_phone,
        (select pr.full_name from public.profiles pr where pr.id = p.created_by) as entered_by,
        (select pr.full_name from public.profiles pr where pr.id = p.reviewed_by) as reviewed_by
      from (
        select s.role,
               pe.id as pid,
               pv.ok as vis,
               coalesce(case when not pv.ok then null
                             when v_lang = 'ar' then coalesce(pe.name_ar, pe.name_latin)
                             else coalesce(pe.name_latin, pe.name_ar) end, '?') as nm,
               case when pv.ok then pe.phone_e164 end as phone,
               coalesce(case v_lang when 'ar' then e.ar when 'sw' then e.sw else e.en end, s.role) as role_label,
               case s.role when 'manager' then 1 when 'imam' then 2 when 'teacher' then 3
                           when 'agent' then 4 when 'administrator' then 5 else 6 end as role_rank
        from public.project_staff s
        join public.persons pe on pe.id = s.person_id and pe.deleted_at is null
        cross join lateral (
          select coalesce(v_p_all or pe.country_id = any (v_p_countries)
                          or pe.branch_id = any (v_p_branches), false) as ok
        ) pv
        left join private.enum_labels e on e.enum_key = 'staff_role' and e.code = s.role
        where s.project_id = p.id and s.deleted_at is null
          and (s.end_date is null or s.end_date >= current_date)
      ) q
    ) st on v_people
        and (v_p_all or p.country_id = any (v_p_countries) or p.branch_id = any (v_p_branches))
    -- restricted columns: only for rows inside the caller's restricted scope
    left join lateral (
      select string_agg(y.currency || ' ' || trim_scale(y.amount)::text, ' | ' order by y.currency) as txt,
             case when bool_or(y.usd is null) then null else round(sum(y.usd), 2) end as usd
      from (
        select lc.currency,
               sum(lc.monthly_amount) as amount,
               sum(lc.monthly_amount)
                 * max(case when lc.currency = 'USD' then 1::numeric else fx.usd_per_unit end) as usd
        from public.project_staff s
        join lateral (
          select sc.monthly_amount, sc.currency::text as currency
          from public.staff_compensation sc
          where sc.project_staff_id = s.id and sc.deleted_at is null
            and sc.effective_from <= current_date
          order by sc.effective_from desc, sc.created_at desc, sc.id desc
          limit 1
        ) lc on true
        left join fx on fx.currency = lc.currency
        where s.project_id = p.id and s.deleted_at is null
          and (s.end_date is null or s.end_date >= current_date)
        group by lc.currency
      ) y
    ) pay on v_restricted and (v_r_all or p.country_id = any (v_r_countries))
    left join public.community_sensitive cs
      on cs.project_id = p.id and cs.deleted_at is null
     and v_restricted and (v_r_all or p.country_id = any (v_r_countries))
  ) x;

  -- Restricted reads are logged once per page and per table --------------------------------------
  if v_restricted and cardinality(v_ids) > 0 then
    select array_agg(lc.id)
      into v_comp_ids
    from unnest(v_ids) as u(id)
    join public.projects p on p.id = u.id and (v_r_all or p.country_id = any (v_r_countries))
    join public.project_staff s on s.project_id = p.id and s.deleted_at is null
      and (s.end_date is null or s.end_date >= current_date)
    join lateral (
      select sc.id
      from public.staff_compensation sc
      where sc.project_staff_id = s.id and sc.deleted_at is null
        and sc.effective_from <= current_date
      order by sc.effective_from desc, sc.created_at desc, sc.id desc
      limit 1
    ) lc on true;

    select array_agg(cs.id)
      into v_sens_ids
    from unnest(v_ids) as u(id)
    join public.projects p on p.id = u.id and (v_r_all or p.country_id = any (v_r_countries))
    join public.community_sensitive cs on cs.project_id = p.id and cs.deleted_at is null;

    if v_comp_ids is not null then
      perform private.log_restricted('staff_compensation', v_comp_ids, 'export:' || p_job_id::text);
    end if;
    if v_sens_ids is not null then
      perform private.log_restricted('community_sensitive', v_sens_ids, 'export:' || p_job_id::text);
    end if;
  end if;

  -- Progress: the job is running, and its cursor lets a worker resume after a crash.
  update public.export_jobs j
  set state = 'running',
      started_at = coalesce(j.started_at, now()),
      "cursor" = v_next
  where j.id = p_job_id;

  return jsonb_build_object(
    'job_id', p_job_id,
    'rows', v_rows,
    'count', cardinality(v_ids),
    'next', v_next,
    'done', not v_more);
end;
$$;

-- -----------------------------------------------------------------------------
-- export_staff_rows(p_job_id, p_after, p_limit): next keyset page of the staff sheet
--
-- One row per CURRENT assignment (project_staff live, end_date null or not past) of the
-- projects the job covers AND that lie in the caller's people scope (project_staff_select).
-- Person fields follow the PERSON's scope (persons_select): outside it the name is "?", the
-- other person fields are empty and the phone is masked (private.mask_phone, the rule of
-- person_candidates). Salary columns exist only for callers with restricted access and are
-- filled only for projects in the restricted scope (staff_compensation is reachable only
-- through logged functions: every page with salaries is written to restricted_access_log).
--
-- Keyset: (project_id, staff_id). "next" = {"project_id", "staff_id"}; staff_id null means
-- "after every assignment of that project". A page can hold fewer rows than p_limit (even
-- none) while done = false: projects without staff are skipped page by page.
-- -----------------------------------------------------------------------------
create or replace function public.export_staff_rows(
  p_job_id uuid,
  p_after jsonb default null,
  p_limit integer default 1000
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  c_max_limit constant integer := 2000;
  v_uid uuid := auth.uid();
  v_job public.export_jobs%rowtype;
  v_lang text;
  v_limit integer := least(greatest(coalesce(p_limit, 1000), 1), c_max_limit);
  v_p_all boolean;
  v_p_countries uuid[];
  v_p_branches uuid[];
  v_r_all boolean;
  v_r_countries uuid[];
  v_restricted boolean;
  v_after_pid uuid;
  v_after_sid uuid;
  v_pids uuid[];
  v_more_projects boolean := false;
  v_sids uuid[];
  v_last record;
  v_more boolean := false;
  v_next jsonb;
  v_rows jsonb;
  v_comp_ids uuid[];
begin
  perform private.require_session();   -- PT401 no user, PT403 session_revoked

  select * into v_job
  from public.export_jobs j
  where j.id = p_job_id and j.deleted_at is null;
  if not found or v_job.user_id <> v_uid then
    raise exception 'export job not found' using errcode = 'PT404';
  end if;
  if v_job.state not in ('queued', 'running') then
    raise exception 'export job is %', v_job.state using errcode = 'PT409';
  end if;

  perform private.rate_limit('export_staff_rows', 600, interval '1 minute');

  v_lang := v_job.lang;
  v_p_all := private.people_all();
  v_p_countries := private.people_countries();
  v_p_branches := private.people_branches();
  v_r_all := private.restricted_all();
  v_r_countries := private.restricted_countries();
  v_restricted := v_r_all or cardinality(v_r_countries) > 0;

  if not (v_p_all or cardinality(v_p_countries) > 0 or cardinality(v_p_branches) > 0) then
    return jsonb_build_object('job_id', p_job_id, 'rows', '[]'::jsonb, 'count', 0,
                              'next', null, 'done', true);
  end if;

  if jsonb_typeof(p_after) = 'object' then
    v_after_pid := nullif(p_after ->> 'project_id', '')::uuid;
    if v_after_pid is not null then
      v_after_sid := nullif(p_after ->> 'staff_id', '')::uuid;
    end if;
  end if;

  -- at most v_limit projects per page (a project can have any number of assignments)
  v_pids := private.export_job_project_ids(v_job, v_after_pid, v_after_sid is not null, v_limit, true);
  if cardinality(v_pids) > v_limit then
    v_more_projects := true;
    v_pids := v_pids[1:v_limit];
  end if;

  select array_agg(z.id order by z.project_id, z.id)
    into v_sids
  from (
    select s.id, s.project_id
    from public.project_staff s
    join public.persons pe on pe.id = s.person_id and pe.deleted_at is null
    where s.project_id = any (v_pids)
      and s.deleted_at is null
      and (s.end_date is null or s.end_date >= current_date)
      and (v_after_sid is null or (s.project_id, s.id) > (v_after_pid, v_after_sid))
    order by s.project_id, s.id
    limit v_limit + 1
  ) z;
  v_sids := coalesce(v_sids, '{}'::uuid[]);

  if cardinality(v_sids) > v_limit then
    v_more := true;
    v_sids := v_sids[1:v_limit];
    select s.project_id, s.id into v_last from public.project_staff s where s.id = v_sids[v_limit];
    v_next := jsonb_build_object('project_id', v_last.project_id, 'staff_id', v_last.id);
  elsif v_more_projects then
    v_more := true;
    v_next := jsonb_build_object('project_id', v_pids[v_limit], 'staff_id', null);
  end if;

  with fx as materialized (
    select distinct on (r.currency) r.currency::text as currency, r.usd_per_unit
    from public.fx_rates r
    where r.deleted_at is null and r.effective_date <= current_date
    order by r.currency, r.effective_date desc, r.created_at desc
  )
  select coalesce(jsonb_agg(x.j order by x.ord), '[]'::jsonb),
         array_agg(x.comp_id) filter (where x.comp_id is not null)
    into v_rows, v_comp_ids
  from (
    select
      u.ord,
      lc.id as comp_id,
      jsonb_build_object(
        'project_code', p.code,
        'project_name', case when v_lang = 'ar' then coalesce(p.name_ar, p.name_latin)
                             else coalesce(p.name_latin, p.name_ar) end,
        'country', case v_lang when 'ar' then coalesce(c.name_ar, c.name_en, c.name_sw)
                               when 'sw' then coalesce(c.name_sw, c.name_en, c.name_ar)
                               else coalesce(c.name_en, c.name_sw, c.name_ar) end,
        'branch', case v_lang when 'ar' then coalesce(b.name_ar, b.name_en, b.name_sw)
                              when 'sw' then coalesce(b.name_sw, b.name_en, b.name_ar)
                              else coalesce(b.name_en, b.name_sw, b.name_ar) end,
        'person_name_ar', case when pv.ok then pe.name_ar else '?' end,
        'person_name_latin', case when pv.ok then pe.name_latin end,
        'role', s.role,
        'start_date', s.start_date,
        'end_date', s.end_date,
        'gender', case when pv.ok then pe.gender end,
        'birth_year', case when pv.ok then pe.birth_year end,
        'birth_date', case when pv.ok then pe.birth_date end,
        'education_level', case when pv.ok then pe.education_level end,
        'graduated_from', case when pv.ok then pe.graduated_from end)
      || jsonb_build_object(
        'home_area_level1', case when pv.ok then ha.l1 end,
        'home_area_level2', case when pv.ok then ha.l2 end,
        'home_area_level3', case when pv.ok then ha.l3 end,
        'home_area_text', case when pv.ok then pe.home_area_text end,
        'phone', case when pe.phone_e164 is null then null
                      when pv.ok then pe.phone_e164
                      else private.mask_phone(pe.phone_e164) end,
        'person_id', case when pv.ok then pe.id end,
        'staff_id', s.id,
        'project_id', p.id)
      || case when v_restricted then jsonb_build_object(
           'salary_amount', lc.monthly_amount,
           'salary_currency', lc.currency,
           'salary_effective_from', lc.effective_from,
           'salary_usd', case when lc.id is null then null
                              when lc.currency = 'USD' then round(lc.monthly_amount, 2)
                              when fx.usd_per_unit is null then null
                              else round(lc.monthly_amount * fx.usd_per_unit, 2) end)
         else '{}'::jsonb end as j
    from unnest(v_sids) with ordinality as u(id, ord)
    join public.project_staff s on s.id = u.id
    join public.projects p on p.id = s.project_id
    join public.persons pe on pe.id = s.person_id
    left join public.countries c on c.id = p.country_id
    left join public.branches b on b.id = p.branch_id
    cross join lateral (
      select coalesce(v_p_all or pe.country_id = any (v_p_countries)
                      or pe.branch_id = any (v_p_branches), false) as ok
    ) pv
    left join public.admin_areas ha0 on ha0.id = pe.home_admin_area_id
    left join public.admin_areas ha1 on ha1.id = ha0.parent_id
    left join public.admin_areas ha2 on ha2.id = ha1.parent_id
    left join lateral (
      select max(n.nm) filter (where n.level = 1) as l1,
             max(n.nm) filter (where n.level = 2) as l2,
             max(n.nm) filter (where n.level = 3) as l3
      from (
        select v.level,
               case v_lang when 'ar' then coalesce(v.name_ar, v.name_en, v.name_sw)
                           when 'sw' then coalesce(v.name_sw, v.name_en, v.name_ar)
                           else coalesce(v.name_en, v.name_sw, v.name_ar) end as nm
        from (values (ha0.level, ha0.name_ar, ha0.name_en, ha0.name_sw),
                     (ha1.level, ha1.name_ar, ha1.name_en, ha1.name_sw),
                     (ha2.level, ha2.name_ar, ha2.name_en, ha2.name_sw)) v(level, name_ar, name_en, name_sw)
      ) n
    ) ha on true
    left join lateral (
      select sc.id, sc.monthly_amount, sc.currency::text as currency, sc.effective_from
      from public.staff_compensation sc
      where sc.project_staff_id = s.id and sc.deleted_at is null
        and sc.effective_from <= current_date
      order by sc.effective_from desc, sc.created_at desc, sc.id desc
      limit 1
    ) lc on v_restricted and (v_r_all or p.country_id = any (v_r_countries))
    left join fx on fx.currency = lc.currency
  ) x;

  if v_comp_ids is not null then
    perform private.log_restricted('staff_compensation', v_comp_ids, 'export:' || p_job_id::text);
  end if;

  update public.export_jobs j
  set state = 'running',
      started_at = coalesce(j.started_at, now())
  where j.id = p_job_id and j.state = 'queued';

  return jsonb_build_object(
    'job_id', p_job_id,
    'rows', v_rows,
    'count', cardinality(v_sids),
    'next', v_next,
    'done', not v_more);
end;
$$;

revoke execute on function public.export_staff_rows(uuid, jsonb, integer) from public, anon;
grant execute on function public.export_staff_rows(uuid, jsonb, integer) to authenticated;

comment on function public.export_staff_rows(uuid, jsonb, integer) is
  'Next keyset page of the staff sheet of the caller''s own export job: one row per current assignment in the caller''s people scope; person fields per persons_select (phone masked outside it); salary only with restricted access, logged.';
comment on function public.export_columns(text) is
  'Ordered export columns (projects sheet: "columns"; staff sheet: "staff_columns", people scope only) with localised headers plus localised labels of enumerated values; people / restricted columns are listed only for callers who may see them.';
comment on function public.export_request(text, text, jsonb) is
  'Creates an export job (queued) for the caller. Filters use the projects_page keys plus "ids" and "dataset" (projects | staff).';

-- -----------------------------------------------------------------------------
select private.harden_private_schema();

create or replace function private.schema_version()
returns text
language sql
immutable
parallel safe
set search_path = public, extensions, private, pg_temp
as $$
  select '20261003007300'::text;
$$;

revoke execute on function private.schema_version() from public, anon, authenticated;

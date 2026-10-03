-- =============================================================================
-- 0041  person_candidates — "possible matching persons" (brief §2.4)
--
-- Automatic merging by name is forbidden. This function only LISTS possible
-- matches so that the user can choose "same person" or "new person":
--   * exact phone match (E.164), or
--   * trigram similarity >= 0.6 between the typed name and a stored name,
--   * same-area matches ranked first.
-- It never writes to persons, project_staff or person_merge_requests.
--
-- Name matching. persons.name_normalized holds BOTH scripts
-- (norm(name_ar || ' ' || name_latin)), so comparing a typed Arabic name with
-- it under-scores every person who also has a Latin name (0.47 instead of 1.0
-- for an identical name). The typed name is therefore compared with each
-- script separately, through the lookup table private.person_names:
--
--   one row per person and script: name_norm = private.norm(name_ar | name_latin),
--   n_trgm (number of distinct trigrams) and the person's scope columns,
--   maintained by a trigger on persons, GIN trigram index on name_norm.
--
-- Why a table and not expression indexes on persons: the index recheck and the
-- ranking would call private.norm() for every candidate row (measured on
-- 500,000 persons: 2-8 s per lookup). With stored values the same lookups take
-- 0.1-0.4 s on the development machine. Two exact pre-filters keep the number
-- of similarity computations small:
--   * similarity(a, b) >= t implies t*|A| <= |B| <= |A|/t for the trigram
--     counts, so only names inside that window are rechecked;
--   * the caller's branches/countries are ANDed in the index (BitmapAnd).
--
-- JSON shape: docs/contracts/people-admin.md
-- =============================================================================

-- -----------------------------------------------------------------------------
-- private.person_names — normalised name per person and script
-- -----------------------------------------------------------------------------
create table if not exists private.person_names (
  person_id  uuid     not null references public.persons (id) on delete cascade,
  script     text     not null,
  name_norm  text     not null,
  n_trgm     smallint not null,
  country_id uuid,
  branch_id  uuid,
  constraint person_names_pkey primary key (person_id, script),
  constraint person_names_script_ck check (script in ('ar', 'latin')),
  constraint person_names_norm_ck check (name_norm <> '')
);

create index if not exists person_names_trgm
  on private.person_names using gin (name_norm extensions.gin_trgm_ops);
create index if not exists person_names_exact_idx
  on private.person_names (name_norm);
create index if not exists person_names_n_trgm_idx
  on private.person_names (n_trgm);
create index if not exists person_names_branch_idx
  on private.person_names (branch_id);
create index if not exists person_names_country_idx
  on private.person_names (country_id);

alter table private.person_names enable row level security;
alter table private.person_names force row level security;
revoke all on table private.person_names from public, anon, authenticated;

comment on table private.person_names is
  'private.norm(name_ar) / private.norm(name_latin) of every person, one row per script, with trigram count and scope. Lookup table of person_candidates(); maintained by the t85_person_names_* triggers on persons.';

create or replace function private.tg_person_names()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_ar text := nullif(private.norm(new.name_ar), '');
  v_la text := nullif(private.norm(new.name_latin), '');
begin
  if v_ar is not null then
    insert into private.person_names as n (person_id, script, name_norm, n_trgm, country_id, branch_id)
    values (new.id, 'ar', v_ar, cardinality(show_trgm(v_ar)), new.country_id, new.branch_id)
    on conflict (person_id, script) do update
      set name_norm = excluded.name_norm,
          n_trgm = excluded.n_trgm,
          country_id = excluded.country_id,
          branch_id = excluded.branch_id;
  elsif tg_op = 'UPDATE' then
    delete from private.person_names n where n.person_id = new.id and n.script = 'ar';
  end if;

  if v_la is not null then
    insert into private.person_names as n (person_id, script, name_norm, n_trgm, country_id, branch_id)
    values (new.id, 'latin', v_la, cardinality(show_trgm(v_la)), new.country_id, new.branch_id)
    on conflict (person_id, script) do update
      set name_norm = excluded.name_norm,
          n_trgm = excluded.n_trgm,
          country_id = excluded.country_id,
          branch_id = excluded.branch_id;
  elsif tg_op = 'UPDATE' then
    delete from private.person_names n where n.person_id = new.id and n.script = 'latin';
  end if;

  return null;
end;
$$;

comment on function private.tg_person_names() is
  'AFTER INSERT/UPDATE trigger on persons: keeps private.person_names in step with name_ar, name_latin, country_id and branch_id.';

drop trigger if exists t85_person_names_ins on public.persons;
create trigger t85_person_names_ins
  after insert on public.persons
  for each row execute function private.tg_person_names();

drop trigger if exists t85_person_names_upd on public.persons;
create trigger t85_person_names_upd
  after update of name_ar, name_latin, country_id, branch_id on public.persons
  for each row
  when (old.name_ar is distinct from new.name_ar
        or old.name_latin is distinct from new.name_latin
        or old.country_id is distinct from new.country_id
        or old.branch_id is distinct from new.branch_id)
  execute function private.tg_person_names();

-- Full rebuild: for bulk loaders that disable triggers, and for repairs.
create or replace function private.person_names_rebuild()
returns bigint
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_rows bigint;
begin
  truncate private.person_names;
  insert into private.person_names (person_id, script, name_norm, n_trgm, country_id, branch_id)
  select x.id, x.script, x.name_norm, cardinality(show_trgm(x.name_norm)), x.country_id, x.branch_id
  from (
    select p.id, 'ar'::text as script, private.norm(p.name_ar) as name_norm, p.country_id, p.branch_id
    from public.persons p
    union all
    select p.id, 'latin', private.norm(p.name_latin), p.country_id, p.branch_id
    from public.persons p
  ) x
  where x.name_norm is not null and x.name_norm <> '';
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

comment on function private.person_names_rebuild() is
  'Rebuilds private.person_names from persons; returns the number of rows written. Run it after a bulk load that bypassed the triggers.';

-- Persons that already exist when this migration is applied.
insert into private.person_names (person_id, script, name_norm, n_trgm, country_id, branch_id)
select x.id, x.script, x.name_norm, cardinality(extensions.show_trgm(x.name_norm)), x.country_id, x.branch_id
from (
  select p.id, 'ar'::text as script, private.norm(p.name_ar) as name_norm, p.country_id, p.branch_id
  from public.persons p
  union all
  select p.id, 'latin', private.norm(p.name_latin), p.country_id, p.branch_id
  from public.persons p
) x
where x.name_norm is not null and x.name_norm <> ''
on conflict (person_id, script) do nothing;

revoke execute on function private.tg_person_names() from public, anon, authenticated;
revoke execute on function private.person_names_rebuild() from public, anon, authenticated;
grant  execute on function private.person_names_rebuild() to service_role;

-- -----------------------------------------------------------------------------
-- public.person_candidates
-- -----------------------------------------------------------------------------
create or replace function public.person_candidates(p_name text, p_phone text, p_admin_area_id uuid)
returns jsonb
language plpgsql
volatile            -- because of private.rate_limit(); the function itself only reads
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  c_default_threshold constant numeric := 0.6;   -- brief §2.4
  c_name_pool constant integer := 40;   -- best name matches considered before ranking
  c_limit     constant integer := 12;   -- candidates returned

  v_all            boolean;
  v_countries      uuid[];
  v_branches       uuid[];
  v_read_all       boolean;
  v_read_countries uuid[];
  v_read_branches  uuid[];

  v_norm     text;
  v_raw      text;
  v_digits   text;
  v_phones   text[];
  v_name_ids uuid[] := '{}'::uuid[];
  v_chain    uuid[] := '{}'::uuid[];
  v_n        integer;
  v_prev     text;
  v_threshold numeric;
  v_result   jsonb;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = 'PT401';
  end if;

  -- Threshold: 0.6 unless hq_admin changed app_settings "persons.name_similarity"
  -- (kept between 0.4 and 1: lower values make every common name match).
  select (s.value #>> '{}')::numeric
  into v_threshold
  from public.app_settings s
  where s.key = 'persons.name_similarity'
    and s.deleted_at is null
    and jsonb_typeof(s.value) = 'number';
  v_threshold := least(greatest(coalesce(v_threshold, c_default_threshold), 0.4), 1.0);

  -- Authorisation: any role that may see people (everything except viewer).
  -- The scope is evaluated once and reused as plain arrays in the queries.
  v_all       := coalesce(private.people_all(), false);
  v_countries := coalesce(private.people_countries(), '{}'::uuid[]);
  v_branches  := coalesce(private.people_branches(), '{}'::uuid[]);
  if not v_all and cardinality(v_countries) = 0 and cardinality(v_branches) = 0 then
    raise exception 'forbidden' using errcode = 'PT403',
      detail = 'Looking up persons requires a role that may see people.';
  end if;

  perform private.rate_limit('person_candidates', 300, interval '1 minute');

  -- Projects a candidate works in are listed only when the caller may read them.
  v_read_all       := coalesce(private.read_all(), false);
  v_read_countries := coalesce(private.read_countries(), '{}'::uuid[]);
  v_read_branches  := coalesce(private.read_branches(), '{}'::uuid[]);

  -- Name: same normalisation as the stored values. One character is not a name.
  v_norm := nullif(private.norm(p_name), '');
  if v_norm is not null and char_length(v_norm) < 2 then
    v_norm := null;
  end if;

  -- Phone: keep digits, accept "00" as the international prefix; compare as E.164.
  v_raw := regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g');
  if v_raw like '00%' then
    v_raw := '+' || substr(v_raw, 3);
  end if;
  v_digits := regexp_replace(v_raw, '[^0-9]', '', 'g');
  if char_length(v_digits) between 7 and 15 then
    v_phones := array['+' || v_digits];
  end if;

  if v_norm is null and v_phones is null then
    return '[]'::jsonb;
  end if;

  -- The requested area with its ancestors (levels 1..3 => at most two parents).
  if p_admin_area_id is not null then
    select array_remove(array[a.id, a.parent_id, pa.parent_id], null)
    into v_chain
    from public.admin_areas a
    left join public.admin_areas pa on pa.id = a.parent_id
    where a.id = p_admin_area_id;
    v_chain := coalesce(v_chain, '{}'::uuid[]);
  end if;

  -- Name matches: the best c_name_pool persons inside the caller's scope.
  if v_norm is not null then
    if position(' ' in v_norm) > 0 then
      -- Two or more words: trigram similarity >= 0.6 through the GIN index.
      -- `%` compares against pg_trgm.similarity_threshold: set it for this
      -- statement only and put the previous value back afterwards (show_trgm
      -- has loaded pg_trgm by then, so the parameter exists).
      v_n := cardinality(show_trgm(v_norm));
      v_prev := current_setting('pg_trgm.similarity_threshold', true);
      perform set_config('pg_trgm.similarity_threshold', v_threshold::text, true);

      -- Dynamic SQL on purpose: the statement is planned for the actual
      -- values (trigram window, scope arrays), which decides whether the
      -- window / scope indexes are combined with the trigram index. The text
      -- is constant; every value is a bind parameter. When the pool is
      -- smaller than the number of matches, same-area persons are kept first.
      execute
        'select coalesce(array_agg(x.person_id), ''{}''::uuid[])
         from (
           select n.person_id
           from private.person_names n
           join public.persons p on p.id = n.person_id
           where n.name_norm % $1
             and n.n_trgm between $2 and $3 '
        || case when v_all then ''
                else ' and (n.country_id = any ($4) or n.branch_id = any ($5)) ' end
        || '  and p.deleted_at is null
             and p.merged_into_id is null
           group by n.person_id, p.home_admin_area_id
           order by coalesce(p.home_admin_area_id = any ($6), false) desc,
                    max(similarity(n.name_norm, $1)) desc,
                    n.person_id
           limit $7
         ) x'
      into v_name_ids
      using v_norm,
            ceil(v_threshold * v_n)::integer,
            floor(v_n / v_threshold)::integer,
            v_countries, v_branches, v_chain, c_name_pool;

      perform set_config('pg_trgm.similarity_threshold', coalesce(nullif(v_prev, ''), '0.3'), true);
    else
      -- A single word shares its trigrams with every longer name that contains
      -- it (tens of thousands of rows for a common first name) while none of
      -- those can reach 0.6. Only a person whose whole name is that word can
      -- match, so look it up by equality.
      select coalesce(array_agg(x.person_id), '{}'::uuid[])
      into v_name_ids
      from (
        select distinct n.person_id
        from private.person_names n
        join public.persons p on p.id = n.person_id
        where n.name_norm = v_norm
          and p.deleted_at is null
          and p.merged_into_id is null
          and (v_all or p.country_id = any (v_countries) or p.branch_id = any (v_branches))
        order by n.person_id
        limit c_name_pool
      ) x;
    end if;
  end if;

  with ids as (
    select h.id, bool_or(h.by_phone) as by_phone
    from (
      select p.id, true as by_phone
      from public.persons p
      where v_phones is not null
        and p.phone_e164 = any (v_phones)
        and p.deleted_at is null
        and p.merged_into_id is null
        and (v_all or p.country_id = any (v_countries) or p.branch_id = any (v_branches))
      union all
      select u.id, false
      from unnest(v_name_ids) as u (id)
    ) h
    group by h.id
  ),
  cand as (
    select
      p.id,
      p.name_ar,
      p.name_latin,
      p.phone_e164,
      p.gender,
      p.birth_year,
      p.home_admin_area_id,
      p.home_area_text,
      p.country_id,
      p.branch_id,
      i.by_phone,
      case when v_norm is not null then
        (select max(similarity(n.name_norm, v_norm)) from private.person_names n where n.person_id = p.id)
      end as sim,
      ha.name_ar as home_name_ar,
      ha.name_en as home_name_en,
      ha.name_sw as home_name_sw,
      coalesce(
        p_admin_area_id is not null
        and p.home_admin_area_id is not null
        and (
          p.home_admin_area_id = any (v_chain)       -- the requested area or one of its ancestors
          or p_admin_area_id = ha.parent_id          -- home lies inside the requested area
          or p_admin_area_id = hp.parent_id
        ), false) as home_in_area,
      coalesce(st.works_in_area, false) as works_in_area,
      coalesce(st.staff, '[]'::jsonb) as staff,
      coalesce(st.roles, '[]'::jsonb) as roles,
      coalesce(st.hidden_projects, 0) as hidden_projects
    from ids i
    join public.persons p on p.id = i.id
    left join public.admin_areas ha on ha.id = p.home_admin_area_id
    left join public.admin_areas hp on hp.id = ha.parent_id
    left join lateral (
      select
        jsonb_agg(
          jsonb_build_object(
            'project_staff_id', s.id,
            'project_id', s.project_id,
            'project_code', s.code,
            'project_name_ar', s.name_ar,
            'project_name_latin', s.name_latin,
            'project_type', s.type,
            'role', s.role,
            'start_date', s.start_date,
            'end_date', s.end_date)
          order by s.end_date desc nulls first, s.start_date desc nulls last, s.id
        ) filter (where s.visible) as staff,
        to_jsonb(array_agg(distinct s.role) filter (where s.visible)) as roles,
        count(*) filter (where not s.visible) as hidden_projects,
        bool_or(s.visible and p_admin_area_id is not null and s.admin_area_id = p_admin_area_id) as works_in_area
      from (
        select
          ps.id, ps.role, ps.start_date, ps.end_date,
          pr.id as project_id, pr.code, pr.name_ar, pr.name_latin, pr.type, pr.admin_area_id,
          coalesce(v_read_all
                   or pr.country_id = any (v_read_countries)
                   or pr.branch_id = any (v_read_branches), false) as visible
        from public.project_staff ps
        join public.projects pr on pr.id = ps.project_id
        where ps.person_id = p.id
          and ps.deleted_at is null
          and pr.deleted_at is null
      ) s
    ) st on true
  ),
  top as (
    select c.*,
           (c.home_in_area or c.works_in_area) as same_area,
           coalesce(c.sim >= v_threshold, false) as by_name,
           coalesce(v_all or c.country_id = any (v_countries) or c.branch_id = any (v_branches), false) as may_see_phone
    from cand c
    order by c.by_phone desc, (c.home_in_area or c.works_in_area) desc, c.sim desc nulls last, c.name_ar, c.id
    limit c_limit
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', t.id,
        'name_ar', t.name_ar,
        'name_latin', t.name_latin,
        'phone', case when t.phone_e164 is null then null
                      when t.may_see_phone then t.phone_e164
                      else private.mask_phone(t.phone_e164) end,
        'phone_masked', (t.phone_e164 is not null and not t.may_see_phone),
        'gender', t.gender,
        'birth_year', t.birth_year,
        'home_area', case when t.home_admin_area_id is null and t.home_area_text is null then null
                          else jsonb_build_object(
                            'id', t.home_admin_area_id,
                            'name_ar', t.home_name_ar,
                            'name_en', t.home_name_en,
                            'name_sw', t.home_name_sw,
                            'text', t.home_area_text) end,
        'roles', t.roles,
        'staff', t.staff,
        'hidden_projects', t.hidden_projects,
        'similarity', round(t.sim::numeric, 3),
        'same_area', t.same_area,
        'reasons', to_jsonb(array_remove(array[
                     case when t.by_phone then 'phone' end,
                     case when t.by_name then 'name' end,
                     case when t.same_area then 'area' end], null))
      )
      order by t.by_phone desc, t.same_area desc, t.sim desc nulls last, t.name_ar, t.id
    ),
    '[]'::jsonb)
  into v_result
  from top t;

  return v_result;
end;
$$;

comment on function public.person_candidates(text, text, uuid) is
  'Possible duplicates of a person inside the caller''s people scope: exact phone or trigram similarity >= 0.6 on the normalised name, same-area first. Read-only: never merges.';

revoke execute on function public.person_candidates(text, text, uuid) from public, anon;
grant  execute on function public.person_candidates(text, text, uuid) to authenticated, service_role;

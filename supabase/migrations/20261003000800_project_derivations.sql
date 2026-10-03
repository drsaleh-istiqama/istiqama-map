-- =============================================================================
-- 0008  Derived data of public.projects
--
--   country_id / admin_area_id from geom   (ST_Contains, deepest level; decision D5)
--   code                                   <ISO2>-<level-1 short_code|XX>-<counter>
--   search_norm                            names + code + locality names, normalised
--   completeness                           0..100, also refreshed when a child row changes
--   reviewed_by / reviewed_at              stamped when the record is approved or returned
--   build_year                             from build_date when missing
--
-- Formula and rules for other teams: docs/contracts/schema.md
-- =============================================================================

-- -----------------------------------------------------------------------------
-- private.next_project_code — concurrency-safe: the upsert locks the counter
-- row of the country until the transaction ends, so two transactions can never
-- obtain the same number (they queue behind each other per country).
-- -----------------------------------------------------------------------------
create or replace function private.next_project_code(p_country_id uuid, p_admin_area_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
set enable_seqscan = off
as $$
declare
  v_iso2  text;
  v_short text;
  v_id    uuid := p_admin_area_id;
  v_area  record;
  v_n     bigint;
  v_code  text;
begin
  select c.iso2::text into v_iso2 from public.countries c where c.id = p_country_id;
  if v_iso2 is null then
    return null;
  end if;

  -- Level-1 ancestor of the admin area (at most three steps up).
  for i in 1 .. 3 loop
    exit when v_id is null;
    select a.level, a.short_code, a.parent_id into v_area
      from public.admin_areas a
     where a.id = v_id;
    exit when not found;
    if v_area.level = 1 then
      v_short := v_area.short_code;
      exit;
    end if;
    v_id := v_area.parent_id;
  end loop;

  loop
    insert into private.project_code_counters as c (country_id, last_value)
    values (p_country_id, 1)
    on conflict (country_id) do update
      set last_value = c.last_value + 1,
          updated_at = now()
    returning c.last_value into v_n;

    v_code := v_iso2 || '-' || coalesce(nullif(btrim(v_short), ''), 'XX') || '-'
              || lpad(v_n::text, greatest(6, length(v_n::text)), '0');

    -- Skip numbers already taken by codes that were supplied explicitly.
    exit when not exists (select 1 from public.projects p where p.code = v_code);
  end loop;

  return v_code;
end;
$$;

-- SECURITY DEFINER and not a trigger function: only the owner (i.e. the
-- projects trigger) may call it, nobody can burn numbers through it.
revoke execute on function private.next_project_code(uuid, uuid) from public, anon, authenticated, service_role;

comment on function private.next_project_code(uuid, uuid) is
  'Next readable project code of a country, e.g. TZ-PN-000123 (XX when the level-1 area has no short_code). NULL for an unknown country.';

-- -----------------------------------------------------------------------------
-- private.project_completeness — the single place that knows the weights.
--
--   name_ar present            10      at least one live photo        15
--   name_latin present          5      live project_land row          10
--   geom present               15      live project_facilities row    10
--   admin_area_id present       5      at least one live staff row    10
--   capacity > 0                5      live community_profiles row    10
--   build_year present          5                              total 100
--
-- "live" = deleted_at is null. Restricted tables are deliberately not part of
-- the score, so a field device can reproduce it from its local stores.
-- -----------------------------------------------------------------------------
create or replace function private.project_completeness(p public.projects, p_skip_children boolean default false)
returns smallint
language plpgsql
stable
set search_path = public, extensions, private, pg_temp
set enable_seqscan = off
as $$
declare
  v integer := 0;
begin
  if nullif(btrim(p.name_ar), '') is not null then v := v + 10; end if;
  if nullif(btrim(p.name_latin), '') is not null then v := v + 5; end if;
  if p.geom is not null then v := v + 15; end if;
  if p.admin_area_id is not null then v := v + 5; end if;
  if coalesce(p.capacity, 0) > 0 then v := v + 5; end if;
  if p.build_year is not null then v := v + 5; end if;

  if not coalesce(p_skip_children, false) then
    if exists (select 1 from public.project_photos x where x.project_id = p.id and x.deleted_at is null) then
      v := v + 15;
    end if;
    if exists (select 1 from public.project_land x where x.project_id = p.id and x.deleted_at is null) then
      v := v + 10;
    end if;
    if exists (select 1 from public.project_facilities x where x.project_id = p.id and x.deleted_at is null) then
      v := v + 10;
    end if;
    if exists (select 1 from public.project_staff x where x.project_id = p.id and x.deleted_at is null) then
      v := v + 10;
    end if;
    if exists (select 1 from public.community_profiles x where x.project_id = p.id and x.deleted_at is null) then
      v := v + 10;
    end if;
  end if;

  return v::smallint;
end;
$$;

comment on function private.project_completeness(public.projects, boolean) is
  'Completeness score 0..100 of a project row (weights documented in docs/contracts/schema.md).';

-- -----------------------------------------------------------------------------
-- projects BEFORE INSERT/UPDATE
-- -----------------------------------------------------------------------------
create or replace function private.tg_projects_biu()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, private, pg_temp
set enable_seqscan = off
as $$
declare
  v_area      record;
  v_country   uuid;
  v_loc_ar    text;
  v_loc_latin text;
  v_resolved  boolean := false;
begin
  -- 1. Country and admin area from the point. The deepest boundary containing
  --    the point wins; the client's values survive only when nothing contains it.
  if new.geom is not null
     and (tg_op = 'INSERT'
          or new.geom is distinct from old.geom
          or new.admin_area_id is distinct from old.admin_area_id
          or new.country_id is distinct from old.country_id) then
    -- Same query as private.deepest_admin_area(), inlined so that its plan is cached.
    select a.id, a.country_id into v_area
      from public.admin_areas a
     where a.deleted_at is null
       and a.geom && new.geom
       and st_contains(a.geom, new.geom)
     order by a.level desc, a.id
     limit 1;
    if found then
      new.admin_area_id := v_area.id;
      new.country_id := v_area.country_id;
      v_resolved := true;
    end if;
  end if;

  --    A manually chosen admin area decides the country.
  if not v_resolved
     and new.admin_area_id is not null
     and (tg_op = 'INSERT'
          or new.country_id is null
          or new.admin_area_id is distinct from old.admin_area_id
          or new.country_id is distinct from old.country_id) then
    select a.country_id into v_country from public.admin_areas a where a.id = new.admin_area_id;
    if v_country is not null then
      new.country_id := v_country;
    end if;
  end if;

  -- 2. Year from the optional full date.
  if new.build_date is not null
     and (new.build_year is null
          or (tg_op = 'UPDATE' and new.build_date is distinct from old.build_date)) then
    new.build_year := extract(year from new.build_date)::smallint;
  end if;

  -- 3. Review stamp.
  if new.record_state in ('approved', 'returned')
     and (tg_op = 'INSERT' or new.record_state is distinct from old.record_state) then
    new.reviewed_at := now();
    new.reviewed_by := coalesce(auth.uid(), new.reviewed_by);
  end if;

  -- 4. Readable code: generated once, immutable afterwards. End users can never
  --    choose a code; server-side code without a JWT user may supply one on insert.
  if tg_op = 'UPDATE' and old.code is not null then
    new.code := old.code;
  else
    if auth.uid() is not null then
      new.code := null;
    end if;
    if new.code is null and new.country_id is not null then
      new.code := private.next_project_code(new.country_id, new.admin_area_id);
    end if;
  end if;

  -- 5. Search text (always on insert; on update only when an input changed or
  --    somebody tried to write the column).
  if tg_op = 'INSERT'
     or new.name_ar is distinct from old.name_ar
     or new.name_latin is distinct from old.name_latin
     or new.code is distinct from old.code
     or new.locality_id is distinct from old.locality_id
     or new.search_norm is distinct from old.search_norm then
    if new.locality_id is not null then
      select l.name_ar, l.name_latin into v_loc_ar, v_loc_latin
        from public.localities l
       where l.id = new.locality_id;
    end if;
    new.search_norm := coalesce(
      private.norm(concat_ws(' ', new.name_ar, new.name_latin, new.code, v_loc_ar, v_loc_latin)),
      '');
  end if;

  -- 6. Completeness (a new row cannot have children yet).
  new.completeness := private.project_completeness(new, tg_op = 'INSERT');

  return new;
end;
$$;

create trigger t20_derive before insert or update on public.projects
  for each row execute function private.tg_projects_biu();

-- -----------------------------------------------------------------------------
-- A renamed locality refreshes the search text of its projects.
-- -----------------------------------------------------------------------------
create or replace function private.tg_localities_au_projects()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, private, pg_temp
set enable_seqscan = off
as $$
begin
  -- Any change of search_norm makes private.tg_projects_biu() recompute it.
  update public.projects p
     set search_norm = ''
   where p.locality_id = new.id;
  return null;
end;
$$;

create trigger t80_projects_search after update on public.localities
  for each row
  when (old.name_ar is distinct from new.name_ar or old.name_latin is distinct from new.name_latin)
  execute function private.tg_localities_au_projects();

-- -----------------------------------------------------------------------------
-- Children -> parent completeness. Statement-level triggers with transition
-- tables: one UPDATE of the affected projects per statement, and only for
-- projects whose score really changes (so a second photo does not touch the
-- project row at all).
-- -----------------------------------------------------------------------------
create or replace function private.tg_child_completeness()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, private, pg_temp
set enable_seqscan = off
as $$
declare
  v_ids uuid[];
begin
  if tg_op = 'INSERT' then
    select array_agg(distinct n.project_id) into v_ids
      from new_rows n
     where n.deleted_at is null;
  elsif tg_op = 'UPDATE' then
    select array_agg(distinct x.project_id) into v_ids
      from (
        select n.project_id
          from new_rows n
          join old_rows o on o.id = n.id
         where (n.deleted_at is null) <> (o.deleted_at is null)
            or n.project_id <> o.project_id
        union all
        select o.project_id
          from new_rows n
          join old_rows o on o.id = n.id
         where n.project_id <> o.project_id
      ) x;
  else
    select array_agg(distinct o.project_id) into v_ids
      from old_rows o
     where o.deleted_at is null;
  end if;

  if v_ids is null then
    return null;
  end if;

  update public.projects p
     set completeness = c.score
    from (
      select q.id, private.project_completeness(q) as score
        from public.projects q
       where q.id = any (v_ids)
    ) c
   where p.id = c.id
     and p.completeness is distinct from c.score;

  return null;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'project_photos', 'project_land', 'project_facilities', 'project_staff', 'community_profiles'
  ] loop
    execute format(
      'create trigger t80_completeness_ins after insert on public.%I
         referencing new table as new_rows
         for each statement execute function private.tg_child_completeness()', t);
    execute format(
      'create trigger t80_completeness_upd after update on public.%I
         referencing old table as old_rows new table as new_rows
         for each statement execute function private.tg_child_completeness()', t);
    execute format(
      'create trigger t80_completeness_del after delete on public.%I
         referencing old table as old_rows
         for each statement execute function private.tg_child_completeness()', t);
  end loop;
end
$$;

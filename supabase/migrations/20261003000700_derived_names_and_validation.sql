-- =============================================================================
-- 0007  Derived columns and row validation outside the projects table
--
--   private.deepest_admin_area(geom)   deepest boundary containing a point
--   admin_areas         parent consistency, geom_simple from geom
--   localities          name_norm, country/admin area from geom, approval stamp
--   persons             name_normalized, birth_year from birth_date
--   donors              name_norm
--   user_roles          scope_id must reference a country / branch
--   community_profiles  option arrays must reference option_values of the right list
--
-- All trigger functions are SECURITY DEFINER with a pinned search_path so that
-- their look-ups never depend on the caller's RLS scope. They only run as
-- triggers (PostgreSQL refuses to call them directly), so they need no
-- authorisation of their own.
--
-- Validation errors use SQLSTATE PT422 with a stable machine-readable MESSAGE
-- (admin_area_parent_mismatch, invalid_scope, invalid_option_value).
--
-- Trigger functions that look rows up carry `set enable_seqscan = off`: PL/pgSQL
-- caches a generic plan after a few calls, and a plan chosen while a table is
-- still (almost) empty — the first rows of a bulk load — would otherwise be a
-- sequential scan that is then repeated for every one of a million rows.
-- Every look-up here has an index; the setting only makes the choice stable.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- private.deepest_admin_area — the admin area of the highest level (3 > 2 > 1)
-- whose polygon contains the point; no row when nothing contains it.
-- -----------------------------------------------------------------------------
create or replace function private.deepest_admin_area(p_geom extensions.geometry)
returns table (id uuid, country_id uuid, level smallint)
language sql
stable
set search_path = public, extensions, private, pg_temp
as $$
  select a.id, a.country_id, a.level
    from public.admin_areas a
   where a.deleted_at is null
     and a.geom && p_geom
     and st_contains(a.geom, p_geom)
   order by a.level desc, a.id
   limit 1;
$$;

comment on function private.deepest_admin_area(extensions.geometry) is
  'Deepest live admin_areas row whose geom contains the point (ST_Contains); empty when none does.';

-- -----------------------------------------------------------------------------
-- admin_areas
-- -----------------------------------------------------------------------------
create or replace function private.tg_admin_areas_biu()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, private, pg_temp
set enable_seqscan = off
as $$
declare
  v_parent record;
  v_simple extensions.geometry;
begin
  if new.parent_id is not null
     and (tg_op = 'INSERT'
          or new.parent_id is distinct from old.parent_id
          or new.level <> old.level
          or new.country_id <> old.country_id) then
    select a.level, a.country_id into v_parent
      from public.admin_areas a
     where a.id = new.parent_id;
    if found and (v_parent.level <> new.level - 1 or v_parent.country_id <> new.country_id) then
      raise exception 'admin_area_parent_mismatch'
        using errcode = 'PT422',
              detail = 'The parent must be one level above and in the same country.';
    end if;
  end if;

  -- geom_simple follows geom unless the writer supplies its own simplification.
  if new.geom is null then
    new.geom_simple := null;
  elsif tg_op = 'INSERT' then
    if new.geom_simple is null then
      v_simple := new.geom;
    end if;
  elsif new.geom is distinct from old.geom
        and (new.geom_simple is null or new.geom_simple is not distinct from old.geom_simple) then
    v_simple := new.geom;
  elsif new.geom_simple is null then
    v_simple := new.geom;
  end if;

  if v_simple is not null then
    v_simple := st_multi(st_collectionextract(st_makevalid(
      st_simplifypreservetopology(
        v_simple,
        case new.level when 1 then 0.005 when 2 then 0.002 else 0.0005 end)), 3));
    if v_simple is null or st_isempty(v_simple) then
      v_simple := new.geom;
    end if;
    new.geom_simple := v_simple;
  end if;

  return new;
end;
$$;

create trigger t20_derive before insert or update on public.admin_areas
  for each row execute function private.tg_admin_areas_biu();

-- -----------------------------------------------------------------------------
-- localities
-- -----------------------------------------------------------------------------
create or replace function private.tg_localities_biu()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, private, pg_temp
set enable_seqscan = off
as $$
declare
  v_area    record;
  v_country uuid;
begin
  new.name_norm := coalesce(private.norm(concat_ws(' ', new.name_ar, new.name_latin)), '');

  -- Country / admin area from the point (same rule as projects, decision D5).
  -- Same query as private.deepest_admin_area(), inlined so that its plan is cached.
  if new.geom is not null
     and (tg_op = 'INSERT'
          or new.geom is distinct from old.geom
          or new.admin_area_id is distinct from old.admin_area_id
          or new.country_id is distinct from old.country_id) then
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
    end if;
  end if;

  -- A chosen admin area decides the country.
  if new.admin_area_id is not null
     and (tg_op = 'INSERT'
          or new.country_id is null
          or new.admin_area_id is distinct from old.admin_area_id
          or new.country_id is distinct from old.country_id) then
    select a.country_id into v_country from public.admin_areas a where a.id = new.admin_area_id;
    if v_country is not null then
      new.country_id := v_country;
    end if;
  end if;

  -- Approval stamp.
  if new.status = 'approved' and (tg_op = 'INSERT' or old.status <> 'approved') then
    new.approved_at := now();
    new.approved_by := coalesce(auth.uid(), new.approved_by);
  end if;

  return new;
end;
$$;

create trigger t20_derive before insert or update on public.localities
  for each row execute function private.tg_localities_biu();

-- -----------------------------------------------------------------------------
-- persons
-- -----------------------------------------------------------------------------
create or replace function private.tg_persons_biu()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  new.name_normalized := coalesce(private.norm(concat_ws(' ', new.name_ar, new.name_latin)), '');

  if new.birth_date is not null
     and (new.birth_year is null
          or (tg_op = 'UPDATE' and new.birth_date is distinct from old.birth_date)) then
    new.birth_year := extract(year from new.birth_date)::smallint;
  end if;

  return new;
end;
$$;

create trigger t20_derive before insert or update on public.persons
  for each row execute function private.tg_persons_biu();

-- -----------------------------------------------------------------------------
-- donors
-- -----------------------------------------------------------------------------
create or replace function private.tg_donors_biu()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  new.name_norm := coalesce(private.norm(concat_ws(' ', new.name_ar, new.name_latin)), '');
  return new;
end;
$$;

create trigger t20_derive before insert or update on public.donors
  for each row execute function private.tg_donors_biu();

-- -----------------------------------------------------------------------------
-- user_roles: scope_id is a polymorphic reference (countries or branches)
-- -----------------------------------------------------------------------------
create or replace function private.tg_user_roles_biu()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, private, pg_temp
set enable_seqscan = off
as $$
begin
  if new.scope_type = 'country'
     and not exists (select 1 from public.countries c where c.id = new.scope_id) then
    raise exception 'invalid_scope'
      using errcode = 'PT422', detail = 'scope_id is not a country.';
  elsif new.scope_type = 'branch'
     and not exists (select 1 from public.branches b where b.id = new.scope_id) then
    raise exception 'invalid_scope'
      using errcode = 'PT422', detail = 'scope_id is not a branch.';
  end if;
  return new;
end;
$$;

create trigger t20_validate before insert or update on public.user_roles
  for each row execute function private.tg_user_roles_biu();

-- -----------------------------------------------------------------------------
-- community_profiles: every id in a multi-choice array must be an option of
-- the list with the same key (inactive / soft-deleted options stay valid so
-- that offline edits made with an older list are not rejected).
-- -----------------------------------------------------------------------------
create or replace function private.tg_community_profiles_biu()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, private, pg_temp
set enable_seqscan = off
as $$
declare
  v_bad integer;
begin
  new.daawa_activities     := coalesce(new.daawa_activities, '{}'::uuid[]);
  new.social_features      := coalesce(new.social_features, '{}'::uuid[]);
  new.livelihoods          := coalesce(new.livelihoods, '{}'::uuid[]);
  new.religious_issues     := coalesce(new.religious_issues, '{}'::uuid[]);
  new.religious_challenges := coalesce(new.religious_challenges, '{}'::uuid[]);
  new.social_challenges    := coalesce(new.social_challenges, '{}'::uuid[]);
  new.proposed_activities  := coalesce(new.proposed_activities, '{}'::uuid[]);

  if tg_op = 'UPDATE'
     and new.daawa_activities     = old.daawa_activities
     and new.social_features      = old.social_features
     and new.livelihoods          = old.livelihoods
     and new.religious_issues     = old.religious_issues
     and new.religious_challenges = old.religious_challenges
     and new.social_challenges    = old.social_challenges
     and new.proposed_activities  = old.proposed_activities then
    return new;
  end if;

  select count(*) into v_bad
    from (
      select u.id, 'daawa_activities'::text as list_key from unnest(new.daawa_activities) as u (id)
      union all
      select u.id, 'social_features' from unnest(new.social_features) as u (id)
      union all
      select u.id, 'livelihoods' from unnest(new.livelihoods) as u (id)
      union all
      select u.id, 'religious_issues' from unnest(new.religious_issues) as u (id)
      union all
      select u.id, 'religious_challenges' from unnest(new.religious_challenges) as u (id)
      union all
      select u.id, 'social_challenges' from unnest(new.social_challenges) as u (id)
      union all
      select u.id, 'proposed_activities' from unnest(new.proposed_activities) as u (id)
    ) x
   where not exists (
     select 1 from public.option_values o where o.id = x.id and o.list_key = x.list_key
   );

  if v_bad > 0 then
    raise exception 'invalid_option_value'
      using errcode = 'PT422',
            detail = format('%s option id(s) do not belong to the expected option_values list.', v_bad);
  end if;

  return new;
end;
$$;

create trigger t20_validate before insert or update on public.community_profiles
  for each row execute function private.tg_community_profiles_biu();

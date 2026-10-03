-- =============================================================================
-- 0030  Geography / search / paging / tiles: shared helpers and supporting indexes
--       (docs/ARCHITECTURE.md §2.4, brief §5 and §7.3; contract: docs/contracts/geo-search-tiles.md)
--
-- Everything here is additive and idempotent: two pure helper functions and the
-- two keyset indexes of projects_page that the core schema does not have.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Small private helpers (pure, no data access)
-- -----------------------------------------------------------------------------

-- Escape LIKE metacharacters so user input is always matched literally
-- (default LIKE escape character is the backslash).
create or replace function private.like_escape(p_text text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select replace(replace(replace(p_text, '\', '\\'), '%', '\%'), '_', '\_');
$$;

comment on function private.like_escape(text) is
  'Escapes \, % and _ so that the text can be embedded in a LIKE pattern literally.';

-- Filter values may arrive as a JSON string ("mosque") or as an array
-- (["mosque","combined"]). Returns NULL (= "no filter") for null / missing /
-- empty input so callers can write `v is null or col = any (v)`.
create or replace function private.jsonb_text_array(p_value jsonb)
returns text[]
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select case jsonb_typeof(p_value)
    when 'array' then (
      select nullif(array_agg(e.v), '{}'::text[])
      from jsonb_array_elements_text(p_value) as e(v)
      where e.v is not null and e.v <> ''
    )
    when 'string' then
      case when p_value #>> '{}' = '' then null else array[p_value #>> '{}'] end
    when 'number' then array[p_value #>> '{}']
    else null
  end;
$$;

comment on function private.jsonb_text_array(jsonb) is
  'JSON string or array of strings -> text[]; NULL when absent or empty (meaning: no filter).';

revoke execute on function
  private.like_escape(text),
  private.jsonb_text_array(jsonb)
from public, anon, authenticated;

grant execute on function
  private.like_escape(text),
  private.jsonb_text_array(jsonb)
to service_role;

-- -----------------------------------------------------------------------------
-- Supporting indexes
--
-- Everything else these functions need already exists in the core schema
-- (0002–0004): projects_geom_gist, projects_search_norm_trgm, projects_admin_area_idx,
-- projects_locality_idx, projects_created_by_idx, admin_areas_geom_gist,
-- admin_areas_parent_idx, localities_geom_gist, localities_name_norm_trgm,
-- donors_name_norm_trgm, project_donors_donor_idx, project_staff_person_idx,
-- persons_name_normalized_trgm, persons_branch_sync_idx (leading branch_id),
-- project_maintenance_open_idx, project_photos_project_idx.
-- -----------------------------------------------------------------------------

-- projects_page keyset orders. Sorting uses the "C" collation so that the order
-- (and therefore the cursor) is identical on every server locale and matches a
-- plain code-point comparison on the device.
create index if not exists projects_page_name_idx
  on public.projects (name_ar collate "C", id)
  where deleted_at is null;

create index if not exists projects_page_updated_idx
  on public.projects (updated_at, id)
  where deleted_at is null;

-- =============================================================================
-- 0009  project_photos rules (brief §6)
--
--   * at most 10 live photos per project (PT422 photo_limit_exceeded)
--   * at most one live cover: setting a new cover clears the previous one;
--     a soft-deleted photo is never the cover
--   * a photo cannot move to another project (PT422 photo_project_immutable)
--   * storage paths default to projects/{ISO2}/{project_id}/{id}_{full|thumb}.webp
--
-- No cover is promoted automatically: clients fall back to the first photo
-- when a project has no cover.
-- =============================================================================

create or replace function private.tg_project_photos_biu()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, private, pg_temp
set enable_seqscan = off
as $$
declare
  v_live      boolean := new.deleted_at is null;
  v_was_live  boolean := false;
  v_was_cover boolean := false;
  v_iso2      text;
  v_count     integer;
begin
  if tg_op = 'UPDATE' then
    if new.project_id <> old.project_id then
      raise exception 'photo_project_immutable'
        using errcode = 'PT422', detail = 'A photo cannot be moved to another project.';
    end if;
    v_was_live := old.deleted_at is null;
    v_was_cover := v_was_live and old.is_cover;
  end if;

  new.is_cover := coalesce(new.is_cover, false);

  -- Default object paths (t10_std has already set new.id).
  if tg_op = 'INSERT' and (new.storage_path_full is null or new.storage_path_thumb is null) then
    select c.iso2::text into v_iso2
      from public.projects p
      join public.countries c on c.id = p.country_id
     where p.id = new.project_id;
    if v_iso2 is not null then
      new.storage_path_full := coalesce(
        new.storage_path_full,
        format('projects/%s/%s/%s_full.webp', v_iso2, new.project_id, new.id));
      new.storage_path_thumb := coalesce(
        new.storage_path_thumb,
        format('projects/%s/%s/%s_thumb.webp', v_iso2, new.project_id, new.id));
    end if;
  end if;

  if not v_live then
    new.is_cover := false;
  end if;

  -- Limit: serialise writers of the same project on the parent row, then count.
  if v_live and not v_was_live then
    perform 1 from public.projects p where p.id = new.project_id for no key update;

    select count(*) into v_count
      from public.project_photos x
     where x.project_id = new.project_id
       and x.deleted_at is null
       and x.id <> new.id;

    if v_count >= 10 then
      raise exception 'photo_limit_exceeded'
        using errcode = 'PT422', detail = 'A project can have at most 10 photos.';
    end if;
  end if;

  -- One cover: the newest choice wins.
  if v_live and new.is_cover and not v_was_cover then
    update public.project_photos x
       set is_cover = false
     where x.project_id = new.project_id
       and x.is_cover
       and x.deleted_at is null
       and x.id <> new.id;
  end if;

  return new;
end;
$$;

create trigger t20_rules before insert or update on public.project_photos
  for each row execute function private.tg_project_photos_biu();

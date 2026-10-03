-- Photo retention (brief §11): photos that were soft-deleted more than 90 days ago are removed
-- from object storage by the `purge-photos` Edge Function (service role). The database only
-- tells the function WHAT to remove and records that it was done; rows are never hard-deleted.
--
--   photos_to_purge(p_limit)        next batch of storage paths to remove
--   mark_photos_purged(p_ids)       stamp purged_at after the objects were removed
--
-- A photo is purgeable when it has not been purged yet and either the photo row itself or its
-- project has been soft-deleted for more than 90 days.

create or replace function private.photo_retention_days()
returns integer
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$ select 90 $$;

revoke execute on function private.photo_retention_days() from public, anon, authenticated;

-- The core schema already indexes soft-deleted, unpurged photos (project_photos_purge_idx).
-- Small partial index for "projects deleted more than 90 days ago" (only deleted rows).
create index if not exists projects_deleted_at_idx
  on public.projects (deleted_at)
  where deleted_at is not null;

create or replace function public.photos_to_purge(p_limit integer default 500)
returns table (
  id uuid,
  project_id uuid,
  bucket text,
  storage_path_full text,
  storage_path_thumb text,
  deleted_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_cutoff constant timestamptz := now() - make_interval(days => private.photo_retention_days());
  v_limit constant integer := least(greatest(coalesce(p_limit, 500), 1), 5000);
begin
  perform private.require_service_role();

  return query
  select x.id, x.project_id, 'photos'::text, x.storage_path_full, x.storage_path_thumb, x.deleted_at
  from (
    -- photos deleted on their own
    select ph.id, ph.project_id, ph.storage_path_full, ph.storage_path_thumb, ph.deleted_at
    from public.project_photos ph
    where ph.deleted_at is not null
      and ph.deleted_at < v_cutoff
      and ph.purged_at is null
    union
    -- photos of projects deleted more than 90 days ago
    select ph.id, ph.project_id, ph.storage_path_full, ph.storage_path_thumb,
           coalesce(ph.deleted_at, p.deleted_at)
    from public.projects p
    join public.project_photos ph on ph.project_id = p.id
    where p.deleted_at is not null
      and p.deleted_at < v_cutoff
      and ph.purged_at is null
      and (ph.deleted_at is null or ph.deleted_at >= v_cutoff)
  ) x
  order by x.deleted_at, x.id
  limit v_limit;
end;
$$;

create or replace function public.mark_photos_purged(p_ids uuid[])
returns integer
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_cutoff constant timestamptz := now() - make_interval(days => private.photo_retention_days());
  v_count integer;
begin
  perform private.require_service_role();

  if p_ids is null or cardinality(p_ids) = 0 then
    return 0;
  end if;

  -- Eligibility is re-checked here so that a wrong id can never flag a live photo as purged.
  update public.project_photos ph
  set purged_at = now(),
      deleted_at = coalesce(ph.deleted_at, now())
  where ph.id = any (p_ids)
    and ph.purged_at is null
    and (
      (ph.deleted_at is not null and ph.deleted_at < v_cutoff)
      or exists (
        select 1 from public.projects p
        where p.id = ph.project_id and p.deleted_at is not null and p.deleted_at < v_cutoff)
    );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.photos_to_purge(integer) from public, anon, authenticated;
revoke execute on function public.mark_photos_purged(uuid[]) from public, anon, authenticated;
grant execute on function public.photos_to_purge(integer) to service_role;
grant execute on function public.mark_photos_purged(uuid[]) to service_role;

comment on function public.photos_to_purge(integer) is
  'Service role only. Storage paths (bucket photos) of photos soft-deleted more than 90 days ago and not yet purged.';
comment on function public.mark_photos_purged(uuid[]) is
  'Service role only. Stamps purged_at on photos whose objects were removed; returns the number of rows marked.';

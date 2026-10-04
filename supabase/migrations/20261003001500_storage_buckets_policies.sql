-- =============================================================================
-- 0015  Storage buckets and storage.objects policies (brief §6, ARCHITECTURE §3.3)
--
--   photos   private  projects/{ISO2}/{project_id}/{photo_id}_{full|thumb}.{webp|jpg|jpeg}
--   exports  private  {user_id}/...          (result files of export jobs)
--   imports  private  {user_id}/...          (uploaded CSV/XLSX files)
--   tiles    public   PMTiles basemap + offline map packs (range requests, no auth header)
--
-- storage.objects already has RLS enabled on Supabase and is owned by the
-- storage admin role, so this file only adds policies (no ALTER TABLE).
-- anon has no policy at all; the public `tiles` bucket is served by the
-- Storage API's public endpoint, which does not go through RLS.
-- Objects are never deleted by users: photo retention (90 days after a soft
-- delete) is enforced by the purge-photos function with the service role.
--
-- A photo object is the content of one project_photos row, so writing it
-- (insert, upsert/TUS overwrite, move) follows the rule for editing that row
-- (sync registry class "creator"): the row must be live, of a live project,
-- and the caller must be its creator with write scope or a reviewer of the
-- project (private.photo_object_writable). Reading follows the project.
--
-- Upload rate limiting (brief §11) is NOT done here: Storage checks these
-- policies in a permission test that it rolls back, so a counter in a policy
-- does not persist. The database bounds the number of objects instead (a few
-- names per live photo row, at most 10 live rows per project, rows written
-- only through the rate-limited sync_push); the request rate is limited in
-- front of Storage (local gateway; an edge rule in production).
-- See docs/contracts/authz.md §4.4.
-- =============================================================================

insert into storage.buckets (id, name, public)
values
  ('photos', 'photos', false),
  ('exports', 'exports', false),
  ('imports', 'imports', false),
  ('tiles', 'tiles', true)
on conflict (id) do update set public = excluded.public;

-- Upload limits (columns exist on current Supabase; guarded so that minimal
-- local emulations of the storage schema still accept this migration).
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'storage' and table_name = 'buckets' and column_name = 'file_size_limit'
  ) and exists (
    select 1 from information_schema.columns
    where table_schema = 'storage' and table_name = 'buckets' and column_name = 'allowed_mime_types'
  ) then
    -- Compressed photos are ~0.1-0.5 MB; 5 MB leaves room for JPEG fallbacks.
    execute $sql$
      update storage.buckets
      set file_size_limit = 5242880,
          allowed_mime_types = array['image/webp', 'image/jpeg']
      where id = 'photos'
    $sql$;
    -- Import files: size cap only (browsers report inconsistent MIME types for CSV).
    execute $sql$
      update storage.buckets
      set file_size_limit = 26214400
      where id = 'imports'
    $sql$;
  end if;
end
$$;

-- Project id encoded in a photo object name, or null when the name does not
-- match the mandated layout exactly. Returning null (instead of raising on a
-- bad uuid) keeps listing queries safe whatever objects exist.
create or replace function private.photo_object_project(p_name text)
returns uuid
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  select case
    -- same layout as the CHECK constraints on project_photos.storage_path_*
    when p_name ~ '^projects/[A-Z]{2}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_(full|thumb)[.](webp|jpg|jpeg)$'
    then ((storage.foldername(p_name))[3])::uuid
  end;
$$;

comment on function private.photo_object_project(text) is
  'Project id from photos/projects/{ISO2}/{project_id}/{photo_id}_{full|thumb}.{webp|jpg|jpeg}; null for any other name.';

revoke execute on function private.photo_object_project(text) from public, anon;
grant execute on function private.photo_object_project(text) to authenticated, service_role;

-- May the caller create or replace the photos object p_name?
--   * the name has the mandated layout and its {project_id}/{photo_id} pair is
--     a live project_photos row of a live project (no object without a row);
--   * the caller may edit that row: write scope on the project and either the
--     row's creator or a reviewer of the project (registry class "creator");
--   * the ISO2 segment is the one of the row's stored paths or the project's
--     current country (the client may upload under a name whose corrected path
--     has not reached the server yet: JPEG fallback, country assigned by the
--     server); any of the three extensions.
-- A photo row therefore owns at most 3 x 3 x 2 object names.
-- false (never NULL) for anything else, including callers without a session.
create or replace function private.photo_object_writable(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_project uuid := private.photo_object_project(p_name);
  v_photo   uuid;
  v_iso2    text;
  v         record;
begin
  if v_project is null then
    return false;
  end if;
  v_iso2  := split_part(p_name, '/', 2);
  v_photo := left(split_part(p_name, '/', 4), 36)::uuid;

  select ph.created_by,
         split_part(ph.storage_path_full, '/', 2)  as iso2_full,
         split_part(ph.storage_path_thumb, '/', 2) as iso2_thumb,
         p.country_id,
         p.branch_id,
         c.iso2::text                              as iso2_project
    into v
    from public.project_photos ph
    join public.projects p on p.id = ph.project_id
    left join public.countries c on c.id = p.country_id
   where ph.id = v_photo
     and ph.project_id = v_project
     and ph.deleted_at is null
     and ph.purged_at is null
     and p.deleted_at is null;
  if not found then
    return false;
  end if;

  if v_iso2 is distinct from v.iso2_full
     and v_iso2 is distinct from v.iso2_thumb
     and v_iso2 is distinct from v.iso2_project then
    return false;
  end if;

  if not private.can_write_project(v.country_id, v.branch_id) then
    return false;
  end if;
  return coalesce(v.created_by = auth.uid(), false)
      or private.can_review(v.country_id, v.branch_id);
end;
$$;

comment on function private.photo_object_writable(text) is
  'True when the caller may create/replace this photos object: it belongs to a live project_photos row of a live project that the caller may edit (creator with write scope, or reviewer).';

revoke execute on function private.photo_object_writable(text) from public, anon;
grant execute on function private.photo_object_writable(text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- photos
-- -----------------------------------------------------------------------------

drop policy if exists istiqama_photos_select on storage.objects;
create policy istiqama_photos_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'photos'
    and exists (
      select 1
      from public.projects p
      where p.id = private.photo_object_project(name)
        and (
          (select private.read_all())
          or p.country_id = any ((select private.read_countries())::uuid[])
          or p.branch_id = any ((select private.read_branches())::uuid[])
        )
    )
  );

-- Upload: only objects of a live photo row the caller may edit (see above).
-- The upload order of the client is: project row, photo row, then objects.
drop policy if exists istiqama_photos_insert on storage.objects;
create policy istiqama_photos_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'photos' and private.photo_object_writable(name));

-- Needed by resumable (TUS) uploads, upserts and moves: the existing object
-- (USING) and the new name (WITH CHECK) must both be writable by the caller,
-- so nobody can overwrite or move away the object of a row they may not edit.
drop policy if exists istiqama_photos_update on storage.objects;
create policy istiqama_photos_update on storage.objects
  for update to authenticated
  using (bucket_id = 'photos' and private.photo_object_writable(name))
  with check (bucket_id = 'photos' and private.photo_object_writable(name));

-- -----------------------------------------------------------------------------
-- exports / imports: a user only ever sees or writes objects under a first
-- folder equal to their own user id.
-- -----------------------------------------------------------------------------

drop policy if exists istiqama_user_files_select on storage.objects;
create policy istiqama_user_files_select on storage.objects
  for select to authenticated
  using (
    bucket_id in ('exports', 'imports')
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select private.session_ok())
  );

drop policy if exists istiqama_user_files_insert on storage.objects;
create policy istiqama_user_files_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id in ('exports', 'imports')
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select private.session_ok())
  );

drop policy if exists istiqama_user_files_update on storage.objects;
create policy istiqama_user_files_update on storage.objects
  for update to authenticated
  using (
    bucket_id in ('exports', 'imports')
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select private.session_ok())
  )
  with check (
    bucket_id in ('exports', 'imports')
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select private.session_ok())
  );

-- -----------------------------------------------------------------------------
-- tiles: every signed-in user may read/list; only hq_admin (or the service
-- role, which bypasses RLS) may publish or replace packs.
-- -----------------------------------------------------------------------------

drop policy if exists istiqama_tiles_select on storage.objects;
create policy istiqama_tiles_select on storage.objects
  for select to authenticated
  using (bucket_id = 'tiles' and (select private.session_ok()));

drop policy if exists istiqama_tiles_insert_hq on storage.objects;
create policy istiqama_tiles_insert_hq on storage.objects
  for insert to authenticated
  with check (bucket_id = 'tiles' and (select private.is_hq()));

drop policy if exists istiqama_tiles_update_hq on storage.objects;
create policy istiqama_tiles_update_hq on storage.objects
  for update to authenticated
  using (bucket_id = 'tiles' and (select private.is_hq()))
  with check (bucket_id = 'tiles' and (select private.is_hq()));

drop policy if exists istiqama_tiles_delete_hq on storage.objects;
create policy istiqama_tiles_delete_hq on storage.objects
  for delete to authenticated
  using (bucket_id = 'tiles' and (select private.is_hq()));

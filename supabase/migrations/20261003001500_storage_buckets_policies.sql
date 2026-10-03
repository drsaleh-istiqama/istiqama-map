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

drop policy if exists istiqama_photos_insert on storage.objects;
create policy istiqama_photos_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'photos'
    and exists (
      select 1
      from public.projects p
      where p.id = private.photo_object_project(name)
        and p.deleted_at is null
        and (
          (select private.write_all())
          or p.country_id = any ((select private.write_countries())::uuid[])
          or p.branch_id = any ((select private.write_branches())::uuid[])
        )
    )
  );

-- Needed by resumable (TUS) uploads and upserts; the new name is re-checked.
drop policy if exists istiqama_photos_update on storage.objects;
create policy istiqama_photos_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'photos'
    and exists (
      select 1
      from public.projects p
      where p.id = private.photo_object_project(name)
        and p.deleted_at is null
        and (
          (select private.write_all())
          or p.country_id = any ((select private.write_countries())::uuid[])
          or p.branch_id = any ((select private.write_branches())::uuid[])
        )
    )
  )
  with check (
    bucket_id = 'photos'
    and exists (
      select 1
      from public.projects p
      where p.id = private.photo_object_project(name)
        and p.deleted_at is null
        and (
          (select private.write_all())
          or p.country_id = any ((select private.write_countries())::uuid[])
          or p.branch_id = any ((select private.write_branches())::uuid[])
        )
    )
  );

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

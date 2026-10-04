-- =============================================================================
-- 15  Storage buckets and storage.objects policies (migration 0015)
--
--   photos   projects/{ISO2}/{project_id}/{photo_id}_{full|thumb}.{webp|jpg|jpeg}
--            read  = whoever can read the project
--            write = whoever may edit the live project_photos row the object
--                    belongs to (its creator with write scope, or a reviewer);
--                    no object without a row (never viewer)
--   exports / imports   only objects under a first folder = auth.uid()
--   tiles    read for every signed-in user, write for hq_admin
--   anon     nothing
-- =============================================================================
begin;
set local search_path = public, extensions, tests;

select plan(70);

select tests.fixture_extra();
select tests.fixture_storage();

-- Photo rows whose objects the tests below upload (objects need a live row).
insert into public.project_photos (id, created_by, project_id, storage_path_full, storage_path_thumb)
select tests._uuid(x.k), tests.id(x.u), tests.id(x.p),
       'projects/' || x.iso2 || '/' || tests.id(x.p)::text || '/' || tests._uuid(x.k)::text || '_full.webp',
       'projects/' || x.iso2 || '/' || tests.id(x.p)::text || '/' || tests._uuid(x.k)::text || '_thumb.webp'
from (values
  ('new-photo-1', 'u_col_pemba',  'p_pemba_1', 'TZ'),
  ('new-photo-2', 'u_col_tanga',  'p_tanga_1', 'TZ'),
  ('new-photo-3', 'u_col_ke',     'p_ke_1',    'KE'),
  ('new-photo-5', 'u_col_pemba',  'p_pemba_1', 'TZ'),
  ('new-photo-6', 'u_col_tanga',  'p_tanga_1', 'TZ'),
  ('new-photo-7', 'u_col_ke',     'p_ke_1',    'KE'),
  ('pemba2-photo', 'u_col_pemba2', 'p_pemba_1', 'TZ'),
  ('deleted-photo', 'u_col_pemba', 'p_pemba_1', 'TZ')
) as x (k, u, p, iso2);
update public.project_photos set deleted_at = now() where id = tests._uuid('deleted-photo');

-- object name of a photo: (photo key or uuid, project key, kind.ext, iso2)
create temporary table _names on commit drop as
select 'fixture_full' as k,
       (select storage_path_full from public.project_photos where id = tests.id('photo:p_pemba_1')) as name
union all
select 'fixture_jpg',
       'projects/TZ/' || tests.id('p_pemba_1')::text || '/' || tests.id('photo:p_pemba_1')::text || '_full.jpg'
union all
select 'pemba2_full',
       'projects/TZ/' || tests.id('p_pemba_1')::text || '/' || tests._uuid('pemba2-photo')::text || '_full.webp'
union all
select 'no_row',
       'projects/TZ/' || tests.id('p_pemba_1')::text || '/' || tests._uuid('photo-without-row')::text || '_full.webp'
union all
select 'own_wrong_iso2',
       'projects/KE/' || tests.id('p_pemba_1')::text || '/' || tests._uuid('new-photo-5')::text || '_full.webp'
union all
select 'own_deleted',
       'projects/TZ/' || tests.id('p_pemba_1')::text || '/' || tests._uuid('deleted-photo')::text || '_full.webp';
grant select on _names to public;

-- Buckets ----------------------------------------------------------------------
select results_eq(
  $$ select id::text, public from storage.buckets where id in ('photos', 'exports', 'imports', 'tiles') order by id $$,
  $$ values ('exports', false), ('imports', false), ('photos', false), ('tiles', true) $$,
  'buckets: photos, exports and imports are private; tiles is public');

-- Path parser ------------------------------------------------------------------
select is(
  private.photo_object_project(
    'projects/TZ/' || tests.id('p_pemba_1')::text || '/' || tests.id('photo:p_pemba_1')::text || '_full.webp'),
  tests.id('p_pemba_1'), 'photo_object_project(): well-formed full path');
select is(
  private.photo_object_project(
    'projects/KE/' || tests.id('p_ke_1')::text || '/' || tests.id('photo:p_ke_1')::text || '_thumb.jpg'),
  tests.id('p_ke_1'), 'photo_object_project(): well-formed thumb path with jpg');
select is(private.photo_object_project('projects/TZ/not-a-uuid/x_full.webp'), null, 'photo_object_project(): bad project id -> null');
select is(
  private.photo_object_project(
    'other/TZ/' || tests.id('p_pemba_1')::text || '/' || tests.id('photo:p_pemba_1')::text || '_full.webp'),
  null, 'photo_object_project(): wrong first folder -> null');
select is(
  private.photo_object_project(
    'projects/TZ/' || tests.id('p_pemba_1')::text || '/' || tests.id('photo:p_pemba_1')::text || '_full.exe'),
  null, 'photo_object_project(): wrong extension -> null');
select is(
  private.photo_object_project(
    'projects/TZ/' || tests.id('p_pemba_1')::text || '/sub/' || tests.id('photo:p_pemba_1')::text || '_full.webp'),
  null, 'photo_object_project(): extra folder -> null');
select is(private.photo_object_project(null), null, 'photo_object_project(): null -> null');

-- -----------------------------------------------------------------------------
-- photos: read
-- -----------------------------------------------------------------------------
select tests.login_as(tests.id('u_col_ke'), 'aal1');
select is(
  (select count(*)::int from storage.objects where bucket_id = 'photos'), 2,
  'KE collector: sees the two objects of its project''s photo');
select is_empty(
  $$ select 1 from storage.objects where bucket_id = 'photos' and name like 'projects/TZ/%' $$,
  'KE collector: no photo object of Tanzania');
select is_empty(
  format($f$ select 1 from storage.objects where bucket_id = 'photos' and name like %L $f$,
         'projects/%/' || tests.id('p_pemba_1')::text || '/%'),
  'KE collector: no object of a Tanzanian project by id');

select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select is(
  (select count(*)::int from storage.objects where bucket_id = 'photos'), 4,
  'Pemba collector: sees the objects of its two projects');
select is_empty(
  format($f$ select 1 from storage.objects where bucket_id = 'photos' and name like %L $f$,
         'projects/%/' || tests.id('p_tanga_1')::text || '/%'),
  'Pemba collector: no object of the Tanga project');

select tests.login_as(tests.id('u_viewer_tz'), 'aal1');
select is(
  (select count(*)::int from storage.objects where bucket_id = 'photos'
     and private.photo_object_project(name) = any (tests.fixture_projects())), 6,
  'TZ viewer: may view the photos of the country');

select tests.login_as(tests.id('u_mgr_tz'), 'aal1');
select is_empty($$ select 1 from storage.objects where bucket_id = 'photos' $$, 'manager at AAL1: no photo object');

select tests.login_as(tests.id('u_hq'), 'aal2');
select is(
  (select count(*)::int from storage.objects where bucket_id = 'photos'
     and private.photo_object_project(name) = any (tests.fixture_projects())), 8,
  'hq_admin: all photo objects');

-- -----------------------------------------------------------------------------
-- photos: write
-- -----------------------------------------------------------------------------
select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select lives_ok(
  format($f$ insert into storage.objects (bucket_id, name) values ('photos', %L) $f$,
         'projects/TZ/' || tests.id('p_pemba_1')::text || '/' || tests._uuid('new-photo-1')::text || '_full.webp'),
  'Pemba collector: can upload a photo for a project of its branch');
select lives_ok(
  format($f$ insert into storage.objects (bucket_id, name) values ('photos', %L) $f$,
         'projects/TZ/' || tests.id('p_pemba_1')::text || '/' || tests._uuid('new-photo-1')::text || '_thumb.jpg'),
  'Pemba collector: can upload the thumbnail (jpg fallback)');
select throws_ok(
  format($f$ insert into storage.objects (bucket_id, name) values ('photos', %L) $f$,
         'projects/TZ/' || tests.id('p_tanga_1')::text || '/' || tests._uuid('new-photo-2')::text || '_full.webp'),
  '42501', null, 'Pemba collector: cannot upload into a project of another branch');
select throws_ok(
  format($f$ insert into storage.objects (bucket_id, name) values ('photos', %L) $f$,
         'projects/KE/' || tests.id('p_ke_1')::text || '/' || tests._uuid('new-photo-3')::text || '_full.webp'),
  '42501', null, 'Pemba collector: cannot upload into a project of another country');
select throws_ok(
  format($f$ insert into storage.objects (bucket_id, name) values ('photos', %L) $f$,
         'projects/TZ/' || tests.id('p_pemba_1')::text || '/evil.html'),
  '42501', null, 'Pemba collector: object names outside the mandated layout are refused');
select throws_ok(
  format($f$ insert into storage.objects (bucket_id, name) values ('photos', %L) $f$,
         tests.id('u_col_pemba')::text || '/anything.webp'),
  '42501', null, 'Pemba collector: nothing outside projects/ in the photos bucket');
select throws_ok(
  format($f$ insert into storage.objects (bucket_id, name) values ('photos', %L) $f$,
         'projects/TZ/' || tests._uuid('no-such-project')::text || '/' || tests._uuid('new-photo-4')::text || '_full.webp'),
  '42501', null, 'Pemba collector: cannot upload for a project that does not exist on the server');
select isnt_empty(
  format($f$ update storage.objects set name = name where bucket_id = 'photos' and name = %L returning 1 $f$,
         'projects/TZ/' || tests.id('p_pemba_1')::text || '/' || tests._uuid('new-photo-1')::text || '_full.webp'),
  'Pemba collector: can update (resume/overwrite) its upload');
select throws_ok(
  format($f$ update storage.objects set name = %L where bucket_id = 'photos' and name = %L $f$,
         'projects/TZ/' || tests.id('p_tanga_1')::text || '/' || tests._uuid('new-photo-1')::text || '_full.webp',
         'projects/TZ/' || tests.id('p_pemba_1')::text || '/' || tests._uuid('new-photo-1')::text || '_full.webp'),
  '42501', null, 'Pemba collector: cannot move an object into a foreign project');
select is_empty(
  $$ delete from storage.objects where bucket_id = 'photos' returning 1 $$,
  'Pemba collector: cannot delete photo objects (retention is a server job)');
select isnt_empty(
  format($f$ update storage.objects set name = name where bucket_id = 'photos' and name = %L returning 1 $f$,
         (select name from _names where k = 'fixture_full')),
  'Pemba collector: can overwrite the object of its own photo of an approved project');
select lives_ok(
  format($f$ insert into storage.objects (bucket_id, name, owner) values ('photos', %L, auth.uid())
             on conflict (bucket_id, name) do update set owner = excluded.owner $f$,
         (select name from _names where k = 'fixture_full')),
  'Pemba collector: upsert (TUS x-upsert) of the own photo object');
select throws_ok(
  format($f$ insert into storage.objects (bucket_id, name) values ('photos', %L) $f$,
         (select name from _names where k = 'own_wrong_iso2')),
  '42501', null, 'Pemba collector: the ISO2 segment must be the one of the row or of the project');
select throws_ok(
  format($f$ insert into storage.objects (bucket_id, name) values ('photos', %L) $f$,
         (select name from _names where k = 'own_deleted')),
  '42501', null, 'Pemba collector: no upload for a soft-deleted photo row');

-- Another collector of the same branch: may add own photos to the project, but
-- never write the objects of a photo row it may not edit (registry class "creator").
select tests.login_as(tests.id('u_col_pemba2'), 'aal1');
select is_empty(
  format($f$ update storage.objects set name = name where bucket_id = 'photos' and name = %L returning 1 $f$,
         (select name from _names where k = 'fixture_full')),
  'second collector: cannot overwrite the photo object of another user''s (approved) project');
select throws_ok(
  format($f$ insert into storage.objects (bucket_id, name, owner) values ('photos', %L, auth.uid())
             on conflict (bucket_id, name) do update set owner = excluded.owner $f$,
         (select name from _names where k = 'fixture_full')),
  '42501', null, 'second collector: cannot upsert over the photo object of another user');
select throws_ok(
  format($f$ insert into storage.objects (bucket_id, name) values ('photos', %L) $f$,
         (select name from _names where k = 'fixture_jpg')),
  '42501', null, 'second collector: cannot plant an object under another user''s photo row');
select throws_ok(
  format($f$ insert into storage.objects (bucket_id, name) values ('photos', %L) $f$,
         (select name from _names where k = 'no_row')),
  '42501', null, 'second collector: no object for a photo id without a live photo row');
select lives_ok(
  format($f$ insert into storage.objects (bucket_id, name) values ('photos', %L) $f$,
         (select name from _names where k = 'pemba2_full')),
  'second collector: can upload the object of its own photo row in a project of another user');
select throws_ok(
  format($f$ update storage.objects set name = %L where bucket_id = 'photos' and name = %L $f$,
         (select name from _names where k = 'fixture_jpg'), (select name from _names where k = 'pemba2_full')),
  '42501', null, 'second collector: cannot move an own object onto another user''s photo');
select is_empty(
  format($f$ update storage.objects set name = %L where bucket_id = 'photos' and name = %L returning 1 $f$,
         replace((select name from _names where k = 'pemba2_full'), '_full.webp', '_full.jpg'),
         (select name from _names where k = 'fixture_full')),
  'second collector: cannot move another user''s photo object away');
select is(
  (select count(*)::int from storage.objects
    where bucket_id = 'photos' and name = (select name from _names where k = 'fixture_full')),
  1, 'the other user''s photo object is still in place');
select tests.logout();
select is(
  (select record_state from public.projects where id = tests.id('p_pemba_1')), 'approved',
  'the approved project is untouched');

-- A reviewer may edit every photo row of its branch, so also its objects.
select tests.login_as(tests.id('u_sup_pemba'), 'aal1');
select isnt_empty(
  format($f$ update storage.objects set name = name where bucket_id = 'photos' and name = %L returning 1 $f$,
         (select name from _names where k = 'fixture_full')),
  'branch_supervisor: can replace the photo object of a collector of the branch');
select throws_ok(
  format($f$ insert into storage.objects (bucket_id, name) values ('photos', %L) $f$,
         (select name from _names where k = 'no_row')),
  '42501', null, 'branch_supervisor: no object without a photo row either');

select tests.login_as(tests.id('u_viewer_tz'), 'aal1');
select throws_ok(
  format($f$ insert into storage.objects (bucket_id, name) values ('photos', %L) $f$,
         'projects/TZ/' || tests.id('p_pemba_1')::text || '/' || tests._uuid('new-photo-5')::text || '_full.webp'),
  '42501', null, 'viewer: cannot upload photos');
select is_empty(
  $$ update storage.objects set name = name where bucket_id = 'photos' returning 1 $$,
  'viewer: cannot update photo objects');

select tests.login_as(tests.id('u_mgr_tz'), 'aal2');
select lives_ok(
  format($f$ insert into storage.objects (bucket_id, name) values ('photos', %L) $f$,
         'projects/TZ/' || tests.id('p_tanga_1')::text || '/' || tests._uuid('new-photo-6')::text || '_full.webp'),
  'country_manager: can upload for any project of the country');
select throws_ok(
  format($f$ insert into storage.objects (bucket_id, name) values ('photos', %L) $f$,
         'projects/KE/' || tests.id('p_ke_1')::text || '/' || tests._uuid('new-photo-7')::text || '_full.webp'),
  '42501', null, 'country_manager: cannot upload for another country');

-- -----------------------------------------------------------------------------
-- exports / imports: own folder only
-- -----------------------------------------------------------------------------
select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select results_eq(
  $$ select bucket_id::text, name::text from storage.objects where bucket_id in ('exports', 'imports') order by 1, 2 $$,
  format($f$ values ('exports', %L), ('imports', %L) $f$,
         tests.id('u_col_pemba')::text || '/export.csv', tests.id('u_col_pemba')::text || '/import.csv'),
  'user: sees exactly the own export and import files');
select lives_ok(
  format($f$ insert into storage.objects (bucket_id, name) values ('imports', %L) $f$,
         tests.id('u_col_pemba')::text || '/upload-1.csv'),
  'user: can upload an import file into the own folder');
select throws_ok(
  format($f$ insert into storage.objects (bucket_id, name) values ('imports', %L) $f$,
         tests.id('u_col_ke')::text || '/upload-1.csv'),
  '42501', null, 'user: cannot upload into the folder of another user');
select throws_ok(
  $$ insert into storage.objects (bucket_id, name) values ('imports', 'upload-at-root.csv') $$,
  '42501', null, 'user: cannot upload at the bucket root');
select throws_ok(
  format($f$ insert into storage.objects (bucket_id, name) values ('exports', %L) $f$,
         tests.id('u_col_ke')::text || '/planted.csv'),
  '42501', null, 'user: cannot plant a file in the exports folder of another user');
select is_empty(
  format($f$ select 1 from storage.objects where bucket_id = 'exports' and name = %L $f$,
         tests.id('u_col_ke')::text || '/export.csv'),
  'user: cannot read the export of another user');
select is_empty(
  $$ delete from storage.objects where bucket_id in ('exports', 'imports') returning 1 $$,
  'user: cannot delete export/import objects');

select tests.login_as(tests.id('u_hq'), 'aal2');
select is_empty(
  format($f$ select 1 from storage.objects where bucket_id = 'exports' and name = %L $f$,
         tests.id('u_col_ke')::text || '/export.csv'),
  'hq_admin: exports of other users are private too');

-- -----------------------------------------------------------------------------
-- tiles
-- -----------------------------------------------------------------------------
select tests.login_as(tests.id('u_col_ke'), 'aal1');
select isnt_empty(
  $$ select 1 from storage.objects where bucket_id = 'tiles' and name = 'packs/test.pmtiles' $$,
  'field_collector: can list tiles');
select throws_ok(
  $$ insert into storage.objects (bucket_id, name) values ('tiles', 'packs/evil.pmtiles') $$,
  '42501', null, 'field_collector: cannot publish tiles');
select is_empty(
  $$ update storage.objects set name = name where bucket_id = 'tiles' returning 1 $$,
  'field_collector: cannot change tiles');
select is_empty(
  $$ delete from storage.objects where bucket_id = 'tiles' returning 1 $$,
  'field_collector: cannot delete tiles');

select tests.login_as(tests.id('u_viewer_global'), 'aal1');
select isnt_empty(
  $$ select 1 from storage.objects where bucket_id = 'tiles' $$, 'viewer: can list tiles');

select tests.login_as(tests.id('u_mgr_tz'), 'aal2');
select throws_ok(
  $$ insert into storage.objects (bucket_id, name) values ('tiles', 'packs/mgr.pmtiles') $$,
  '42501', null, 'country_manager: cannot publish tiles');

select tests.login_as(tests.id('u_hq'), 'aal1');
select throws_ok(
  $$ insert into storage.objects (bucket_id, name) values ('tiles', 'packs/hq-aal1.pmtiles') $$,
  '42501', null, 'hq_admin at AAL1: cannot publish tiles');

select tests.login_as(tests.id('u_hq'), 'aal2');
select lives_ok(
  $$ insert into storage.objects (bucket_id, name) values ('tiles', 'packs/new.pmtiles') $$,
  'hq_admin: can publish tiles');
select isnt_empty(
  $$ update storage.objects set name = name where bucket_id = 'tiles' and name = 'packs/new.pmtiles' returning 1 $$,
  'hq_admin: can replace tiles');
select isnt_empty(
  $$ delete from storage.objects where bucket_id = 'tiles' and name = 'packs/new.pmtiles' returning 1 $$,
  'hq_admin: can remove tiles');

-- -----------------------------------------------------------------------------
-- Revoked session and anon
-- -----------------------------------------------------------------------------
select tests.logout();
update public.profiles set active = false where id = tests.id('u_col_pemba');
select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select is_empty($$ select 1 from storage.objects $$, 'inactive profile: sees no object in any bucket');
select throws_ok(
  format($f$ insert into storage.objects (bucket_id, name) values ('imports', %L) $f$,
         tests.id('u_col_pemba')::text || '/upload-2.csv'),
  '42501', null, 'inactive profile: cannot upload');

select tests.login_anon();
select is_empty($$ select 1 from storage.objects $$, 'anon: sees no object (no policy applies to anon)');
select throws_ok(
  $$ insert into storage.objects (bucket_id, name) values ('tiles', 'packs/anon.pmtiles') $$,
  '42501', null, 'anon: cannot write objects');
select throws_ok(
  $$ insert into storage.objects (bucket_id, name) values ('photos', 'x') $$,
  '42501', null, 'anon: cannot write photos');

select tests.logout();

-- Policies on storage.objects created by this project target authenticated only.
select is_empty(
  $$ select policyname from pg_policies
     where schemaname = 'storage' and tablename = 'objects' and policyname like 'istiqama_%'
       and roles <> '{authenticated}' $$,
  'storage policies of this project apply to role authenticated only');
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname like 'istiqama_%'), 10,
  'ten storage policies are installed');

select * from finish();
rollback;

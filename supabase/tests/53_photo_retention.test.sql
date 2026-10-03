-- Photo retention: photos_to_purge / mark_photos_purged (brief §11: storage objects of
-- soft-deleted photos are removed after 90 days)
begin;
set local search_path = public, extensions, tests;

select plan(13);

select tests.fixture();

-- p_pemba_1: photo deleted 91 days ago  -> purgeable
-- p_pemba_2: photo deleted 10 days ago  -> not yet
-- p_tanga_1: live photo                 -> never
-- p_ke_1:    live photo, but the PROJECT was deleted 120 days ago -> purgeable
update public.project_photos set deleted_at = now() - interval '91 days' where id = tests.id('photo:p_pemba_1');
update public.project_photos set deleted_at = now() - interval '10 days' where id = tests.id('photo:p_pemba_2');
update public.projects set deleted_at = now() - interval '120 days' where id = tests.id('p_ke_1');

-- Service role only
select tests.login_as(tests.id('u_hq'));
select throws_ok('select * from public.photos_to_purge(10)', '42501', null, 'hq_admin cannot list photos to purge');
select throws_ok(format('select public.mark_photos_purged(array[%L]::uuid[])', tests.id('photo:p_pemba_1')), '42501', null,
                 'hq_admin cannot mark photos as purged');
select tests.logout();

select ok(exists (select 1 from public.photos_to_purge(1000) t where t.id = tests.id('photo:p_pemba_1')),
          'a photo deleted 91 days ago is purgeable');
select ok(not exists (select 1 from public.photos_to_purge(1000) t where t.id = tests.id('photo:p_pemba_2')),
          'a photo deleted 10 days ago is kept');
select ok(not exists (select 1 from public.photos_to_purge(1000) t where t.id = tests.id('photo:p_tanga_1')),
          'a live photo is never purgeable');
select ok(exists (select 1 from public.photos_to_purge(1000) t where t.id = tests.id('photo:p_ke_1')),
          'photos of a project deleted more than 90 days ago are purgeable');
select is((select t.bucket || ':' || t.storage_path_thumb from public.photos_to_purge(1000) t where t.id = tests.id('photo:p_pemba_1')),
          'photos:' || (select ph.storage_path_thumb from public.project_photos ph where ph.id = tests.id('photo:p_pemba_1')),
          'bucket and storage paths are returned');
select is((select count(*)::int from public.photos_to_purge(1)), 1, 'p_limit is honoured');

-- Marking: only eligible photos are stamped
select is(public.mark_photos_purged(array[tests.id('photo:p_pemba_1'), tests.id('photo:p_pemba_2'),
                                          tests.id('photo:p_tanga_1'), tests.id('photo:p_ke_1')]),
          2, 'mark_photos_purged stamps eligible photos only');
select ok((select ph.purged_at is not null from public.project_photos ph where ph.id = tests.id('photo:p_pemba_1'))
          and (select ph.purged_at is not null and ph.deleted_at is not null from public.project_photos ph where ph.id = tests.id('photo:p_ke_1')),
          'purged photos carry purged_at (and a tombstone)');
select ok((select ph.purged_at is null from public.project_photos ph where ph.id = tests.id('photo:p_pemba_2'))
          and (select ph.purged_at is null and ph.deleted_at is null from public.project_photos ph where ph.id = tests.id('photo:p_tanga_1')),
          'other photos are untouched');
select ok(not exists (select 1 from public.photos_to_purge(1000) t
                      where t.id in (tests.id('photo:p_pemba_1'), tests.id('photo:p_ke_1'))),
          'purged photos are not returned again');
select is(public.mark_photos_purged(array[tests.id('photo:p_pemba_1')]), 0, 'marking twice changes nothing');

select * from finish();
rollback;

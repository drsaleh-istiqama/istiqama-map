-- =============================================================================
-- 11  What each of the five roles may see and do through direct table access
--     (brief §3). Field data is read-only for every role: all writes go
--     through SECURITY DEFINER RPCs.
-- =============================================================================
begin;
set local search_path = public, extensions, tests;

select plan(288);

select tests.fixture_extra();

-- -----------------------------------------------------------------------------
-- hq_admin (global, AAL2): everything
-- -----------------------------------------------------------------------------
select tests.login_as(tests.id('u_hq'), 'aal2');

select is(tests.visible('projects', tests.fixture_projects()),
  tests.ids('p_pemba_1', 'p_pemba_2', 'p_tanga_1', 'p_ke_1'), 'hq_admin: all projects');
select is(tests.visible('persons', tests.kind_ids('person') || tests.kind_ids('person2')),
  tests.ids('person:p_pemba_1', 'person:p_pemba_2', 'person:p_tanga_1', 'person:p_ke_1',
            'person2:p_pemba_1', 'person2:p_ke_1'), 'hq_admin: all persons');
select is(tests.visible('project_staff', tests.kind_ids('staff')),
  tests.ids('staff:p_pemba_1', 'staff:p_pemba_2', 'staff:p_tanga_1', 'staff:p_ke_1'), 'hq_admin: all staff');
select is(tests.visible('project_photos', tests.kind_ids('photo')),
  tests.ids('photo:p_pemba_1', 'photo:p_pemba_2', 'photo:p_tanga_1', 'photo:p_ke_1'), 'hq_admin: all photos');
select is(tests.visible('project_maintenance', tests.kind_ids('maint')),
  tests.ids('maint:p_pemba_1', 'maint:p_pemba_2', 'maint:p_tanga_1', 'maint:p_ke_1'), 'hq_admin: all maintenance');
select is(tests.visible('project_land', tests.kind_ids('land')),
  tests.ids('land:p_pemba_1', 'land:p_pemba_2', 'land:p_tanga_1', 'land:p_ke_1'), 'hq_admin: all land rows');
select is(tests.visible('project_facilities', tests.kind_ids('fac')),
  tests.ids('fac:p_pemba_1', 'fac:p_pemba_2', 'fac:p_tanga_1', 'fac:p_ke_1'), 'hq_admin: all facilities rows');
select is(tests.visible('community_profiles', tests.kind_ids('community')),
  tests.ids('community:p_pemba_1', 'community:p_pemba_2', 'community:p_tanga_1', 'community:p_ke_1'),
  'hq_admin: all community profiles');
select is(tests.visible('project_donors', tests.kind_ids('pdonor')),
  tests.ids('pdonor:p_pemba_1', 'pdonor:p_pemba_2', 'pdonor:p_tanga_1', 'pdonor:p_ke_1'), 'hq_admin: all project donors');
select is(tests.visible('donors', tests.kind_ids('donor') || tests.ids('donor_unlinked')),
  tests.ids('donor:p_pemba_1', 'donor:p_pemba_2', 'donor:p_tanga_1', 'donor:p_ke_1', 'donor_unlinked'),
  'hq_admin: all donors');
select is(tests.visible('localities', tests.kind_ids('loc')),
  tests.ids('loc:tz_pemba_north', 'loc:tz_tanga', 'loc:ke_mombasa'), 'hq_admin: all localities');
select is(tests.visible('person_merge_requests', tests.kind_ids('merge')),
  tests.ids('merge:p_pemba_1', 'merge:p_ke_1'), 'hq_admin: all merge requests');
select is(
  tests.visible('sync_conflicts', tests.kind_ids('conflict') || tests.kind_ids('pconflict') || tests.kind_ids('lconflict')),
  tests.ids('conflict:p_pemba_1', 'conflict:p_pemba_2', 'conflict:p_tanga_1', 'conflict:p_ke_1',
            'pconflict:p_pemba_1', 'pconflict:p_ke_1',
            'lconflict:tz_pemba_north', 'lconflict:tz_tanga', 'lconflict:ke_mombasa'),
  'hq_admin: all sync conflicts');
select is(tests.visible('notifications', tests.kind_ids('notif')), tests.ids('notif:u_hq'),
  'hq_admin: notifications are personal, even for HQ');
select is(tests.visible('profiles', tests.fixture_users()), tests.ids(
  'u_hq', 'u_mgr_tz', 'u_mgr_ke', 'u_sup_pemba', 'u_col_pemba', 'u_col_pemba2', 'u_col_tanga', 'u_col_ke',
  'u_viewer_tz', 'u_viewer_global'), 'hq_admin: all profiles');
select is(
  (select count(*)::int from public.user_roles where user_id = any (tests.fixture_users())), 10,
  'hq_admin: all role grants');
select is(private.is_hq(), true, 'hq_admin: is_hq()');
select is(private.read_all() and private.people_all() and private.write_all() and private.review_all()
          and private.restricted_all(), true, 'hq_admin: every *_all() helper is true');

-- -----------------------------------------------------------------------------
-- country_manager (Tanzania, AAL2)
-- -----------------------------------------------------------------------------
select tests.login_as(tests.id('u_mgr_tz'), 'aal2');

select is(tests.visible('projects', tests.fixture_projects()),
  tests.ids('p_pemba_1', 'p_pemba_2', 'p_tanga_1'), 'country_manager: projects of the country');
select is(tests.visible('persons', tests.kind_ids('person') || tests.kind_ids('person2')),
  tests.ids('person:p_pemba_1', 'person:p_pemba_2', 'person:p_tanga_1', 'person2:p_pemba_1'),
  'country_manager: persons of the country');
select is(tests.visible('project_staff', tests.kind_ids('staff')),
  tests.ids('staff:p_pemba_1', 'staff:p_pemba_2', 'staff:p_tanga_1'), 'country_manager: staff of the country');
select is(tests.visible('project_photos', tests.kind_ids('photo')),
  tests.ids('photo:p_pemba_1', 'photo:p_pemba_2', 'photo:p_tanga_1'), 'country_manager: photos of the country');
select is(tests.visible('localities', tests.kind_ids('loc')),
  tests.ids('loc:tz_pemba_north', 'loc:tz_tanga'), 'country_manager: localities of the country');
select is(private.is_hq(), false, 'country_manager: is_hq() is false');
select is(private.read_countries(), array[tests.id('tz')], 'country_manager: read scope = the country');
select is(private.write_countries(), array[tests.id('tz')], 'country_manager: write scope = the country');
select is(private.review_countries(), array[tests.id('tz')], 'country_manager: review scope = the country');
select is(private.restricted_countries(), array[tests.id('tz')], 'country_manager: restricted scope = the country');
select is(private.restricted_all(), false, 'country_manager: restricted_all() is false');
select is(private.can_review(tests.id('tz'), tests.id('br_tanga')), true, 'country_manager: can review any branch of the country');
select is(private.can_review(tests.id('ke'), tests.id('br_mombasa')), false, 'country_manager: cannot review another country');

-- -----------------------------------------------------------------------------
-- branch_supervisor (Pemba, AAL1)
-- -----------------------------------------------------------------------------
select tests.login_as(tests.id('u_sup_pemba'), 'aal1');

select is(tests.visible('projects'), tests.ids('p_pemba_1', 'p_pemba_2'), 'branch_supervisor: projects of the branch');
select is(tests.visible('persons'), tests.ids('person:p_pemba_1', 'person:p_pemba_2', 'person2:p_pemba_1'),
  'branch_supervisor: persons of the branch');
select is(tests.visible('project_staff'), tests.ids('staff:p_pemba_1', 'staff:p_pemba_2'),
  'branch_supervisor: staff of the branch');
select is(tests.visible('person_merge_requests'), tests.ids('merge:p_pemba_1'),
  'branch_supervisor: merge requests of the branch');
select is(
  tests.visible('sync_conflicts', tests.kind_ids('conflict') || tests.kind_ids('pconflict')),
  tests.ids('conflict:p_pemba_1', 'conflict:p_pemba_2', 'pconflict:p_pemba_1'),
  'branch_supervisor: project and person conflicts of the branch');
select is(tests.visible('sync_conflicts', tests.kind_ids('lconflict')),
  tests.ids('lconflict:tz_pemba_north', 'lconflict:tz_tanga'),
  'branch_supervisor: locality conflicts of the country of the branch');
select is(tests.visible('profiles'), tests.ids('u_sup_pemba'), 'branch_supervisor: own profile only');
select is(private.can_review(tests.id('tz'), tests.id('br_pemba')), true, 'branch_supervisor: can review the own branch');
select is(private.can_review(tests.id('tz'), tests.id('br_tanga')), false, 'branch_supervisor: cannot review another branch');
select is(private.can_see_restricted(tests.id('tz')), false, 'branch_supervisor: no restricted data');
select is(private.review_branches(), array[tests.id('br_pemba')], 'branch_supervisor: review scope = the branch');

-- -----------------------------------------------------------------------------
-- field_collector (Pemba, AAL1)
-- -----------------------------------------------------------------------------
select tests.login_as(tests.id('u_col_pemba'), 'aal1');

select is(tests.visible('projects'), tests.ids('p_pemba_1', 'p_pemba_2'), 'field_collector: projects of the branch');
select is(tests.visible('persons'), tests.ids('person:p_pemba_1', 'person:p_pemba_2', 'person2:p_pemba_1'),
  'field_collector: persons of the branch');
select is(tests.visible('person_merge_requests'), '{}'::uuid[], 'field_collector: no merge requests');
select is(tests.visible('sync_conflicts'), '{}'::uuid[], 'field_collector: no sync conflicts');
select is(private.can_write_project(tests.id('tz'), tests.id('br_pemba')), true, 'field_collector: can write in the branch');
select is(private.can_write_project(tests.id('tz'), tests.id('br_tanga')), false, 'field_collector: cannot write in another branch');
select is(private.can_review(tests.id('tz'), tests.id('br_pemba')), false, 'field_collector: cannot review');
select is(private.review_branches(), '{}'::uuid[], 'field_collector: empty review scope');
select is(private.write_branches(), array[tests.id('br_pemba')], 'field_collector: write scope = the branch');

-- -----------------------------------------------------------------------------
-- viewer (Tanzania / global): projects and public children, never people
-- -----------------------------------------------------------------------------
select tests.login_as(tests.id('u_viewer_tz'), 'aal1');

-- a viewer sees approved projects only (owner decision ح; p_pemba_2 is a draft)
select is(tests.visible('projects', tests.fixture_projects()),
  tests.ids('p_pemba_1', 'p_tanga_1'), 'viewer (TZ): approved projects of the country');
select is(tests.visible('project_photos', tests.kind_ids('photo')),
  tests.ids('photo:p_pemba_1', 'photo:p_tanga_1'), 'viewer (TZ): photos of the approved projects');
select is(tests.visible('project_maintenance', tests.kind_ids('maint')),
  tests.ids('maint:p_pemba_1', 'maint:p_tanga_1'), 'viewer (TZ): maintenance of the approved projects');
select is(tests.visible('community_profiles', tests.kind_ids('community')),
  tests.ids('community:p_pemba_1', 'community:p_tanga_1'), 'viewer (TZ): community profiles of the approved projects');
select is(tests.visible('donors', tests.kind_ids('donor') || tests.ids('donor_unlinked')),
  tests.ids('donor:p_pemba_1', 'donor:p_tanga_1'), 'viewer (TZ): donors of the country''s approved projects');
select is(tests.visible('persons'), '{}'::uuid[], 'viewer (TZ): no persons (names, phones)');
select is_empty($$ select phone_e164 from public.persons $$, 'viewer (TZ): no phone numbers');
select is(tests.visible('project_staff'), '{}'::uuid[], 'viewer (TZ): no staff');
select is(tests.visible('person_merge_requests'), '{}'::uuid[], 'viewer (TZ): no merge requests');
select is(tests.visible('sync_conflicts'), '{}'::uuid[], 'viewer (TZ): no sync conflicts');
select throws_ok($$ select * from public.staff_compensation $$, '42501', null, 'viewer (TZ): no salaries');
select throws_ok($$ select * from public.community_sensitive $$, '42501', null, 'viewer (TZ): no sensitive community data');
select is(private.people_all(), false, 'viewer (TZ): people_all() is false');
select is(private.people_countries(), '{}'::uuid[], 'viewer (TZ): empty people scope');
select is(private.write_countries(), '{}'::uuid[], 'viewer (TZ): empty write scope');
select is(private.can_see_people(tests.id('tz'), tests.id('br_pemba')), false, 'viewer (TZ): can_see_people() is false');
select is(private.can_write_project(tests.id('tz'), tests.id('br_pemba')), false, 'viewer (TZ): can_write_project() is false');
select is(private.can_read_project(tests.id('tz'), null), true, 'viewer (TZ): can_read_project() is true in the country');

select tests.login_as(tests.id('u_viewer_global'), 'aal1');

select is(tests.visible('projects', tests.fixture_projects()),
  tests.ids('p_pemba_1', 'p_tanga_1', 'p_ke_1'), 'viewer (global): all approved projects');
select is(tests.visible('donors', tests.kind_ids('donor') || tests.ids('donor_unlinked')),
  tests.ids('donor:p_pemba_1', 'donor:p_pemba_2', 'donor:p_tanga_1', 'donor:p_ke_1', 'donor_unlinked'),
  'viewer (global): all donors (donor relations)');
select is(tests.visible('persons'), '{}'::uuid[], 'viewer (global): no persons');
select is(tests.visible('project_staff'), '{}'::uuid[], 'viewer (global): no staff');
select is(private.read_all(), true, 'viewer (global): read_all() is true');
select is(private.people_all() or private.write_all() or private.review_all() or private.restricted_all(), false,
  'viewer (global): no other capability');

-- -----------------------------------------------------------------------------
-- Direct INSERT / UPDATE / DELETE on field data fails for every role
-- (5 roles x 14 tables x 3 statements = 210 assertions)
-- -----------------------------------------------------------------------------
select tests.logout();

create temporary table _field_tables on commit drop as
select t
from unnest(array[
  'projects', 'project_land', 'project_facilities', 'project_maintenance', 'project_photos',
  'donors', 'project_donors', 'persons', 'project_staff', 'person_merge_requests',
  'localities', 'community_profiles', 'sync_conflicts', 'notifications'
]) as t;
grant select on _field_tables to public;

-- hq_admin
select tests.login_as(tests.id('u_hq'), 'aal2');
select throws_ok(format('insert into public.%I default values', t), '42501', null,
  format('hq_admin: direct INSERT into %s is refused', t)) from _field_tables order by t;
select throws_ok(format('update public.%I set deleted_at = now()', t), '42501', null,
  format('hq_admin: direct UPDATE of %s is refused', t)) from _field_tables order by t;
select throws_ok(format('delete from public.%I', t), '42501', null,
  format('hq_admin: direct DELETE from %s is refused', t)) from _field_tables order by t;

-- country_manager
select tests.login_as(tests.id('u_mgr_tz'), 'aal2');
select throws_ok(format('insert into public.%I default values', t), '42501', null,
  format('country_manager: direct INSERT into %s is refused', t)) from _field_tables order by t;
select throws_ok(format('update public.%I set deleted_at = now()', t), '42501', null,
  format('country_manager: direct UPDATE of %s is refused', t)) from _field_tables order by t;
select throws_ok(format('delete from public.%I', t), '42501', null,
  format('country_manager: direct DELETE from %s is refused', t)) from _field_tables order by t;

-- branch_supervisor
select tests.login_as(tests.id('u_sup_pemba'), 'aal1');
select throws_ok(format('insert into public.%I default values', t), '42501', null,
  format('branch_supervisor: direct INSERT into %s is refused', t)) from _field_tables order by t;
select throws_ok(format('update public.%I set deleted_at = now()', t), '42501', null,
  format('branch_supervisor: direct UPDATE of %s is refused', t)) from _field_tables order by t;
select throws_ok(format('delete from public.%I', t), '42501', null,
  format('branch_supervisor: direct DELETE from %s is refused', t)) from _field_tables order by t;

-- field_collector
select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select throws_ok(format('insert into public.%I default values', t), '42501', null,
  format('field_collector: direct INSERT into %s is refused', t)) from _field_tables order by t;
select throws_ok(format('update public.%I set deleted_at = now()', t), '42501', null,
  format('field_collector: direct UPDATE of %s is refused', t)) from _field_tables order by t;
select throws_ok(format('delete from public.%I', t), '42501', null,
  format('field_collector: direct DELETE from %s is refused', t)) from _field_tables order by t;

-- viewer
select tests.login_as(tests.id('u_viewer_tz'), 'aal1');
select throws_ok(format('insert into public.%I default values', t), '42501', null,
  format('viewer: direct INSERT into %s is refused', t)) from _field_tables order by t;
select throws_ok(format('update public.%I set deleted_at = now()', t), '42501', null,
  format('viewer: direct UPDATE of %s is refused', t)) from _field_tables order by t;
select throws_ok(format('delete from public.%I', t), '42501', null,
  format('viewer: direct DELETE from %s is refused', t)) from _field_tables order by t;

-- A realistic attempt: the collector tries to approve its own draft and to
-- move a project into its scope.
select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select throws_ok(
  $$ update public.projects set record_state = 'approved' where id = tests.id('p_pemba_2') $$,
  '42501', null, 'field_collector: cannot approve a draft by direct UPDATE');
select throws_ok(
  $$ update public.projects set branch_id = tests.id('br_pemba') where id = tests.id('p_tanga_1') $$,
  '42501', null, 'field_collector: cannot pull a foreign project into its branch');

select tests.logout();
select is(
  (select record_state from public.projects where id = tests.id('p_pemba_2')), 'draft',
  'the draft is still a draft');

select * from finish();
rollback;

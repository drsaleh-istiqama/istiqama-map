-- =============================================================================
-- 10  Scope isolation through direct table access (brief §3, acceptance
--     criterion 5): a field collector in Kenya cannot read any record of
--     Tanzania and no salary at all; branches of one country are isolated from
--     each other; country-scoped roles never cross the border.
--
-- All assertions are written against fixture ids, so they hold whether or not
-- other data (reference data, staging seed) exists in the database.
-- =============================================================================
begin;
set local search_path = public, extensions, tests;

select plan(95);

select tests.fixture_extra();

-- -----------------------------------------------------------------------------
-- A. Kenya field collector (branch br_mombasa, AAL1)
-- -----------------------------------------------------------------------------
select tests.login_as(tests.id('u_col_ke'), 'aal1');

select is(tests.visible('projects'), tests.ids('p_ke_1'),
  'KE collector: sees exactly the project of its branch');
select is_empty(
  $$ select 1 from public.projects where country_id = tests.id('tz') $$,
  'KE collector: no project with country = Tanzania');
select is_empty(
  $$ select 1 from public.projects where id = any (tests.ids('p_pemba_1', 'p_pemba_2', 'p_tanga_1')) $$,
  'KE collector: Tanzanian projects are not reachable by id');
select is_empty(
  $$ select 1 from public.projects where branch_id in (tests.id('br_pemba'), tests.id('br_tanga')) $$,
  'KE collector: no project of a Tanzanian branch');

-- every table that hangs off a project: nothing of the three Tanzanian projects
select is_empty(
  format(
    'select 1 from public.%I where project_id = any (tests.ids(''p_pemba_1'', ''p_pemba_2'', ''p_tanga_1''))', t),
  format('KE collector: no Tanzanian row in %s', t))
from unnest(array[
  'project_land', 'project_facilities', 'project_maintenance', 'project_photos',
  'project_donors', 'community_profiles', 'project_staff'
]) as t;

-- ... and exactly the rows of its own project
select is(tests.visible('project_land'), tests.ids('land:p_ke_1'), 'KE collector: project_land of own project only');
select is(tests.visible('project_facilities'), tests.ids('fac:p_ke_1'), 'KE collector: project_facilities of own project only');
select is(tests.visible('project_maintenance'), tests.ids('maint:p_ke_1'), 'KE collector: project_maintenance of own project only');
select is(tests.visible('project_photos'), tests.ids('photo:p_ke_1'), 'KE collector: project_photos of own project only');
select is(tests.visible('project_donors'), tests.ids('pdonor:p_ke_1'), 'KE collector: project_donors of own project only');
select is(tests.visible('community_profiles'), tests.ids('community:p_ke_1'), 'KE collector: community_profiles of own project only');
select is(tests.visible('project_staff'), tests.ids('staff:p_ke_1'), 'KE collector: project_staff of own project only');

select is(tests.visible('persons'), tests.ids('person:p_ke_1', 'person2:p_ke_1'),
  'KE collector: persons of its branch only');
select is_empty(
  $$ select 1 from public.persons where country_id = tests.id('tz') $$,
  'KE collector: no person of Tanzania');
select is_empty(
  $$ select 1 from public.persons where phone_e164 like '+255%' $$,
  'KE collector: no Tanzanian phone number');

select is_empty(
  $$ select 1 from public.localities where country_id = tests.id('tz') $$,
  'KE collector: no locality of Tanzania');
select is(tests.visible('localities', tests.kind_ids('loc')), tests.ids('loc:ke_mombasa'),
  'KE collector: sees the Kenyan fixture locality');

select is(tests.visible('donors'), tests.ids('donor:p_ke_1'),
  'KE collector: only the donor linked to its project');

select is(tests.visible('person_merge_requests'), '{}'::uuid[], 'KE collector: no merge requests (supervisor+)');
select is(tests.visible('sync_conflicts'), '{}'::uuid[], 'KE collector: no sync conflicts (supervisor+)');
select is(tests.visible('notifications'), tests.ids('notif:u_col_ke'), 'KE collector: own notifications only');
select is(tests.visible('export_jobs'), tests.ids('export:u_col_ke'), 'KE collector: own export jobs only');
select is(tests.visible('import_batches'), tests.ids('import:u_col_ke'), 'KE collector: own import batches only');
select is(tests.visible('import_rows'), tests.ids('importrow:u_col_ke'), 'KE collector: own import rows only');
select is(tests.visible('profiles'), tests.ids('u_col_ke'), 'KE collector: own profile only');
select is(tests.visible('devices'), tests.ids('device:u_col_ke'), 'KE collector: own devices only');
select is_empty(
  $$ select 1 from public.user_roles where user_id <> auth.uid() $$,
  'KE collector: no role grant of another user');

-- salaries and sensitive data: no access at all, not even for the own country
select throws_ok(
  $$ select * from public.staff_compensation $$, '42501', null,
  'KE collector: staff_compensation is not readable');
select throws_ok(
  $$ select monthly_amount from public.staff_compensation where id = tests.id('comp:p_ke_1') $$, '42501', null,
  'KE collector: not even the salary of its own project');
select throws_ok(
  $$ select count(*) from public.staff_compensation $$, '42501', null,
  'KE collector: cannot count salaries');
select throws_ok(
  $$ select s.id from public.project_staff s join public.staff_compensation c on c.project_staff_id = s.id $$,
  '42501', null,
  'KE collector: cannot reach salaries through a join');
select throws_ok(
  $$ select * from public.community_sensitive $$, '42501', null,
  'KE collector: community_sensitive is not readable');

-- the logs contain old/new images of every row, including restricted ones
select is_empty($$ select 1 from public.audit_log $$, 'KE collector: audit_log shows nothing');
select is_empty($$ select 1 from public.restricted_access_log $$, 'KE collector: restricted_access_log shows nothing');
select throws_ok($$ select 1 from public.sync_applied_ops $$, '42501', null,
  'KE collector: sync_applied_ops is not readable');

-- scope helpers agree
select is(private.read_all(), false, 'KE collector: read_all() is false');
select is(private.read_countries(), '{}'::uuid[], 'KE collector: no country scope');
select is(private.read_branches(), array[tests.id('br_mombasa')], 'KE collector: branch scope = Mombasa');
select is(private.can_read_project(tests.id('tz'), tests.id('br_pemba')), false,
  'KE collector: can_read_project(TZ, Pemba) is false');
select is(private.can_read_project(tests.id('ke'), tests.id('br_mombasa')), true,
  'KE collector: can_read_project(KE, Mombasa) is true');
select is(private.can_see_restricted(tests.id('ke')), false,
  'KE collector: can_see_restricted(KE) is false');
select is(private.restricted_countries(), '{}'::uuid[], 'KE collector: no restricted scope');

-- -----------------------------------------------------------------------------
-- B. Pemba collector: other branches of the same country are invisible
-- -----------------------------------------------------------------------------
select tests.login_as(tests.id('u_col_pemba'), 'aal1');

select is(tests.visible('projects'), tests.ids('p_pemba_1', 'p_pemba_2'),
  'Pemba collector: sees exactly the projects of its branch (including the draft)');
select is_empty(
  $$ select 1 from public.projects where id = tests.id('p_tanga_1') $$,
  'Pemba collector: the Tanga project is not reachable');
select is_empty(
  $$ select 1 from public.projects where country_id = tests.id('ke') $$,
  'Pemba collector: no Kenyan project');
select is(tests.visible('project_photos'), tests.ids('photo:p_pemba_1', 'photo:p_pemba_2'),
  'Pemba collector: photos of its branch only');
select is(tests.visible('project_maintenance'), tests.ids('maint:p_pemba_1', 'maint:p_pemba_2'),
  'Pemba collector: maintenance of its branch only');
select is(tests.visible('project_staff'), tests.ids('staff:p_pemba_1', 'staff:p_pemba_2'),
  'Pemba collector: staff of its branch only');
select is(tests.visible('persons'), tests.ids('person:p_pemba_1', 'person:p_pemba_2', 'person2:p_pemba_1'),
  'Pemba collector: persons of its branch only');
select is(tests.visible('donors'), tests.ids('donor:p_pemba_1', 'donor:p_pemba_2', 'donor_unlinked'),
  'Pemba collector: donors of its projects + the donor it created');
select is(tests.visible('community_profiles'), tests.ids('community:p_pemba_1', 'community:p_pemba_2'),
  'Pemba collector: community profiles of its branch only');
select is(tests.visible('localities', tests.kind_ids('loc')), tests.ids('loc:tz_pemba_north', 'loc:tz_tanga'),
  'Pemba collector: localities of its country (reference data), not of Kenya');
select throws_ok($$ select * from public.staff_compensation $$, '42501', null,
  'Pemba collector: staff_compensation is not readable');
select throws_ok($$ select * from public.community_sensitive $$, '42501', null,
  'Pemba collector: community_sensitive is not readable');

-- the second collector of the branch sees the same projects, but not the
-- unlinked donor of a colleague and nobody else's notifications
select tests.login_as(tests.id('u_col_pemba2'), 'aal1');
select is(tests.visible('projects'), tests.ids('p_pemba_1', 'p_pemba_2'),
  'Second Pemba collector: same branch, same projects');
select is(tests.visible('donors'), tests.ids('donor:p_pemba_1', 'donor:p_pemba_2'),
  'Second Pemba collector: not the unlinked donor created by a colleague');
select is(tests.visible('notifications'), '{}'::uuid[],
  'Second Pemba collector: no notifications of other users');
select is(tests.visible('export_jobs'), '{}'::uuid[],
  'Second Pemba collector: no export jobs of other users');

-- -----------------------------------------------------------------------------
-- C. Tanga collector
-- -----------------------------------------------------------------------------
select tests.login_as(tests.id('u_col_tanga'), 'aal1');

select is(tests.visible('projects'), tests.ids('p_tanga_1'), 'Tanga collector: sees exactly its project');
select is(tests.visible('persons'), tests.ids('person:p_tanga_1'), 'Tanga collector: persons of its branch only');
select is(tests.visible('project_photos'), tests.ids('photo:p_tanga_1'), 'Tanga collector: photos of its branch only');
select is_empty(
  $$ select 1 from public.projects where branch_id = tests.id('br_pemba') $$,
  'Tanga collector: no Pemba project');

-- -----------------------------------------------------------------------------
-- D. Country manager of Tanzania (AAL2): everything in Tanzania, nothing of Kenya
-- -----------------------------------------------------------------------------
select tests.login_as(tests.id('u_mgr_tz'), 'aal2');

select is(tests.visible('projects', tests.fixture_projects()), tests.ids('p_pemba_1', 'p_pemba_2', 'p_tanga_1'),
  'TZ manager: all Tanzanian fixture projects');
select is_empty(
  $$ select 1 from public.projects where country_id is distinct from tests.id('tz') $$,
  'TZ manager: no project outside Tanzania');
select is_empty(
  $$ select 1 from public.persons where country_id is distinct from tests.id('tz') $$,
  'TZ manager: no person outside Tanzania');
select is_empty(
  format('select 1 from public.%I where project_id = tests.id(''p_ke_1'')', t),
  format('TZ manager: no Kenyan row in %s', t))
from unnest(array[
  'project_land', 'project_facilities', 'project_maintenance', 'project_photos',
  'project_donors', 'community_profiles', 'project_staff'
]) as t;
select is_empty(
  $$ select 1 from public.localities where country_id is distinct from tests.id('tz') $$,
  'TZ manager: no locality outside Tanzania');
select is(tests.visible('person_merge_requests', tests.kind_ids('merge')), tests.ids('merge:p_pemba_1'),
  'TZ manager: merge requests of Tanzania only');
select is(
  tests.visible('sync_conflicts', tests.kind_ids('conflict') || tests.kind_ids('pconflict') || tests.kind_ids('lconflict')),
  tests.ids('conflict:p_pemba_1', 'conflict:p_pemba_2', 'conflict:p_tanga_1', 'pconflict:p_pemba_1',
            'lconflict:tz_pemba_north', 'lconflict:tz_tanga'),
  'TZ manager: sync conflicts of Tanzania only');
select is(tests.visible('donors', tests.kind_ids('donor') || tests.ids('donor_unlinked')),
  tests.ids('donor:p_pemba_1', 'donor:p_pemba_2', 'donor:p_tanga_1'),
  'TZ manager: donors linked to Tanzanian projects only');
select is(
  tests.visible('profiles', tests.fixture_users()),
  tests.ids('u_mgr_tz', 'u_sup_pemba', 'u_col_pemba', 'u_col_pemba2', 'u_col_tanga', 'u_viewer_tz'),
  'TZ manager: profiles of users scoped to Tanzania only');
select is_empty(
  $$ select 1 from public.user_roles where user_id in (tests.id('u_mgr_ke'), tests.id('u_col_ke'), tests.id('u_hq'), tests.id('u_viewer_global')) $$,
  'TZ manager: no role grants of Kenyan or global users');
-- restricted tables stay closed to direct SQL even for the manager
select throws_ok($$ select * from public.staff_compensation $$, '42501', null,
  'TZ manager: staff_compensation is not readable by direct SQL');
select throws_ok($$ select * from public.community_sensitive $$, '42501', null,
  'TZ manager: community_sensitive is not readable by direct SQL');
select is(private.can_see_restricted(tests.id('tz')), true, 'TZ manager: can_see_restricted(TZ) is true');
select is(private.can_see_restricted(tests.id('ke')), false, 'TZ manager: can_see_restricted(KE) is false');

-- -----------------------------------------------------------------------------
-- E. Country manager of Kenya (AAL2)
-- -----------------------------------------------------------------------------
select tests.login_as(tests.id('u_mgr_ke'), 'aal2');

select is(tests.visible('projects', tests.fixture_projects()), tests.ids('p_ke_1'),
  'KE manager: the Kenyan fixture project');
select is_empty(
  $$ select 1 from public.projects where country_id is distinct from tests.id('ke') $$,
  'KE manager: no project outside Kenya');
select is_empty(
  $$ select 1 from public.persons where country_id is distinct from tests.id('ke') $$,
  'KE manager: no person outside Kenya');
select is(
  tests.visible('profiles', tests.fixture_users()), tests.ids('u_mgr_ke', 'u_col_ke'),
  'KE manager: profiles of users scoped to Kenya only');

-- -----------------------------------------------------------------------------
-- F. Viewer of Tanzania
-- -----------------------------------------------------------------------------
select tests.login_as(tests.id('u_viewer_tz'), 'aal1');

-- approved projects only (owner decision ح: p_pemba_2 is a draft)
select is(tests.visible('projects', tests.fixture_projects()), tests.ids('p_pemba_1', 'p_tanga_1'),
  'TZ viewer: approved Tanzanian fixture projects');
select is_empty(
  $$ select 1 from public.projects where country_id is distinct from tests.id('tz') $$,
  'TZ viewer: no project outside Tanzania');
select is_empty(
  $$ select 1 from public.project_photos where project_id = tests.id('p_ke_1') $$,
  'TZ viewer: no Kenyan photo');

select tests.logout();
select * from finish();
rollback;

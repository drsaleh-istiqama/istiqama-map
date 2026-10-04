-- =============================================================================
-- 0013  RLS: field data (brief §3; ARCHITECTURE §2.3)
--
-- authenticated has SELECT only on these tables (0011); every write goes
-- through sync_push / import / merge RPCs (SECURITY DEFINER). The policies
-- below therefore are SELECT policies only:
--
--   projects                         read scope   (any role)
--   project_land / _facilities / _maintenance / _photos, project_donors,
--   community_profiles               read scope of the parent project
--   persons                          people scope (any role except viewer)
--   project_staff                    people scope of the parent project
--   localities                       countries reachable through the read scope
--   donors                           global readers; donors linked to a project
--                                    in the read scope; donors created by the caller
--   person_merge_requests            review scope of either person (supervisor+)
--   sync_conflicts                   review scope of the affected row (supervisor+)
--   notifications                    own rows
--
-- Scope rule (Appendix A.3): global matches everything, a country scope matches
-- country_id, a branch scope matches branch_id.
--
-- Unreviewed records (owner decision, interim — docs/OWNER_DECISIONS.md "أسئلة
-- فرعية" ح): a project whose record_state is not 'approved' (draft, submitted,
-- returned) and every row below it are visible only in the PEOPLE scope, i.e.
-- to every role except viewer. A viewer serves donor relations ("public
-- reports", brief §3) and sees approved projects only; a user with a viewer
-- grant AND another role sees unreviewed records where the other role reaches.
-- The same rule is applied by sync_pull, search, projects_page, tile_projects,
-- the dashboard, the report_* functions and the export.
--
-- Shape of every scope predicate:
--     (select private.x_all())
--     or country_id = any ((select private.x_countries())::uuid[])
--     or branch_id  = any ((select private.x_branches())::uuid[])
-- The three sub-selects are InitPlans: evaluated at most once per statement.
-- Child tables probe public.projects by primary key inside EXISTS; the RLS of
-- projects itself also applies inside those sub-queries (they run as the
-- caller), so a child row can never be visible when its project is not.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- projects
-- -----------------------------------------------------------------------------
drop policy if exists projects_select on public.projects;
create policy projects_select on public.projects
  for select to authenticated
  using (
    (
      (select private.read_all())
      or country_id = any ((select private.read_countries())::uuid[])
      or branch_id = any ((select private.read_branches())::uuid[])
    )
    -- unreviewed records: people scope only (never for a viewer)
    and (
      record_state = 'approved'
      or (select private.people_all())
      or country_id = any ((select private.people_countries())::uuid[])
      or branch_id = any ((select private.people_branches())::uuid[])
    )
  );

-- -----------------------------------------------------------------------------
-- Children of a project that every reader of the project may see (a viewer:
-- only children of approved projects). A global non-viewer reader skips the
-- probe; everybody else probes the parent, whose own policy applies as well.
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'project_land', 'project_facilities', 'project_maintenance', 'project_photos',
    'project_donors', 'community_profiles'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format(
      'create policy %1$I on public.%2$I for select to authenticated using ('
      '  (select private.people_all())'
      '  or exists ('
      '    select 1 from public.projects p'
      '    where p.id = %2$I.project_id'
      '      and ((select private.read_all())'
      '        or p.country_id = any ((select private.read_countries())::uuid[])'
      '        or p.branch_id = any ((select private.read_branches())::uuid[]))'
      '      and (p.record_state = ''approved'''
      '        or p.country_id = any ((select private.people_countries())::uuid[])'
      '        or p.branch_id = any ((select private.people_branches())::uuid[]))))',
      t || '_select', t);
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- People: never visible to viewer
-- -----------------------------------------------------------------------------
drop policy if exists persons_select on public.persons;
create policy persons_select on public.persons
  for select to authenticated
  using (
    (select private.people_all())
    or country_id = any ((select private.people_countries())::uuid[])
    or branch_id = any ((select private.people_branches())::uuid[])
  );

drop policy if exists project_staff_select on public.project_staff;
create policy project_staff_select on public.project_staff
  for select to authenticated
  using (
    (select private.people_all())
    or exists (
      select 1
      from public.projects p
      where p.id = project_staff.project_id
        and (p.country_id = any ((select private.people_countries())::uuid[])
          or p.branch_id = any ((select private.people_branches())::uuid[]))
    )
  );

-- Merge requests: supervisors and above, when either person is in their scope.
drop policy if exists person_merge_requests_select on public.person_merge_requests;
create policy person_merge_requests_select on public.person_merge_requests
  for select to authenticated
  using (
    (select private.review_all())
    or exists (
      select 1
      from public.persons s
      where s.id in (person_merge_requests.source_person_id, person_merge_requests.target_person_id)
        and (s.country_id = any ((select private.review_countries())::uuid[])
          or s.branch_id = any ((select private.review_branches())::uuid[]))
    )
  );

-- -----------------------------------------------------------------------------
-- localities: geographic reference data entered in the field. A locality has a
-- country but no branch, so a branch-scoped role sees the localities of the
-- country its branch belongs to.
-- -----------------------------------------------------------------------------
drop policy if exists localities_select on public.localities;
create policy localities_select on public.localities
  for select to authenticated
  using (
    (select private.read_all())
    or country_id = any ((select private.read_countries())::uuid[])
    or country_id in (
      select b.country_id
      from public.branches b
      where b.id = any ((select private.read_branches())::uuid[]))
  );

-- -----------------------------------------------------------------------------
-- donors: have no country/branch of their own. Visible to global readers
-- (a global viewer included), to anybody who can read a project the donor is
-- linked to (for a viewer: an approved project), and to their creator (a donor
-- entered in the field before it is linked to a project).
-- -----------------------------------------------------------------------------
drop policy if exists donors_select on public.donors;
create policy donors_select on public.donors
  for select to authenticated
  using (
    (select private.read_all())
    or (created_by = (select auth.uid()) and (select private.session_ok()))
    or exists (
      select 1
      from public.project_donors pd
      join public.projects p on p.id = pd.project_id
      where pd.donor_id = donors.id
        and (p.country_id = any ((select private.read_countries())::uuid[])
          or p.branch_id = any ((select private.read_branches())::uuid[]))
        and (p.record_state = 'approved'
          or p.country_id = any ((select private.people_countries())::uuid[])
          or p.branch_id = any ((select private.people_branches())::uuid[]))
    )
  );

-- -----------------------------------------------------------------------------
-- sync_conflicts: supervisors and above, for rows inside their review scope.
-- Conflicts carry project_id for projects and their children; conflicts on
-- persons and localities are resolved through the row itself; anything else is
-- visible to global reviewers only. Conflicts on the restricted tables are
-- invisible to everybody here.
-- -----------------------------------------------------------------------------
drop policy if exists sync_conflicts_select on public.sync_conflicts;
create policy sync_conflicts_select on public.sync_conflicts
  for select to authenticated
  using (
    -- server_value / client_value of a conflict on a restricted table are
    -- restricted data: never through direct SQL (logged RPCs only).
    table_name not in ('staff_compensation', 'community_sensitive')
    and (
      (select private.review_all())
      or (project_id is not null and exists (
        select 1
        from public.projects p
        where p.id = sync_conflicts.project_id
          and (p.country_id = any ((select private.review_countries())::uuid[])
            or p.branch_id = any ((select private.review_branches())::uuid[]))))
      or (table_name = 'persons' and exists (
        select 1
        from public.persons s
        where s.id = sync_conflicts.row_id
          and (s.country_id = any ((select private.review_countries())::uuid[])
            or s.branch_id = any ((select private.review_branches())::uuid[]))))
      or (table_name = 'localities' and exists (
        select 1
        from public.localities l
        where l.id = sync_conflicts.row_id
          and (l.country_id = any ((select private.review_countries())::uuid[])
            or l.country_id in (
              select b.country_id
              from public.branches b
              where b.id = any ((select private.review_branches())::uuid[])))))
    )
  );

-- -----------------------------------------------------------------------------
-- notifications: own rows only
-- -----------------------------------------------------------------------------
drop policy if exists notifications_select_own on public.notifications;
create policy notifications_select_own on public.notifications
  for select to authenticated
  using (user_id = (select auth.uid()) and (select private.session_ok()));

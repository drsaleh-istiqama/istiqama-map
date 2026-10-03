-- =============================================================================
-- 16  Catalog-level guarantees for the WHOLE database (every migration, not
--     only 0010-0019): Appendix A.1 of docs/ARCHITECTURE.md.
--
--   * RLS enabled and forced on every table of schema public;
--   * anon holds nothing: no table, sequence or function privilege;
--   * authenticated holds exactly the privileges of docs/contracts/authz.md;
--   * every policy targets role authenticated; field tables have SELECT
--     policies only;
--   * the Appendix A.3 helpers exist with the agreed signatures and are
--     STABLE + SECURITY DEFINER with a pinned search_path.
--
-- A NEW TABLE IN SCHEMA public MAKES THIS FILE FAIL until it is classified in
-- docs/contracts/authz.md and added to the lists below. That is intended.
-- =============================================================================
begin;
set local search_path = public, extensions, tests;

select plan(60);

-- Relations of schema public that do not belong to an extension.
create temporary view _public_rels as
select c.oid, c.relname::text as relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
  and not exists (
    select 1 from pg_depend d
    where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e');

create temporary view _public_funcs as
select p.oid, p.oid::regprocedure::text as signature
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and not exists (
    select 1 from pg_depend d
    where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e');

-- -----------------------------------------------------------------------------
-- 1. Tables of the contract exist; RLS everywhere
-- -----------------------------------------------------------------------------
select is_empty(
  $$ select t from unnest(array[
       'countries', 'admin_areas', 'localities', 'branches', 'projects', 'project_land',
       'project_facilities', 'project_maintenance', 'project_photos', 'donors', 'project_donors',
       'persons', 'person_merge_requests', 'project_staff', 'staff_compensation', 'fx_rates',
       'option_values', 'community_profiles', 'community_sensitive', 'profiles', 'user_roles',
       'devices', 'audit_log', 'sync_conflicts', 'sync_applied_ops', 'restricted_access_log',
       'export_jobs', 'notifications', 'import_batches', 'import_rows', 'map_packs', 'app_settings'
     ]) as t
     where to_regclass('public.' || t) is null $$,
  'every table of the contract exists');

select is_empty(
  $$ select relname from _public_rels
     where relkind in ('r', 'p') and not (relrowsecurity and relforcerowsecurity) order by 1 $$,
  'RLS is enabled AND forced on every table of schema public');

-- -----------------------------------------------------------------------------
-- 2. anon: nothing at all
-- -----------------------------------------------------------------------------
select is_empty(
  $$ select r.relname, p.priv
     from _public_rels r
     cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) as p (priv)
     where r.relkind <> 'S' and has_table_privilege('anon', r.oid, p.priv)
     order by 1, 2 $$,
  'anon holds no privilege on any table, view or materialized view of schema public');

select is_empty(
  $$ select r.relname
     from _public_rels r
     where r.relkind <> 'S'
       and (has_any_column_privilege('anon', r.oid, 'SELECT')
         or has_any_column_privilege('anon', r.oid, 'INSERT')
         or has_any_column_privilege('anon', r.oid, 'UPDATE'))
     order by 1 $$,
  'anon holds no column privilege in schema public');

select is_empty(
  $$ select r.relname
     from _public_rels r
     where r.relkind = 'S'
       and (has_sequence_privilege('anon', r.oid, 'USAGE') or has_sequence_privilege('anon', r.oid, 'SELECT')
         or has_sequence_privilege('anon', r.oid, 'UPDATE'))
     order by 1 $$,
  'anon holds no privilege on any sequence of schema public');

select is_empty(
  $$ select f.signature from _public_funcs f where has_function_privilege('anon', f.oid, 'EXECUTE') order by 1 $$,
  'anon cannot execute any function of schema public (every RPC revokes from public and anon)');

select is(has_schema_privilege('anon', 'private', 'USAGE'), false, 'anon has no USAGE on schema private');
select is(has_schema_privilege('authenticated', 'private', 'USAGE'), true,
  'authenticated has USAGE on schema private (policies call the helpers as the invoker)');

select is_empty(
  $$ select c.relname, r.rolname
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     cross join (values ('anon'), ('authenticated')) as r (rolname)
     cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) as p (priv)
     where n.nspname = 'private' and c.relkind in ('r', 'p', 'v', 'm', 'f')
       and has_table_privilege(r.rolname, c.oid, p.priv)
     order by 1, 2 $$,
  'API roles hold no privilege on any table or view of schema private');

-- Really anonymous: every table refuses, whatever the privilege catalog says.
select tests.login_anon();
select throws_ok(format('select 1 from public.%I limit 1', t), '42501', null, format('anon: SELECT on %s is refused', t))
from unnest(array[
  'countries', 'admin_areas', 'localities', 'branches', 'projects', 'project_land',
  'project_facilities', 'project_maintenance', 'project_photos', 'donors', 'project_donors',
  'persons', 'person_merge_requests', 'project_staff', 'staff_compensation', 'fx_rates',
  'option_values', 'community_profiles', 'community_sensitive', 'profiles', 'user_roles',
  'devices', 'audit_log', 'sync_conflicts', 'sync_applied_ops', 'restricted_access_log',
  'export_jobs', 'notifications', 'import_batches', 'import_rows', 'map_packs', 'app_settings'
]) as t;
select tests.logout();

-- -----------------------------------------------------------------------------
-- 3. authenticated: exactly the documented privileges
-- -----------------------------------------------------------------------------
select is_empty(
  $$ select r.relname, p.priv
     from _public_rels r
     cross join (values ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) as p (priv)
     where r.relkind in ('r', 'p') and has_table_privilege('authenticated', r.oid, p.priv)
     order by 1, 2 $$,
  'authenticated never holds DELETE, TRUNCATE, REFERENCES or TRIGGER (soft delete only)');

select set_eq(
  $$ select relname from _public_rels
     where relkind in ('r', 'p')
       and (has_table_privilege('authenticated', oid, 'INSERT') or has_table_privilege('authenticated', oid, 'UPDATE')) $$,
  array['countries', 'admin_areas', 'branches', 'option_values', 'fx_rates', 'map_packs', 'app_settings',
        'profiles', 'user_roles', 'devices'],
  'authenticated holds INSERT/UPDATE only on the reference and admin tables (RLS: hq_admin)');

select set_eq(
  $$ select relname from _public_rels
     where relkind in ('r', 'p') and has_table_privilege('authenticated', oid, 'SELECT') $$,
  array['countries', 'admin_areas', 'branches', 'option_values', 'fx_rates', 'map_packs', 'app_settings',
        'profiles', 'user_roles', 'devices',
        'localities', 'projects', 'project_land', 'project_facilities', 'project_maintenance',
        'project_photos', 'donors', 'project_donors', 'persons', 'project_staff',
        'person_merge_requests', 'community_profiles', 'sync_conflicts', 'notifications',
        'export_jobs', 'import_batches', 'import_rows', 'audit_log', 'restricted_access_log'],
  'authenticated holds SELECT on exactly the classified tables (restricted tables and the sync ledger are closed)');

select is_empty(
  $$ select r.relname
     from _public_rels r
     where r.relkind = 'S'
       and (has_sequence_privilege('authenticated', r.oid, 'USAGE') or has_sequence_privilege('authenticated', r.oid, 'UPDATE'))
     order by 1 $$,
  'authenticated holds no sequence privilege in schema public');

-- -----------------------------------------------------------------------------
-- 4. Policies
-- -----------------------------------------------------------------------------
select is_empty(
  $$ select tablename, policyname, roles from pg_policies
     where schemaname = 'public' and roles <> '{authenticated}' order by 1, 2 $$,
  'every policy of schema public targets role authenticated only');

select is_empty(
  $$ select tablename, policyname, cmd from pg_policies
     where schemaname = 'public' and cmd in ('ALL', 'DELETE') order by 1, 2 $$,
  'no policy allows DELETE (or ALL)');

select is_empty(
  $$ select tablename, policyname, cmd from pg_policies
     where schemaname = 'public'
       and tablename in ('localities', 'projects', 'project_land', 'project_facilities', 'project_maintenance',
                         'project_photos', 'donors', 'project_donors', 'persons', 'project_staff',
                         'person_merge_requests', 'community_profiles', 'sync_conflicts', 'notifications',
                         'export_jobs', 'import_batches', 'import_rows', 'audit_log', 'restricted_access_log')
       and cmd <> 'SELECT'
     order by 1, 2 $$,
  'field data, job and log tables have SELECT policies only');

select is_empty(
  $$ select r.relname
     from _public_rels r
     where r.relkind in ('r', 'p')
       and has_table_privilege('authenticated', r.oid, 'SELECT')
       and not exists (
         select 1 from pg_policies p
         where p.schemaname = 'public' and p.tablename = r.relname and p.cmd = 'SELECT')
     order by 1 $$,
  'every table readable by authenticated has a SELECT policy');

select is_empty(
  $$ select tablename, policyname from pg_policies
     where schemaname = 'public' and permissive <> 'PERMISSIVE' order by 1, 2 $$,
  'no restrictive policy is used (visibility = OR of the documented permissive policies)');

select is_empty(
  $$ select tablename, policyname from pg_policies
     where schemaname = 'public'
       and coalesce(qual, '') !~ 'private\.' and coalesce(with_check, '') !~ 'private\.'
     order by 1, 2 $$,
  'every policy goes through the private authorisation helpers (no "using (true)")');

-- -----------------------------------------------------------------------------
-- 5. Helpers of Appendix A.3
-- -----------------------------------------------------------------------------
select is_empty(
  $$ with expected (signature, rettype) as (values
       ('private.session_ok()', 'boolean'),
       ('private.aal2()', 'boolean'),
       ('private.my_roles()', 'record'),
       ('private.is_hq()', 'boolean'),
       ('private.read_all()', 'boolean'), ('private.read_countries()', 'uuid[]'), ('private.read_branches()', 'uuid[]'),
       ('private.people_all()', 'boolean'), ('private.people_countries()', 'uuid[]'), ('private.people_branches()', 'uuid[]'),
       ('private.write_all()', 'boolean'), ('private.write_countries()', 'uuid[]'), ('private.write_branches()', 'uuid[]'),
       ('private.review_all()', 'boolean'), ('private.review_countries()', 'uuid[]'), ('private.review_branches()', 'uuid[]'),
       ('private.restricted_all()', 'boolean'), ('private.restricted_countries()', 'uuid[]'),
       ('private.can_read_project(uuid,uuid)', 'boolean'),
       ('private.can_see_people(uuid,uuid)', 'boolean'),
       ('private.can_write_project(uuid,uuid)', 'boolean'),
       ('private.can_review(uuid,uuid)', 'boolean'),
       ('private.can_see_restricted(uuid)', 'boolean'),
       ('private.project_scope(uuid)', 'record'))
     select e.signature
     from expected e
     where not exists (
       select 1
       from pg_proc p
       where p.oid = to_regprocedure(e.signature)
         and p.prorettype = e.rettype::regtype
         and p.prosecdef
         and p.provolatile = 's'
         and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%'))
     order by 1 $$,
  'the Appendix A.3 helpers exist with the agreed signatures: STABLE, SECURITY DEFINER, pinned search_path');

select is(
  (select array_to_string(proargnames, ',') || ' | ' || array_to_string(proallargtypes::regtype[], ',')
     from pg_proc where oid = 'private.my_roles()'::regprocedure),
  'role,scope_type,scope_id | text,text,uuid',
  'my_roles() returns table(role text, scope_type text, scope_id uuid)');

select is(
  (select array_to_string(proargnames, ',') || ' | ' || array_to_string(proallargtypes::regtype[], ',')
     from pg_proc where oid = 'private.project_scope(uuid)'::regprocedure),
  'p_project,country_id,branch_id,created_by,record_state | uuid,uuid,uuid,uuid,text',
  'project_scope(p_project) returns table(country_id, branch_id, created_by, record_state)');

select is_empty(
  $$ select p.oid::regprocedure::text
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'private')
       and p.prosecdef
       and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
       and not exists (
         select 1 from pg_depend d
         where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
     order by 1 $$,
  'every SECURITY DEFINER function in public and private pins its search_path');

select is(has_function_privilege('authenticated', 'private.read_all()', 'EXECUTE'), true,
  'authenticated may execute the scope helpers');
select is(has_function_privilege('authenticated', 'private.project_scope(uuid)', 'EXECUTE'), false,
  'authenticated may not execute project_scope()');
select is(has_function_privilege('anon', 'private.session_ok()', 'EXECUTE'), false,
  'anon may not execute the helpers');

-- -----------------------------------------------------------------------------
-- 6. Triggers this area relies on
-- -----------------------------------------------------------------------------
select has_trigger('public', 'profiles', 't05_guard', 'profiles has the column guard trigger');
select is_empty(
  $$ select t from unnest(array['audit_log', 'restricted_access_log']) as t
     where not exists (
       select 1 from pg_trigger g
       where g.tgrelid = ('public.' || t)::regclass and g.tgname = 't01_append_only' and g.tgenabled <> 'D') $$,
  'the log tables carry an enabled append-only trigger');

select * from finish();
rollback;

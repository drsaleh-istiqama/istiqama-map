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
--     STABLE + SECURITY DEFINER with a pinned search_path;
--   * schema private (migration 0070): RLS enabled and forced on every table,
--     no policy, no privilege for the API roles on tables, views or sequences;
--   * public.server_info() (migration 0070) and the retention cron jobs.
--
-- A NEW TABLE IN SCHEMA public MAKES THIS FILE FAIL until it is classified in
-- docs/contracts/authz.md and added to the lists below. That is intended.
-- A NEW TABLE IN SCHEMA private MAKES THIS FILE FAIL until its migration
-- enables and forces RLS (or ends with: select private.harden_private_schema();).
-- =============================================================================
begin;
set local search_path = public, extensions, tests;

select plan(92);

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

select is_empty(
  $$ select c.relname, r.rolname
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     cross join (values ('anon'), ('authenticated')) as r (rolname)
     where n.nspname = 'private' and c.relkind = 'S'
       and (has_sequence_privilege(r.rolname, c.oid, 'USAGE') or has_sequence_privilege(r.rolname, c.oid, 'SELECT')
         or has_sequence_privilege(r.rolname, c.oid, 'UPDATE'))
     order by 1, 2 $$,
  'API roles hold no privilege on any sequence of schema private');

-- Schema private (migration 0070): closed twice. No privilege, and RLS forced
-- without any policy, so a grant made by mistake would still show nothing.
select is_empty(
  $$ select c.relname
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'private' and c.relkind in ('r', 'p')
       and not (c.relrowsecurity and c.relforcerowsecurity)
       and not exists (
         select 1 from pg_depend d
         where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
     order by 1 $$,
  'RLS is enabled AND forced on every table of schema private');

select is_empty(
  $$ select tablename, policyname from pg_policies where schemaname = 'private' order by 1, 2 $$,
  'schema private has no policy at all (only SECURITY DEFINER code, whose owner bypasses RLS, reads it)');

select is(private.harden_private_schema(), 0,
  'private.harden_private_schema() finds nothing left to harden after the migrations');

grant select on private.sync_tables to authenticated, service_role;
set local role authenticated;
select is((select count(*)::int from private.sync_tables), 0,
  'even with a SELECT grant, authenticated sees no row of a private table (forced RLS, no policy)');
set local role service_role;
select cmp_ok((select count(*)::int from private.sync_tables), '>', 0,
  'a BYPASSRLS role with the same grant reads it: this is how the owner of the SECURITY DEFINER functions gets through');
reset role;
revoke select on private.sync_tables from authenticated, service_role;

-- A table added later is repaired by re-running the function.
create table private._hardening_probe (id integer primary key);
grant select, insert on private._hardening_probe to authenticated;
select is(private.harden_private_schema(), 2,
  'harden_private_schema() turns two switches on for a new private table (enable + force)');
select is(
  (select array[c.relrowsecurity, c.relforcerowsecurity,
                has_table_privilege('authenticated', c.oid, 'SELECT'),
                has_table_privilege('authenticated', c.oid, 'INSERT')]
   from pg_class c where c.oid = 'private._hardening_probe'::regclass),
  array[true, true, false, false],
  'the new table ends up with RLS enabled + forced and without the stray grant');
drop table private._hardening_probe;

select is(
  array[has_function_privilege('anon', 'private.harden_private_schema()', 'EXECUTE'),
        has_function_privilege('authenticated', 'private.harden_private_schema()', 'EXECUTE'),
        has_function_privilege('service_role', 'private.harden_private_schema()', 'EXECUTE'),
        has_function_privilege('anon', 'private.schema_version()', 'EXECUTE'),
        has_function_privilege('authenticated', 'private.schema_version()', 'EXECUTE')],
  array[false, false, false, false, false],
  'no API role can execute harden_private_schema(); anon and authenticated cannot execute schema_version()');

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
        'localities', 'projects', 'project_facilities', 'project_maintenance',
        'project_photos', 'donors', 'project_donors', 'persons', 'project_staff',
        'person_merge_requests', 'community_profiles', 'sync_conflicts', 'notifications',
        'export_jobs', 'import_batches', 'import_rows', 'audit_log', 'restricted_access_log'],
  'authenticated holds table-level SELECT on exactly the classified tables (restricted tables and the sync ledger are closed; project_land is column-level)');

-- project_land.owner_name is people data (a private landowner is a person): direct SELECT
-- covers every other column, never the owner's name.
select ok(
  not has_column_privilege('authenticated', 'public.project_land', 'owner_name', 'SELECT')
  and has_column_privilege('authenticated', 'public.project_land', 'ownership', 'SELECT')
  and has_column_privilege('authenticated', 'public.project_land', 'area_m2', 'SELECT')
  and has_column_privilege('authenticated', 'public.project_land', 'project_id', 'SELECT')
  and has_column_privilege('authenticated', 'public.project_land', 'deleted_at', 'SELECT'),
  'authenticated may select every project_land column except owner_name');



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

-- -----------------------------------------------------------------------------
-- 7. server_info() (migration 0070): diagnostics for any signed-in user
-- -----------------------------------------------------------------------------
select is(
  (select p.prosecdef::text || '/' || p.provolatile::text || '/' || p.prorettype::regtype::text || '/'
          || (exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%'))::text
   from pg_proc p where p.oid = 'public.server_info()'::regprocedure),
  'true/s/jsonb/true',
  'server_info(): SECURITY DEFINER, STABLE, returns jsonb, pinned search_path');

select is(
  array[has_function_privilege('anon', 'public.server_info()', 'EXECUTE'),
        has_function_privilege('authenticated', 'public.server_info()', 'EXECUTE'),
        has_function_privilege('service_role', 'public.server_info()', 'EXECUTE')],
  array[false, true, true],
  'server_info(): executable by authenticated and service_role, not by anon');

select is(
  (select array_agg(k order by k) from jsonb_object_keys(public.server_info()) as k),
  array['app_environment', 'postgis_version', 'schema_version', 'server_time'],
  'server_info(): returns exactly app_environment, postgis_version, schema_version, server_time');

-- app_environment: the app_settings row app.environment when it is a JSON string, else "production".
select is(
  public.server_info() ->> 'app_environment',
  coalesce((select s.value #>> '{}' from public.app_settings s
            where s.key = 'app.environment' and s.deleted_at is null and jsonb_typeof(s.value) = 'string'),
           'production'),
  'server_info(): app_environment reflects this database (the setting, or "production" without it)');

insert into public.app_settings (id, key, value, is_public)
values (private.ref_uuid('setting:app.environment'), 'app.environment', '"staging"'::jsonb, true)
on conflict (key) do update set value = excluded.value, deleted_at = null;
select is(public.server_info() ->> 'app_environment', 'staging',
  'server_info(): app_environment is "staging" when the staging seed wrote the setting');

update public.app_settings set deleted_at = now() where key = 'app.environment';
select is(public.server_info() ->> 'app_environment', 'production',
  'server_info(): a soft-deleted setting counts as absent ("production")');

update public.app_settings set deleted_at = null, value = '123'::jsonb where key = 'app.environment';
select is(public.server_info() ->> 'app_environment', 'production',
  'server_info(): a value that is not a JSON string is ignored ("production")');

-- schema_version: 14 digits; the newest of private.schema_version() and the migrations
-- recorded by the Supabase CLI (the Docker-less local stack has no such table).
select ok(
  public.server_info() ->> 'schema_version' ~ '^[0-9]{14}$'
  and (public.server_info() ->> 'schema_version') collate "C" >= private.schema_version() collate "C"
  and private.schema_version() ~ '^[0-9]{14}$',
  'server_info(): schema_version is a 14-digit migration version, never older than private.schema_version()');

create temporary table _fake_migrations (created boolean not null) on commit drop;
do $fake$
begin
  if to_regclass('supabase_migrations.schema_migrations') is null then
    create schema supabase_migrations;
    create table supabase_migrations.schema_migrations (version text primary key);
    insert into supabase_migrations.schema_migrations (version)
    values ('20261003007000'), ('29990101000000'), ('not-a-version'), ('3');
    insert into _fake_migrations values (true);
  else
    insert into _fake_migrations values (false);
  end if;
end
$fake$;

select is(
  public.server_info() ->> 'schema_version',
  (select greatest(private.schema_version() collate "C", max(m.version::text collate "C"))
   from supabase_migrations.schema_migrations m where m.version::text ~ '^[0-9]{14}$'),
  'server_info(): schema_version is the newest of the constant and supabase_migrations.schema_migrations');

select case
  when (select created from _fake_migrations) then
    is(public.server_info() ->> 'schema_version', '29990101000000',
       'server_info(): a newer recorded migration wins; malformed versions are ignored')
  else
    skip('supabase_migrations.schema_migrations is real here: no fake versions are inserted', 1)
end;

select cmp_ok(
  abs(extract(epoch from ((public.server_info() ->> 'server_time')::timestamptz - clock_timestamp()))),
  '<', 5::numeric,
  'server_info(): server_time is the current server clock');

select is(public.server_info() ->> 'postgis_version', postgis_lib_version(),
  'server_info(): postgis_version is the PostGIS library version');

set local role authenticated;
select is(
  (select count(*)::int from jsonb_object_keys(public.server_info())), 4,
  'server_info(): callable through the API role authenticated');
reset role;

select tests.login_anon();
select throws_ok('select public.server_info()', '42501', null, 'server_info(): refused for anon');
select tests.logout();

-- -----------------------------------------------------------------------------
-- 8. Retention jobs (migration 0070). Checked only where pg_cron works and the
--    jobs of this database are visible to the test role (reference: the report
--    refresh job scheduled by migration 0058).
-- -----------------------------------------------------------------------------
-- cron.job cannot be named in static SQL: the schema does not exist without pg_cron.
create function pg_temp.cron_jobnames()
returns setof text
language plpgsql
as $f$
begin
  if to_regclass('cron.job') is null then
    return;
  end if;
  return query execute 'select j.jobname::text from cron.job j where j.jobname is not null';
end
$f$;

select case
  when to_regclass('cron.job') is null then
    skip('pg_cron is not installed: sync retention must be scheduled externally', 1)
  when not exists (
    select 1 from pg_temp.cron_jobnames() as j (jobname) where j.jobname = 'istiqama-refresh-reports') then
    skip('pg_cron jobs of the migrations are not visible here', 1)
  else
    ok((select count(*) = 2 from pg_temp.cron_jobnames() as j (jobname)
        where j.jobname in ('istiqama-sync-prune', 'istiqama-sync-rejections-cleanup')),
       'pg_cron: istiqama-sync-prune and istiqama-sync-rejections-cleanup are scheduled')
end;

-- the name still reaches people-scoped readers through sync_pull, never viewers.
-- (Appended last: it swaps the transaction-id clock inside this test transaction the same
-- way 23_sync_pull does: rows written by the test itself would otherwise be invisible to
-- sync_pull, which is correct behaviour for uncommitted rows.)
create or replace function private.current_xid() returns bigint language sql stable as
$fn$ select current_setting('test.xid')::bigint $fn$;
create or replace function private.safe_xid() returns bigint language sql stable as
$fn$ select current_setting('test.safe')::bigint $fn$;
do $$
declare b bigint := pg_current_xact_id()::text::bigint + 1000000;
begin
  perform set_config('test.xid', (b + 100)::text, true);
  perform set_config('test.safe', (b + 101)::text, true);
  perform set_config('app.rate_limit', 'off', true);
end $$;
select tests.fixture_extra();
update public.project_land set ownership = 'person', owner_name = 'Owner Person p_pemba_1'
 where id = tests.id('land:p_pemba_1');

select tests.login_as(tests.id('u_viewer_tz'));
select throws_ok(
  $$ select owner_name from public.project_land $$,
  '42501', null,
  'a viewer cannot select project_land.owner_name directly');
select is(
  (select jsonb_agg(jsonb_build_object('owner_name', r -> 'owner_name', 'area_m2', r -> 'area_m2'))
     from jsonb_array_elements(public.sync_pull(null, 1000) -> 'changes') c,
          jsonb_array_elements(c -> 'rows') r
    where c ->> 'table' = 'project_land' and r ->> 'project_id' = tests.id('p_pemba_1')::text),
  '[{"owner_name": null, "area_m2": 900}]'::jsonb,
  'sync_pull sends the Pemba land row to a viewer with owner_name blanked');
select is(
  public.report_project(tests.id('p_pemba_1')) -> 'land' ? 'owner_name',
  false,
  'report_project omits owner_name for a viewer');
select ok(
  not exists (select 1 from jsonb_array_elements(public.export_columns('en') -> 'columns') c
               where c ->> 'key' = 'land_owner_name'),
  'export_columns does not list land_owner_name for a viewer');

select tests.login_as(tests.id('u_sup_pemba'), 'aal1');
select is(
  (select r ->> 'owner_name'
     from jsonb_array_elements(public.sync_pull(null, 1000) -> 'changes') c,
          jsonb_array_elements(c -> 'rows') r
    where c ->> 'table' = 'project_land' and r ->> 'project_id' = tests.id('p_pemba_1')::text),
  'Owner Person p_pemba_1',
  'sync_pull keeps owner_name for a supervisor of the branch');
select is(
  public.report_project(tests.id('p_pemba_1')) -> 'land' ->> 'owner_name',
  'Owner Person p_pemba_1',
  'report_project keeps owner_name for a supervisor of the branch');

select tests.login_as(tests.id('u_col_tanga'), 'aal1');
select is(
  (select count(*)::int
     from jsonb_array_elements(public.sync_pull(null, 1000) -> 'changes') c,
          jsonb_array_elements(c -> 'rows') r
    where c ->> 'table' = 'project_land' and r ->> 'project_id' = tests.id('p_pemba_1')::text),
  0,
  'a collector of another branch does not receive the Pemba land row at all');
select tests.logout();

select * from finish();
rollback;

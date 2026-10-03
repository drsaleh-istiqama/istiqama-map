-- =============================================================================
-- 12  Restricted tables, logs and job tables (brief §3, §11)
--
--   * staff_compensation / community_sensitive: unreadable and unwritable by
--     direct SQL for EVERY role, hq_admin included (reads only through logged
--     SECURITY DEFINER functions);
--   * sync_applied_ops: no API access;
--   * audit_log / restricted_access_log: hq_admin may read, nobody may change;
--   * export_jobs / import_batches / import_rows: own rows, read-only.
-- =============================================================================
begin;
set local search_path = public, extensions, tests;

select plan(131);

select tests.fixture_extra();

create temporary table _closed_tables on commit drop as
select t from unnest(array['staff_compensation', 'community_sensitive', 'sync_applied_ops']) as t;
grant select on _closed_tables to public;

create temporary table _log_tables on commit drop as
select t from unnest(array['audit_log', 'restricted_access_log']) as t;
grant select on _log_tables to public;

create temporary table _job_tables on commit drop as
select t from unnest(array['export_jobs', 'import_batches', 'import_rows']) as t;
grant select on _job_tables to public;

-- -----------------------------------------------------------------------------
-- A. Closed tables: 6 callers x 3 tables x 4 statements = 72 assertions
-- -----------------------------------------------------------------------------
select tests.login_as(tests.id('u_hq'), 'aal2');
select throws_ok(format('select 1 from public.%I limit 1', t), '42501', null, format('hq_admin: SELECT on %s is refused', t)) from _closed_tables order by t;
select throws_ok(format('insert into public.%I default values', t), '42501', null, format('hq_admin: INSERT into %s is refused', t)) from _closed_tables order by t;
select throws_ok(format('update public.%I set user_id = null', t), '42501', null, format('hq_admin: UPDATE of %s is refused', t)) from _closed_tables where t = 'sync_applied_ops';
select throws_ok(format('update public.%I set deleted_at = now()', t), '42501', null, format('hq_admin: UPDATE of %s is refused', t)) from _closed_tables where t <> 'sync_applied_ops' order by t;
select throws_ok(format('delete from public.%I', t), '42501', null, format('hq_admin: DELETE from %s is refused', t)) from _closed_tables order by t;

select tests.login_as(tests.id('u_mgr_tz'), 'aal2');
select throws_ok(format('select 1 from public.%I limit 1', t), '42501', null, format('country_manager: SELECT on %s is refused', t)) from _closed_tables order by t;
select throws_ok(format('insert into public.%I default values', t), '42501', null, format('country_manager: INSERT into %s is refused', t)) from _closed_tables order by t;
select throws_ok(format('update public.%I set user_id = null', t), '42501', null, format('country_manager: UPDATE of %s is refused', t)) from _closed_tables where t = 'sync_applied_ops';
select throws_ok(format('update public.%I set deleted_at = now()', t), '42501', null, format('country_manager: UPDATE of %s is refused', t)) from _closed_tables where t <> 'sync_applied_ops' order by t;
select throws_ok(format('delete from public.%I', t), '42501', null, format('country_manager: DELETE from %s is refused', t)) from _closed_tables order by t;

select tests.login_as(tests.id('u_sup_pemba'), 'aal1');
select throws_ok(format('select 1 from public.%I limit 1', t), '42501', null, format('branch_supervisor: SELECT on %s is refused', t)) from _closed_tables order by t;
select throws_ok(format('insert into public.%I default values', t), '42501', null, format('branch_supervisor: INSERT into %s is refused', t)) from _closed_tables order by t;
select throws_ok(format('update public.%I set user_id = null', t), '42501', null, format('branch_supervisor: UPDATE of %s is refused', t)) from _closed_tables where t = 'sync_applied_ops';
select throws_ok(format('update public.%I set deleted_at = now()', t), '42501', null, format('branch_supervisor: UPDATE of %s is refused', t)) from _closed_tables where t <> 'sync_applied_ops' order by t;
select throws_ok(format('delete from public.%I', t), '42501', null, format('branch_supervisor: DELETE from %s is refused', t)) from _closed_tables order by t;

select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select throws_ok(format('select 1 from public.%I limit 1', t), '42501', null, format('field_collector: SELECT on %s is refused', t)) from _closed_tables order by t;
select throws_ok(format('insert into public.%I default values', t), '42501', null, format('field_collector: INSERT into %s is refused', t)) from _closed_tables order by t;
select throws_ok(format('update public.%I set user_id = null', t), '42501', null, format('field_collector: UPDATE of %s is refused', t)) from _closed_tables where t = 'sync_applied_ops';
select throws_ok(format('update public.%I set deleted_at = now()', t), '42501', null, format('field_collector: UPDATE of %s is refused', t)) from _closed_tables where t <> 'sync_applied_ops' order by t;
select throws_ok(format('delete from public.%I', t), '42501', null, format('field_collector: DELETE from %s is refused', t)) from _closed_tables order by t;

select tests.login_as(tests.id('u_viewer_global'), 'aal1');
select throws_ok(format('select 1 from public.%I limit 1', t), '42501', null, format('viewer: SELECT on %s is refused', t)) from _closed_tables order by t;
select throws_ok(format('insert into public.%I default values', t), '42501', null, format('viewer: INSERT into %s is refused', t)) from _closed_tables order by t;
select throws_ok(format('update public.%I set user_id = null', t), '42501', null, format('viewer: UPDATE of %s is refused', t)) from _closed_tables where t = 'sync_applied_ops';
select throws_ok(format('update public.%I set deleted_at = now()', t), '42501', null, format('viewer: UPDATE of %s is refused', t)) from _closed_tables where t <> 'sync_applied_ops' order by t;
select throws_ok(format('delete from public.%I', t), '42501', null, format('viewer: DELETE from %s is refused', t)) from _closed_tables order by t;

select tests.login_anon();
select throws_ok(format('select 1 from public.%I limit 1', t), '42501', null, format('anon: SELECT on %s is refused', t)) from _closed_tables order by t;
select throws_ok(format('insert into public.%I default values', t), '42501', null, format('anon: INSERT into %s is refused', t)) from _closed_tables order by t;
select throws_ok(format('update public.%I set user_id = null', t), '42501', null, format('anon: UPDATE of %s is refused', t)) from _closed_tables where t = 'sync_applied_ops';
select throws_ok(format('update public.%I set deleted_at = now()', t), '42501', null, format('anon: UPDATE of %s is refused', t)) from _closed_tables where t <> 'sync_applied_ops' order by t;
select throws_ok(format('delete from public.%I', t), '42501', null, format('anon: DELETE from %s is refused', t)) from _closed_tables order by t;

select tests.logout();

-- Catalog view of the same facts: no table or column privilege, no policy.
select is_empty(
  $$ select c.relname, r.rolname, p.priv
     from pg_class c
     cross join (values ('anon'), ('authenticated')) as r (rolname)
     cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) as p (priv)
     where c.oid in ('public.staff_compensation'::regclass, 'public.community_sensitive'::regclass,
                     'public.sync_applied_ops'::regclass)
       and has_table_privilege(r.rolname, c.oid, p.priv) $$,
  'closed tables: API roles hold no table privilege');
select is_empty(
  $$ select c.relname, r.rolname
     from pg_class c
     cross join (values ('anon'), ('authenticated')) as r (rolname)
     where c.oid in ('public.staff_compensation'::regclass, 'public.community_sensitive'::regclass,
                     'public.sync_applied_ops'::regclass)
       and (has_any_column_privilege(r.rolname, c.oid, 'SELECT')
         or has_any_column_privilege(r.rolname, c.oid, 'UPDATE')
         or has_any_column_privilege(r.rolname, c.oid, 'INSERT')) $$,
  'closed tables: API roles hold no column privilege');
select is_empty(
  $$ select policyname from pg_policies
     where schemaname = 'public'
       and tablename in ('staff_compensation', 'community_sensitive', 'sync_applied_ops') $$,
  'closed tables: no RLS policy exists');

-- -----------------------------------------------------------------------------
-- A2. Side doors: restricted values must not leak through other tables
-- -----------------------------------------------------------------------------
-- a sync conflict on a salary carries the amounts in server_value/client_value
insert into public.sync_conflicts
  (id, table_name, row_id, project_id, field, base_version, server_value, client_value, client_user_id, state)
values
  (tests._uuid('restricted-conflict'), 'staff_compensation', tests.id('comp:p_pemba_1'), tests.id('p_pemba_1'),
   'monthly_amount', 1, '250000'::jsonb, '999999'::jsonb, tests.id('u_col_pemba'), 'open');

select isnt_empty(
  $$ select 1 from public.audit_log where table_name = 'staff_compensation' and row_id = tests.id('comp:p_pemba_1') $$,
  'the audit log holds the row image of a salary (seen by the owner role)');

select tests.login_as(tests.id('u_sup_pemba'), 'aal1');
select is_empty(
  $$ select 1 from public.sync_conflicts where table_name in ('staff_compensation', 'community_sensitive') $$,
  'branch_supervisor: conflicts on restricted tables are invisible by direct SQL');

select tests.login_as(tests.id('u_mgr_tz'), 'aal2');
select is_empty(
  $$ select 1 from public.sync_conflicts where table_name in ('staff_compensation', 'community_sensitive') $$,
  'country_manager: conflicts on restricted tables are invisible by direct SQL');

select tests.login_as(tests.id('u_hq'), 'aal2');
select is_empty(
  $$ select 1 from public.sync_conflicts where table_name in ('staff_compensation', 'community_sensitive') $$,
  'hq_admin: conflicts on restricted tables are invisible by direct SQL');
select is_empty(
  $$ select 1 from public.audit_log where table_name in ('staff_compensation', 'community_sensitive') $$,
  'hq_admin: audit rows of restricted tables are invisible by direct SQL (no unlogged side door)');

-- -----------------------------------------------------------------------------
-- B. Logs
-- -----------------------------------------------------------------------------
select tests.login_as(tests.id('u_hq'), 'aal2');
select isnt_empty(
  $$ select 1 from public.audit_log where table_name = 'projects' and row_id = tests.id('p_pemba_1') $$,
  'hq_admin: can read audit_log');
select isnt_empty(
  $$ select 1 from public.restricted_access_log where context = 'tests.fixture_extra' $$,
  'hq_admin: can read restricted_access_log');
select throws_ok(format('insert into public.%I default values', t), '42501', null, format('hq_admin: INSERT into %s is refused', t)) from _log_tables order by t;
select throws_ok(format('update public.%I set table_name = table_name', t), '42501', null, format('hq_admin: UPDATE of %s is refused', t)) from _log_tables order by t;
select throws_ok(format('delete from public.%I', t), '42501', null, format('hq_admin: DELETE from %s is refused', t)) from _log_tables order by t;

select tests.login_as(tests.id('u_hq'), 'aal1');
select is_empty($$ select 1 from public.audit_log $$, 'hq_admin at AAL1: audit_log shows nothing');

select tests.login_as(tests.id('u_mgr_tz'), 'aal2');
select is_empty($$ select 1 from public.audit_log $$, 'country_manager: audit_log shows nothing');
select is_empty($$ select 1 from public.restricted_access_log $$, 'country_manager: restricted_access_log shows nothing');

select tests.login_as(tests.id('u_sup_pemba'), 'aal1');
select is_empty($$ select 1 from public.audit_log $$, 'branch_supervisor: audit_log shows nothing');
select is_empty($$ select 1 from public.restricted_access_log $$, 'branch_supervisor: restricted_access_log shows nothing');

select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select is_empty($$ select 1 from public.audit_log $$, 'field_collector: audit_log shows nothing');
select is_empty($$ select 1 from public.restricted_access_log $$, 'field_collector: restricted_access_log shows nothing');
select throws_ok(format('insert into public.%I default values', t), '42501', null, format('field_collector: INSERT into %s is refused', t)) from _log_tables order by t;
select throws_ok(format('update public.%I set table_name = table_name', t), '42501', null, format('field_collector: UPDATE of %s is refused', t)) from _log_tables order by t;
select throws_ok(format('delete from public.%I', t), '42501', null, format('field_collector: DELETE from %s is refused', t)) from _log_tables order by t;

select tests.login_as(tests.id('u_viewer_global'), 'aal1');
select is_empty($$ select 1 from public.audit_log $$, 'viewer: audit_log shows nothing');
select is_empty($$ select 1 from public.restricted_access_log $$, 'viewer: restricted_access_log shows nothing');

select tests.login_anon();
select throws_ok(format('select 1 from public.%I limit 1', t), '42501', null, format('anon: SELECT on %s is refused', t)) from _log_tables order by t;

select tests.logout();

-- Nobody can rewrite the logs: not the service role (no privilege) and not even
-- the table owner (append-only trigger).
select is_empty(
  $$ select c.relname, p.priv
     from pg_class c
     cross join (values ('UPDATE'), ('DELETE'), ('TRUNCATE')) as p (priv)
     where c.oid in ('public.audit_log'::regclass, 'public.restricted_access_log'::regclass)
       and has_table_privilege('service_role', c.oid, p.priv) $$,
  'logs: service_role cannot update, delete or truncate');
select throws_ok(format('update public.%I set table_name = table_name', t), 'PT403', null, format('owner: UPDATE of %s is refused (append-only)', t)) from _log_tables order by t;
select throws_ok(format('delete from public.%I', t), 'PT403', null, format('owner: DELETE from %s is refused (append-only)', t)) from _log_tables order by t;

-- -----------------------------------------------------------------------------
-- C. Own jobs
-- -----------------------------------------------------------------------------
select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select is(tests.visible('export_jobs'), tests.ids('export:u_col_pemba'), 'field_collector: own export jobs');
select is(tests.visible('import_batches'), tests.ids('import:u_col_pemba'), 'field_collector: own import batches');
select is(tests.visible('import_rows'), tests.ids('importrow:u_col_pemba'), 'field_collector: rows of own import batches');
select throws_ok(format('insert into public.%I default values', t), '42501', null, format('field_collector: INSERT into %s is refused', t)) from _job_tables order by t;
select throws_ok(format('update public.%I set deleted_at = now()', t), '42501', null, format('field_collector: UPDATE of %s is refused', t)) from _job_tables order by t;
select throws_ok(format('delete from public.%I', t), '42501', null, format('field_collector: DELETE from %s is refused', t)) from _job_tables order by t;

select tests.login_as(tests.id('u_sup_pemba'), 'aal1');
select is(tests.visible('export_jobs'), '{}'::uuid[], 'branch_supervisor: no export jobs of other users');
select is(tests.visible('import_batches'), '{}'::uuid[], 'branch_supervisor: no import batches of other users');
select is(tests.visible('import_rows'), '{}'::uuid[], 'branch_supervisor: no import rows of other users');

select tests.login_as(tests.id('u_hq'), 'aal2');
select is(tests.visible('export_jobs', tests.kind_ids('export')), tests.ids('export:u_hq'), 'hq_admin: own export jobs only');
select is(tests.visible('import_batches', tests.kind_ids('import')), tests.ids('import:u_hq'), 'hq_admin: own import batches only');
select is(tests.visible('import_rows', tests.kind_ids('importrow')), tests.ids('importrow:u_hq'), 'hq_admin: own import rows only');

select tests.login_anon();
select throws_ok(format('select 1 from public.%I limit 1', t), '42501', null, format('anon: SELECT on %s is refused', t)) from _job_tables order by t;

select tests.logout();
select * from finish();
rollback;

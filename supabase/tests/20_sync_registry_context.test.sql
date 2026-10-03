-- =============================================================================
-- 20  Sync registry, my_context(), register_device()
--     (docs/contracts/sync.md; migrations 0020-0021)
-- =============================================================================
begin;
set local search_path = public, extensions, tests;

select plan(41);

do $$ begin perform tests.fixture(); end $$;

-- -----------------------------------------------------------------------------
-- Registry
-- -----------------------------------------------------------------------------
select is(
  (select array_agg(table_name order by pull_order) from private.sync_tables),
  array['countries', 'admin_areas', 'branches', 'option_values', 'fx_rates', 'localities', 'donors',
        'projects', 'project_land', 'project_facilities', 'project_maintenance', 'project_photos',
        'project_donors', 'persons', 'project_staff', 'community_profiles', 'staff_compensation',
        'community_sensitive', 'person_merge_requests', 'sync_conflicts', 'notifications', 'map_packs'],
  'registry: 22 tables in the pull order of ARCHITECTURE 3.2');

select is(
  (select array_agg(table_name order by table_name) from private.sync_tables where audience = 'restricted'),
  array['community_sensitive', 'staff_compensation'],
  'registry: exactly the two restricted tables');

select is(
  (select array_agg(table_name order by table_name) from private.sync_tables where audience = 'people'),
  array['persons', 'project_staff'],
  'registry: people tables are never sent to viewers');

select is(
  (select array_agg(table_name order by table_name) from private.sync_tables
   where push_insert = 'none' and push_update = 'none' and push_delete = 'none'),
  array['admin_areas', 'branches', 'countries', 'fx_rates', 'map_packs', 'option_values', 'sync_conflicts'],
  'registry: reference tables and sync_conflicts are not writable through sync_push');

select is(
  (select count(*)::int
   from private.sync_tables r
   where not exists (
     select 1 from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = r.table_name and c.column_name = 'sync_xid')),
  0, 'registry: every table exists and has sync_xid');

select is(
  (select count(*)::int
   from private.sync_tables r
   where not private.sync_has_index(format('public.%I', r.table_name)::regclass, array['sync_xid', 'id'])),
  0, 'every syncable table has a btree index starting with (sync_xid, id)');

select is(private.sync_ensure_indexes(), 0, 'sync_ensure_indexes() is idempotent');

select ok(
  private.sync_select_list('projects') ~ 'st_x\(t\.geom\)' and private.sync_select_list('projects') !~ 't\.geom,'
  and private.sync_select_list('projects') !~ 'sync_xid',
  'wire projection of projects: lon/lat instead of geom, no sync_xid');

select ok(
  private.sync_select_list('admin_areas') !~ 'geom',
  'wire projection of admin_areas: no geometry at all');

select ok(
  not (private.sync_writable_columns('projects')
       && array['id', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by', 'sync_xid', 'deleted_at',
                'code', 'completeness', 'search_norm', 'import_batch_id', 'reviewed_by', 'reviewed_at', 'geom']),
  'server-managed project columns are not client-writable');

select is(private.sync_writable_columns('notifications'), array['read_at'],
  'notifications: only read_at is client-writable');

-- -----------------------------------------------------------------------------
-- Function privileges (Appendix A.1)
-- -----------------------------------------------------------------------------
select is(
  (select count(*)::int
   from (values ('public.sync_push(jsonb, text)'), ('public.sync_pull(jsonb, integer)'),
                ('public.resolve_conflict(uuid, text)'), ('public.my_context()'),
                ('public.register_device(text, text, text)')) as f(sig)
   where has_function_privilege('anon', f.sig, 'execute')
      or has_function_privilege('public', f.sig, 'execute')),
  0, 'anon / public cannot execute the sync RPCs');

select is(
  (select count(*)::int
   from (values ('public.sync_push(jsonb, text)'), ('public.sync_pull(jsonb, integer)'),
                ('public.resolve_conflict(uuid, text)'), ('public.my_context()'),
                ('public.register_device(text, text, text)')) as f(sig)
   where has_function_privilege('authenticated', f.sig, 'execute')),
  5, 'authenticated can execute the five sync RPCs');

select is(
  (select count(*)::int
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and p.proname like 'sync\_%'
     and (has_function_privilege('authenticated', p.oid, 'execute')
          or has_function_privilege('anon', p.oid, 'execute'))),
  0, 'no private.sync_* function is executable by API roles');

select is(
  (select count(*)::int
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where ((n.nspname = 'public' and p.proname in ('sync_push', 'sync_pull', 'resolve_conflict', 'my_context', 'register_device'))
          or (n.nspname = 'private' and p.proname like 'sync\_%'))
     and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%')),
  0, 'every sync function pins search_path');

select ok(
  not has_table_privilege('authenticated', 'private.sync_tables', 'select')
  and not has_table_privilege('anon', 'private.sync_tables', 'select')
  and not has_table_privilege('authenticated', 'private.sync_state', 'select'),
  'registry tables are not readable by API roles');

select is((private.sync_changed_tables(0, 1))[1], '#22',
  'the generated sync_changed_tables() knows all 22 registry tables');

-- -----------------------------------------------------------------------------
-- private.sync_ctx() derives the scope triples from one my_roles() call; it
-- must agree with the Appendix A.3 helpers for every role and assurance level.
-- -----------------------------------------------------------------------------
create function pg_temp.same_set(a uuid[], b uuid[]) returns boolean language sql immutable as
$fn$ select coalesce(a, '{}') @> coalesce(b, '{}') and coalesce(a, '{}') <@ coalesce(b, '{}') $fn$;

create function pg_temp.ctx_matches(p_user uuid, p_aal text) returns boolean language plpgsql as
$fn$
declare
  c  private.sync_ctx;
  ok boolean;
begin
  perform tests.login_as(p_user, p_aal);
  perform set_config('role', 'none', true);   -- keep the JWT, evaluate as the privileged role
  c := private.sync_ctx();
  ok := c.uid = p_user
    and c.read_all = private.read_all()
    and pg_temp.same_set(c.read_c, private.read_countries())
    and pg_temp.same_set(c.read_b, private.read_branches())
    and c.people_all = private.people_all()
    and pg_temp.same_set(c.people_c, private.people_countries())
    and pg_temp.same_set(c.people_b, private.people_branches())
    and c.write_all = private.write_all()
    and pg_temp.same_set(c.write_c, private.write_countries())
    and pg_temp.same_set(c.write_b, private.write_branches())
    and c.review_all = private.review_all()
    and pg_temp.same_set(c.review_c, private.review_countries())
    and pg_temp.same_set(c.review_b, private.review_branches())
    and c.restricted_all = private.restricted_all()
    and pg_temp.same_set(c.restricted_c, private.restricted_countries());
  perform tests.logout();
  return coalesce(ok, false);
end;
$fn$;

create function pg_temp.ctx_multi() returns private.sync_ctx language plpgsql as
$fn$
declare
  c private.sync_ctx;
begin
  perform tests.login_as(tests._uuid('user:multi@example.org'), 'aal1');
  perform set_config('role', 'none', true);
  c := private.sync_ctx();
  perform tests.logout();
  return c;
end;
$fn$;

-- one user holding several roles at once
do $$
declare
  v uuid := tests.create_user('multi@example.org', 'field_collector', 'branch', tests.id('br_pemba'));
begin
  perform tests.create_user('multi@example.org', 'branch_supervisor', 'branch', tests.id('br_tanga'));
  perform tests.create_user('multi@example.org', 'viewer', 'country', tests.id('ke'));
  perform tests.create_user('multi@example.org', 'country_manager', 'country', tests.id('ke'));
end $$;

select is(
  (select count(*)::int
   from unnest(tests.fixture_users() || tests._uuid('user:multi@example.org')) u, unnest(array['aal1', 'aal2']) a
   where not pg_temp.ctx_matches(u, a)),
  0, 'sync_ctx() agrees with the Appendix A.3 scope helpers for every fixture role at aal1 and aal2');

select ok(
  (select c.read_cs @> array[tests.id('tz'), tests.id('ke')] and c.write_cs @> array[tests.id('tz')]
          and c.review_cs @> array[tests.id('tz')] and not (c.restricted_c && array[tests.id('tz')])
   from pg_temp.ctx_multi() c),
  'country sets include the countries of branch-scoped roles');

-- -----------------------------------------------------------------------------
-- my_context()
-- -----------------------------------------------------------------------------
create function pg_temp.ctx(p_user uuid, p_aal text default 'aal2', p_device text default 'dev-test')
returns jsonb
language plpgsql
as $$
declare
  r jsonb;
begin
  perform tests.login_as(p_user, p_aal, p_device);
  r := public.my_context();
  perform tests.logout();
  return r;
end;
$$;

select is(
  pg_temp.ctx(tests.id('u_col_pemba'), 'aal1') -> 'capabilities',
  '{"can_write": true, "can_review": false, "can_see_restricted": false, "can_see_people": true, "is_hq": false}'::jsonb,
  'my_context: field collector capabilities');

select is(
  pg_temp.ctx(tests.id('u_col_pemba'), 'aal1') #> '{scopes,write,branches}',
  jsonb_build_array(tests.id('br_pemba')),
  'my_context: collector write scope = own branch');

select is(
  pg_temp.ctx(tests.id('u_col_pemba'), 'aal1') #>> '{profile,full_name}', 'u_col_pemba',
  'my_context: profile is returned');

select is(
  pg_temp.ctx(tests.id('u_sup_pemba'), 'aal1') -> 'capabilities',
  '{"can_write": true, "can_review": true, "can_see_restricted": false, "can_see_people": true, "is_hq": false}'::jsonb,
  'my_context: branch supervisor reviews but sees no restricted data');

select is(
  pg_temp.ctx(tests.id('u_mgr_tz'), 'aal2') -> 'capabilities',
  '{"can_write": true, "can_review": true, "can_see_restricted": true, "can_see_people": true, "is_hq": false}'::jsonb,
  'my_context: country manager at aal2');

select is(
  pg_temp.ctx(tests.id('u_mgr_tz'), 'aal2') #> '{scopes,restricted,countries}',
  jsonb_build_array(tests.id('tz')),
  'my_context: manager restricted scope = own country');

select is(
  pg_temp.ctx(tests.id('u_mgr_tz'), 'aal1') -> 'capabilities',
  '{"can_write": false, "can_review": false, "can_see_restricted": false, "can_see_people": false, "is_hq": false}'::jsonb,
  'my_context: country manager without MFA has no effective capability');

select is(
  (pg_temp.ctx(tests.id('u_mgr_tz'), 'aal1') ->> 'mfa_required')::boolean, true,
  'my_context: mfa_required is true for a manager at aal1');

select is(
  jsonb_array_length(pg_temp.ctx(tests.id('u_mgr_tz'), 'aal1') -> 'roles'), 0,
  'my_context: no effective roles at aal1 for a manager ...');

select is(
  jsonb_array_length(pg_temp.ctx(tests.id('u_mgr_tz'), 'aal1') -> 'assigned_roles'), 1,
  '... but the granted role is listed');

select isnt(
  pg_temp.ctx(tests.id('u_mgr_tz'), 'aal1') ->> 'scope_epoch',
  pg_temp.ctx(tests.id('u_mgr_tz'), 'aal2') ->> 'scope_epoch',
  'scope_epoch changes with the effective roles (aal1 vs aal2)');

select is(
  pg_temp.ctx(tests.id('u_col_pemba'), 'aal1') ->> 'scope_epoch',
  pg_temp.ctx(tests.id('u_col_pemba'), 'aal2', 'dev-other') ->> 'scope_epoch',
  'scope_epoch is stable for the same effective roles');

select isnt(
  pg_temp.ctx(tests.id('u_col_pemba'), 'aal1') ->> 'scope_epoch',
  pg_temp.ctx(tests.id('u_col_pemba2'), 'aal1') ->> 'scope_epoch',
  'scope_epoch differs between users with the same roles');

select is(
  pg_temp.ctx(tests.id('u_viewer_tz'), 'aal1') -> 'capabilities',
  '{"can_write": false, "can_review": false, "can_see_restricted": false, "can_see_people": false, "is_hq": false}'::jsonb,
  'my_context: viewer sees no people and writes nothing');

select is(
  pg_temp.ctx(tests.id('u_hq'), 'aal2') -> 'capabilities',
  '{"can_write": true, "can_review": true, "can_see_restricted": true, "can_see_people": true, "is_hq": true}'::jsonb,
  'my_context: hq_admin at aal2');

do $$
declare
  v_before text := pg_temp.ctx(tests.id('u_col_pemba'), 'aal1') ->> 'scope_epoch';
begin
  perform private.sync_rotate_epoch();
  perform set_config('t.epoch_rotated',
    (v_before <> (pg_temp.ctx(tests.id('u_col_pemba'), 'aal1') ->> 'scope_epoch'))::text, true);
end $$;
select is(current_setting('t.epoch_rotated'), 'true', 'rotating the sync epoch changes every scope_epoch');

-- -----------------------------------------------------------------------------
-- register_device()
-- -----------------------------------------------------------------------------
create function pg_temp.reg(p_user uuid, p_header text, p_device text)
returns jsonb
language plpgsql
as $$
declare
  r jsonb;
begin
  perform tests.login_as(p_user, 'aal1', p_header);
  r := public.register_device(p_device, 'Phone', '3.0.0');
  perform tests.logout();
  return r;
end;
$$;

select is(
  (pg_temp.reg(tests.id('u_col_pemba'), 'dev-reg-1', 'dev-reg-1') ->> 'revoked')::boolean, false,
  'register_device: new device is not revoked');

select is(
  (select row(d.label, d.app_version, d.last_seen_at is not null)::text
   from public.devices d where d.user_id = tests.id('u_col_pemba') and d.device_id = 'dev-reg-1'),
  row('Phone'::text, '3.0.0'::text, true)::text,
  'register_device: row stored with label, app version and heartbeat');

do $$ begin
  perform pg_temp.reg(tests.id('u_col_pemba'), 'dev-reg-1', 'dev-reg-1');
end $$;
select is(
  (select count(*)::int from public.devices d
   where d.user_id = tests.id('u_col_pemba') and d.device_id = 'dev-reg-1'),
  1, 'register_device: second call updates the same row');

update public.devices set revoked_at = now()
where user_id = tests.id('u_col_pemba') and device_id = 'dev-reg-1';

select is(
  (pg_temp.reg(tests.id('u_col_pemba'), 'dev-reg-1', 'dev-reg-1') ->> 'revoked')::boolean, true,
  'register_device: reports a revoked device (and does not un-revoke it)');

select is(
  (pg_temp.ctx(tests.id('u_col_pemba'), 'aal1', 'dev-reg-1') ->> 'session_ok')::boolean, false,
  'my_context on a revoked device: session_ok = false');

select throws_ok(
  format('select pg_temp.reg(%L::uuid, %L, %L)', tests.id('u_col_pemba'), 'dev-header', 'dev-argument'),
  'PT422', 'device_mismatch',
  'register_device: x-device-id header and argument must match');

select * from finish();
rollback;

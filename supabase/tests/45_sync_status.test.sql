-- =============================================================================
-- 45  report_device_status / sync_status (migration 0045; brief §1, §4.5)
-- =============================================================================
begin;
set local search_path = public, extensions, tests;

select plan(34);

select tests.fixture();

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.report_device_status(text, integer, integer, text)', 'execute')
  and not has_function_privilege('anon', 'public.sync_status()', 'execute'),
  'anon cannot execute report_device_status or sync_status');
select ok(
  not has_function_privilege('authenticated', 'private.log_sync_rejection(uuid, text, jsonb, jsonb)', 'execute')
  and not has_table_privilege('authenticated', 'private.sync_rejections', 'select, insert, update, delete'),
  'the rejection log is not reachable by API roles');

-- ---------------------------------------------------------------------------
-- report_device_status
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('u_col_pemba'), 'aal1', 'dev-a');
select public.report_device_status('dev-a', 7, 3, '3.0.0') as s1 \gset
select is(
  :'s1'::jsonb - 'server_time',
  '{"device_id": "dev-a", "revoked": false, "revoked_at": null, "session_ok": true}'::jsonb,
  'report_device_status answers with the device state');
select throws_ok(
  $$ select public.report_device_status('dev-other', 1, 1, '3.0.0') $$,
  'PT422', 'device_mismatch', 'the device id must match the x-device-id header');
select throws_ok(
  $$ select public.report_device_status('bad id with spaces', 1, 1, '3.0.0') $$,
  'PT422', 'invalid_device_id', 'malformed device ids are rejected');
select tests.logout();

select is(
  (select jsonb_build_object('pending_ops', d.pending_ops, 'pending_photos', d.pending_photos,
                             'app_version', d.app_version, 'seen', d.last_seen_at is not null,
                             'revoked', d.revoked_at is not null)
   from public.devices d where d.user_id = tests.id('u_col_pemba') and d.device_id = 'dev-a'),
  '{"pending_ops": 7, "pending_photos": 3, "app_version": "3.0.0", "seen": true, "revoked": false}'::jsonb,
  'the device row is created with the reported counters');

-- a second report updates the same row; negative numbers are clamped, null keeps the old value
select tests.login_as(tests.id('u_col_pemba'), 'aal1', 'dev-a');
select public.report_device_status('dev-a', -4, null, '3.0.1') as s2 \gset
select tests.logout();
select is(
  (select jsonb_build_object('rows', count(*), 'pending_ops', max(d.pending_ops),
                             'pending_photos', max(d.pending_photos), 'app_version', max(d.app_version))
   from public.devices d where d.user_id = tests.id('u_col_pemba') and d.device_id = 'dev-a'),
  '{"rows": 1, "pending_ops": 0, "pending_photos": 3, "app_version": "3.0.1"}'::jsonb,
  'the next report updates the same row (negative -> 0, null -> unchanged)');

-- the same device id used by another user is a different device row
select tests.login_as(tests.id('u_col_ke'), 'aal1', 'dev-a');
select public.report_device_status('dev-a', 2, 0, '2.9.0') as s3 \gset
select tests.logout();
select is(
  (select count(*)::int from public.devices d where d.device_id = 'dev-a'),
  2, 'devices are per user: another user with the same device id gets an own row');

-- a revoked device may still report (the administrator sees the lost phone), and is told so
update public.devices set revoked_at = now()
where user_id = tests.id('u_col_ke') and device_id = 'dev-a';
select tests.login_as(tests.id('u_col_ke'), 'aal1', 'dev-a');
select public.report_device_status('dev-a', 5, 1, '2.9.0') as s4 \gset
select tests.logout();
select is(
  jsonb_build_object('revoked', :'s4'::jsonb -> 'revoked', 'session_ok', :'s4'::jsonb -> 'session_ok'),
  '{"revoked": true, "session_ok": false}'::jsonb,
  'a revoked device is told that it is revoked');
select is(
  (select d.pending_ops from public.devices d where d.user_id = tests.id('u_col_ke') and d.device_id = 'dev-a'),
  5, 'its heartbeat is still recorded');

-- ---------------------------------------------------------------------------
-- Data for the dashboard
--   u_col_pemba / dev-a : 2 open conflicts (+1 resolved), 2 rejections in the window (+1 older)
--   u_col_pemba / dev-b : stale device (last seen 10 days ago), 1 open conflict
--   u_col_tanga         : no device at all, 1 rejection without device
-- ---------------------------------------------------------------------------
insert into public.devices (user_id, device_id, label, last_seen_at, last_push_at, last_pull_at, pending_ops, pending_photos, app_version)
values (tests.id('u_col_pemba'), 'dev-b', 'Old phone', now() - interval '10 days', now() - interval '11 days',
        now() - interval '10 days', 40, 12, '2.4.0');

insert into public.sync_conflicts
  (table_name, row_id, project_id, field, base_version, server_value, client_value, client_user_id, client_device_id, state)
values
  ('projects', tests.id('p_pemba_1'), tests.id('p_pemba_1'), 'capacity', 1, '100', '120', tests.id('u_col_pemba'), 'dev-a', 'open'),
  ('projects', tests.id('p_pemba_1'), tests.id('p_pemba_1'), 'builder', 1, '"a"', '"b"', tests.id('u_col_pemba'), 'dev-a', 'open'),
  ('projects', tests.id('p_pemba_1'), tests.id('p_pemba_1'), 'status', 1, '"active"', '"inactive"', tests.id('u_col_pemba'), 'dev-a', 'resolved_server'),
  ('projects', tests.id('p_pemba_2'), tests.id('p_pemba_2'), 'capacity', 1, '100', '90', tests.id('u_col_pemba'), 'dev-b', 'open');

select private.log_sync_rejection(
  tests.id('u_col_pemba'), 'dev-a',
  jsonb_build_object('op_id', '00000000-0000-4000-8000-0000000a0001', 'table', 'projects', 'id', tests.id('p_tanga_1')),
  '{"code": "out_of_scope", "message": "project outside your scope"}'::jsonb) is not null as logged1 \gset
select private.log_sync_rejection(
  tests.id('u_col_pemba'), 'dev-a', '{"op_id": "not-a-uuid", "table": "persons"}'::jsonb,
  '{"code": "validation_failed"}'::jsonb) is not null as logged2 \gset
select private.log_sync_rejection(tests.id('u_col_tanga'), null, null, null) is not null as logged3 \gset
insert into private.sync_rejections (rejected_at, user_id, device_id, code)
values (now() - interval '8 days', tests.id('u_col_pemba'), 'dev-a', 'old_rejection');

select is(
  (select jsonb_agg(jsonb_build_object('device_id', r.device_id, 'op_id', r.op_id, 'table_name', r.table_name,
                                       'row_id', r.row_id, 'code', r.code) order by r.id)
   from private.sync_rejections r
   where r.user_id = tests.id('u_col_pemba') and r.rejected_at > now() - interval '1 day'),
  jsonb_build_array(
    jsonb_build_object('device_id', 'dev-a', 'op_id', '00000000-0000-4000-8000-0000000a0001', 'table_name', 'projects',
                       'row_id', tests.id('p_tanga_1'), 'code', 'out_of_scope'),
    jsonb_build_object('device_id', 'dev-a', 'op_id', null, 'table_name', 'persons', 'row_id', null, 'code', 'validation_failed')),
  'log_sync_rejection stores user, device, op, table, row and error code (and tolerates malformed input)');

-- ---------------------------------------------------------------------------
-- sync_status: authorisation
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('u_col_pemba'), 'aal1', 'dev-a');
select throws_ok($$ select public.sync_status() $$, 'PT403', 'forbidden', 'collector: sync_status refused');
select tests.login_as(tests.id('u_sup_pemba'), 'aal1');
select throws_ok($$ select public.sync_status() $$, 'PT403', 'forbidden', 'supervisor: sync_status refused');
select tests.login_as(tests.id('u_viewer_global'), 'aal2');
select throws_ok($$ select public.sync_status() $$, 'PT403', 'forbidden', 'viewer: sync_status refused');
select tests.login_as(tests.id('u_hq'), 'aal1');
select throws_ok($$ select public.sync_status() $$, 'PT403', 'mfa_required', 'hq_admin without MFA: sync_status refused');

-- ---------------------------------------------------------------------------
-- sync_status: hq_admin
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('u_hq'), 'aal2');
select public.sync_status() as st \gset
select tests.logout();

select is(
  jsonb_build_object('scope', :'st'::jsonb -> 'scope', 'country_ids', :'st'::jsonb -> 'country_ids',
                     'window_days', :'st'::jsonb -> 'window_days', 'has_time', :'st'::jsonb ? 'generated_at'),
  '{"scope": "all", "country_ids": null, "window_days": 7, "has_time": true}'::jsonb,
  'hq_admin gets the status of everybody');
select is(
  (select count(*)::int from jsonb_array_elements(:'st'::jsonb -> 'users') u
   where (u ->> 'user_id')::uuid = any (tests.fixture_users())),
  10, 'every user is listed (also the ones without a device)');

select is(
  (select jsonb_build_object(
            'full_name', u -> 'full_name', 'active', u -> 'active', 'role', u -> 'roles' -> 0 -> 'role',
            'device_count', u -> 'device_count', 'pending_ops', u -> 'pending_ops', 'pending_photos', u -> 'pending_photos',
            'open_conflicts', u -> 'open_conflicts', 'rejected_7d', u -> 'rejected_7d',
            'devices', (select jsonb_agg(d ->> 'device_id' order by d ->> 'device_id') from jsonb_array_elements(u -> 'devices') d))
   from jsonb_array_elements(:'st'::jsonb -> 'users') u where (u ->> 'user_id')::uuid = tests.id('u_col_pemba')),
  jsonb_build_object(
    'full_name', 'u_col_pemba', 'active', true, 'role', 'field_collector',
    'device_count', 2, 'pending_ops', 40, 'pending_photos', 15,
    'open_conflicts', 3, 'rejected_7d', 2,
    'devices', '["dev-a", "dev-b"]'::jsonb),
  'per user: devices, pending totals, open conflicts and rejections of the last 7 days (older ones excluded)');

select is(
  (select jsonb_build_object(
            'app_version', d -> 'app_version', 'pending_ops', d -> 'pending_ops', 'pending_photos', d -> 'pending_photos',
            'open_conflicts', d -> 'open_conflicts', 'rejected_7d', d -> 'rejected_7d', 'stale', d -> 'stale',
            'revoked_at', d -> 'revoked_at', 'has_last_seen', (d ->> 'last_seen_at') is not null,
            'has_push_pull_keys', d ? 'last_push_at' and d ? 'last_pull_at')
   from jsonb_array_elements(:'st'::jsonb -> 'users') u, jsonb_array_elements(u -> 'devices') d
   where (u ->> 'user_id')::uuid = tests.id('u_col_pemba') and d ->> 'device_id' = 'dev-a'),
  '{"app_version": "3.0.1", "pending_ops": 0, "pending_photos": 3, "open_conflicts": 2, "rejected_7d": 2,
    "stale": false, "revoked_at": null, "has_last_seen": true, "has_push_pull_keys": true}'::jsonb,
  'per device: version, pending counters, last seen/push/pull, open conflicts (resolved ones excluded) and rejections');
select is(
  (select jsonb_build_object('app_version', d -> 'app_version', 'pending_ops', d -> 'pending_ops',
                             'open_conflicts', d -> 'open_conflicts', 'rejected_7d', d -> 'rejected_7d', 'stale', d -> 'stale',
                             'has_push', (d ->> 'last_push_at') is not null, 'has_pull', (d ->> 'last_pull_at') is not null)
   from jsonb_array_elements(:'st'::jsonb -> 'users') u, jsonb_array_elements(u -> 'devices') d
   where (u ->> 'user_id')::uuid = tests.id('u_col_pemba') and d ->> 'device_id' = 'dev-b'),
  '{"app_version": "2.4.0", "pending_ops": 40, "open_conflicts": 1, "rejected_7d": 0, "stale": true,
    "has_push": true, "has_pull": true}'::jsonb,
  'a device not seen for more than 7 days is flagged stale');

select is(
  (select jsonb_build_object('device_count', u -> 'device_count', 'devices', u -> 'devices',
                             'rejected_7d', u -> 'rejected_7d', 'last_seen_at', u -> 'last_seen_at')
   from jsonb_array_elements(:'st'::jsonb -> 'users') u where (u ->> 'user_id')::uuid = tests.id('u_col_tanga')),
  '{"device_count": 0, "devices": [], "rejected_7d": 1, "last_seen_at": null}'::jsonb,
  'a user without any device is listed; a rejection without device id counts for the user');

select is(
  (select jsonb_build_object('pending_ops', d -> 'pending_ops', 'revoked', (d ->> 'revoked_at') is not null)
   from jsonb_array_elements(:'st'::jsonb -> 'users') u, jsonb_array_elements(u -> 'devices') d
   where (u ->> 'user_id')::uuid = tests.id('u_col_ke') and d ->> 'device_id' = 'dev-a'),
  '{"pending_ops": 5, "revoked": true}'::jsonb,
  'a revoked device stays visible with its last report');
select is(
  (select (u ->> 'pending_ops')::int
   from jsonb_array_elements(:'st'::jsonb -> 'users') u where (u ->> 'user_id')::uuid = tests.id('u_col_ke')),
  0, 'but its outbox does not count as pending work of the user');

select is(
  (select (u ->> 'user_id')::uuid from jsonb_array_elements(:'st'::jsonb -> 'users') with ordinality x(u, o)
   where (u ->> 'user_id')::uuid = any (tests.fixture_users()) order by o limit 1),
  tests.id('u_col_pemba'), 'users that need attention (conflicts, rejections) come first');

select cmp_ok((:'st'::jsonb -> 'summary' ->> 'users')::int, '>=', 10, 'summary: users');
select cmp_ok((:'st'::jsonb -> 'summary' ->> 'devices')::int, '>=', 3, 'summary: devices');
select cmp_ok((:'st'::jsonb -> 'summary' ->> 'pending_ops')::int, '>=', 40, 'summary: pending operations');
select cmp_ok((:'st'::jsonb -> 'summary' ->> 'open_conflicts')::int, '>=', 3, 'summary: open conflicts');
select cmp_ok((:'st'::jsonb -> 'summary' ->> 'rejected_7d')::int, '>=', 3, 'summary: rejections in the last 7 days');
select cmp_ok((:'st'::jsonb -> 'summary' ->> 'stale_devices')::int, '>=', 1, 'summary: stale devices');
select cmp_ok((:'st'::jsonb -> 'summary' ->> 'users_without_device')::int, '>=', 1, 'summary: users without a device');

-- ---------------------------------------------------------------------------
-- sync_status: country managers see their own country
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('u_mgr_tz'), 'aal2');
select public.sync_status() as stz \gset
select tests.login_as(tests.id('u_mgr_ke'), 'aal2');
select public.sync_status() as ske \gset
select tests.logout();

select is(
  jsonb_build_object(
    'scope', :'stz'::jsonb -> 'scope', 'country_ids', :'stz'::jsonb -> 'country_ids',
    'users', (select jsonb_agg(u ->> 'full_name' order by u ->> 'full_name')
              from jsonb_array_elements(:'stz'::jsonb -> 'users') u
              where (u ->> 'user_id')::uuid = any (tests.fixture_users()))),
  jsonb_build_object(
    'scope', 'country', 'country_ids', jsonb_build_array(tests.id('tz')),
    'users', '["u_col_pemba", "u_col_pemba2", "u_col_tanga", "u_mgr_tz", "u_sup_pemba", "u_viewer_tz"]'::jsonb),
  'the Tanzania manager gets the Tanzanian users only');
select is(
  (select jsonb_agg(u ->> 'full_name' order by u ->> 'full_name')
   from jsonb_array_elements(:'ske'::jsonb -> 'users') u
   where (u ->> 'user_id')::uuid = any (tests.fixture_users())),
  '["u_col_ke", "u_mgr_ke"]'::jsonb,
  'the Kenya manager gets the Kenyan users only');

-- ---------------------------------------------------------------------------
-- Housekeeping
-- ---------------------------------------------------------------------------
insert into private.sync_rejections (rejected_at, user_id, code)
values (now() - interval '40 days', tests.id('u_col_pemba'), 'ancient');
select cmp_ok(private.sync_rejections_cleanup(), '>=', 1, 'sync_rejections_cleanup() removes rows older than 30 days');

select * from finish();
rollback;

-- =============================================================================
-- 40  private.rate_limit / private.rate_limit_cleanup / private.log_restricted
--     (migration 0040; brief §11 "rate limiting on RPC", "access log")
-- =============================================================================
begin;
set local search_path = public, extensions, tests;

select plan(27);

select tests.fixture();

-- ---------------------------------------------------------------------------
-- Objects and privileges
-- ---------------------------------------------------------------------------
select has_function('private', 'rate_limit', array['text', 'integer', 'interval'],
  'private.rate_limit(text, integer, interval) exists');
select has_function('private', 'log_restricted', array['text', 'uuid[]', 'text'],
  'private.log_restricted(text, uuid[], text) exists');

select ok(not has_function_privilege('anon', 'private.rate_limit(text, integer, interval)', 'execute'),
  'anon cannot execute private.rate_limit');
select ok(has_function_privilege('authenticated', 'private.rate_limit(text, integer, interval)', 'execute'),
  'authenticated can execute private.rate_limit (used by SECURITY INVOKER RPCs)');
select ok(not has_function_privilege('authenticated', 'private.log_restricted(text, uuid[], text)', 'execute'),
  'authenticated cannot execute private.log_restricted directly');
select ok(not has_table_privilege('authenticated', 'private.rate_limit_buckets', 'select, insert, update, delete'),
  'authenticated has no privilege on private.rate_limit_buckets');

-- ---------------------------------------------------------------------------
-- The limiter trips exactly at the limit
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('u_col_pemba'), 'aal1');

select lives_ok($$ select private.rate_limit('t40_key', 3, interval '1 hour') $$, 'call 1 of 3 passes');
select lives_ok($$ select private.rate_limit('t40_key', 3, interval '1 hour') $$, 'call 2 of 3 passes');
select lives_ok($$ select private.rate_limit('t40_key', 3, interval '1 hour') $$, 'call 3 of 3 passes');
select throws_ok($$ select private.rate_limit('t40_key', 3, interval '1 hour') $$,
  'PT429', 'rate_limited', 'call 4 raises PT429 rate_limited');
select throws_ok($$ select private.rate_limit('t40_key', 3, interval '1 hour') $$,
  'PT429', 'rate_limited', 'and it keeps failing inside the same window');

-- another key of the same user is independent
select lives_ok($$ select private.rate_limit('t40_other_key', 1, interval '1 hour') $$,
  'a different key has its own counter');

-- another user is not affected (and is never blocked by the first user's bucket)
select tests.login_as(tests.id('u_col_tanga'), 'aal1');
select lives_ok($$ select private.rate_limit('t40_key', 3, interval '1 hour') $$,
  'another user has an own bucket for the same key');
select tests.logout();

select is(
  (select b.hits from private.rate_limit_buckets b
   where b.user_id = tests.id('u_col_pemba') and b.bucket_key = 't40_key'),
  3, 'the rejected calls are not counted: the bucket stays at the limit');

-- ---------------------------------------------------------------------------
-- Next window: the counter starts again and the finished window is removed
-- (simulated by moving the stored window one hour into the past)
-- ---------------------------------------------------------------------------
update private.rate_limit_buckets b
set window_start = b.window_start - interval '1 hour',
    expires_at = b.expires_at - interval '1 hour'
where b.user_id = tests.id('u_col_pemba') and b.bucket_key = 't40_key';

select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select lives_ok($$ select private.rate_limit('t40_key', 3, interval '1 hour') $$,
  'the next window starts from zero');
select tests.logout();

select is(
  (select array_agg(b.hits order by b.window_start) from private.rate_limit_buckets b
   where b.user_id = tests.id('u_col_pemba') and b.bucket_key = 't40_key'),
  array[1], 'the finished window of the caller was cleaned up; the new one has one hit');

-- ---------------------------------------------------------------------------
-- The same with real time: a 2-second window (aligned so that the three calls
-- cannot straddle a window boundary)
-- ---------------------------------------------------------------------------
select pg_sleep(2 - (extract(epoch from clock_timestamp())::numeric % 2) + 0.05) is not null as aligned \gset

select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select lives_ok($$ select private.rate_limit('t40_fast', 2, interval '2 seconds') $$, 'short window: call 1 passes');
select lives_ok($$ select private.rate_limit('t40_fast', 2, interval '2 seconds') $$, 'short window: call 2 passes');
select throws_ok($$ select private.rate_limit('t40_fast', 2, interval '2 seconds') $$,
  'PT429', 'rate_limited', 'short window: call 3 is refused');
select pg_sleep(2.0) is not null as waited \gset
select lives_ok($$ select private.rate_limit('t40_fast', 2, interval '2 seconds') $$,
  'short window: allowed again after the window has passed');

-- ---------------------------------------------------------------------------
-- Arguments, kill switch, housekeeping
-- ---------------------------------------------------------------------------
select throws_ok($$ select private.rate_limit('t40_bad', 0, interval '1 minute') $$,
  '22023', null, 'a limit below 1 is rejected');
select throws_ok($$ select private.rate_limit('', 5, interval '1 minute') $$,
  '22023', null, 'an empty key is rejected');
select tests.logout();

select set_config('app.rate_limit', 'off', true) is not null as switched_off \gset
select tests.login_as(tests.id('u_col_pemba'), 'aal1');
select lives_ok(
  $$ select private.rate_limit('t40_off', 1, interval '1 hour') from generate_series(1, 5) $$,
  'app.rate_limit = off disables the limiter (load tests)');
select tests.logout();
select set_config('app.rate_limit', '', true) is not null as switched_on \gset

insert into private.rate_limit_buckets (user_id, bucket_key, window_start, hits, expires_at)
values (tests.id('u_col_ke'), 't40_old', now() - interval '3 hours', 9, now() - interval '2 hours');
select cmp_ok(private.rate_limit_cleanup(interval '10 minutes'), '>=', 1,
  'rate_limit_cleanup() removes finished windows');
select is(
  (select count(*)::int from private.rate_limit_buckets b where b.bucket_key = 't40_old'),
  0, 'the expired bucket is gone');

-- ---------------------------------------------------------------------------
-- log_restricted (called here the way SECURITY DEFINER code calls it: as the
-- owner, with the end user's JWT and device header in place)
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('u_mgr_tz'), 'aal2', 'dev-log');
select set_config('role', 'none', true) is not null as owner_again \gset

select private.log_restricted(
  'staff_compensation',
  array[tests.id('comp:p_pemba_1'), tests.id('comp:p_tanga_1')],
  't40 context') is not null as logged \gset

select is(
  (select jsonb_build_object(
            'user_id', l.user_id, 'device_id', l.device_id, 'table_name', l.table_name,
            'row_count', l.row_count, 'ids', cardinality(l.row_ids))
   from public.restricted_access_log l
   where l.context = 't40 context'),
  jsonb_build_object(
    'user_id', tests.id('u_mgr_tz'), 'device_id', 'dev-log', 'table_name', 'staff_compensation',
    'row_count', 2, 'ids', 2),
  'log_restricted records who, device, table, ids and count');

select throws_ok(
  $$ select private.log_restricted('projects', array[]::uuid[], 't40') $$,
  '22023', null, 'log_restricted refuses a table that is not restricted');
select tests.logout();

select * from finish();
rollback;

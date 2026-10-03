-- =============================================================================
-- 0040  Rate limiting and restricted-access logging helpers
--       (docs/ARCHITECTURE.md Appendix A.3; brief §11)
--
--   private.rate_limit(p_key, p_max, p_window)        raises PT429 (HTTP 429)
--   private.rate_limit_cleanup(p_grace)               housekeeping (cron)
--   private.log_restricted(p_table, p_ids, p_context) one restricted_access_log row
--
-- Details and usage rules: docs/contracts/people-admin.md
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Sanity check: pg_trgm needs a database whose LC_CTYPE classifies non-ASCII
-- letters as letters. With LC_CTYPE = "C" it extracts no trigrams at all from
-- Arabic text, so person matching and Arabic search silently return nothing.
-- Supabase (en_US.UTF-8 / C.UTF-8) is fine; this only warns self-hosted setups.
-- -----------------------------------------------------------------------------
do $$
begin
  if cardinality(extensions.show_trgm(U&'\0645\062D\0645\062F')) = 0 then
    raise warning 'pg_trgm extracts no trigrams from Arabic text in this database (LC_CTYPE is probably "C"): person_candidates, search and duplicate detection will not match Arabic names. Create the database with a UTF-8 aware LC_CTYPE (for example en_US.UTF-8).';
  end if;
exception
  when undefined_function or invalid_schema_name then
    raise warning 'pg_trgm is not installed in schema "extensions"; person matching will not work';
end
$$;

-- -----------------------------------------------------------------------------
-- Buckets: one row per (caller, key, window start). UNLOGGED: counters are
-- disposable, must be cheap to write and may be lost on a crash.
-- The table is created by the core migration (0005); the statements below are
-- no-ops there and only keep this file self-sufficient.
-- -----------------------------------------------------------------------------
create unlogged table if not exists private.rate_limit_buckets (
  user_id      uuid        not null,
  bucket_key   text        not null,
  window_start timestamptz not null,
  hits         integer     not null default 0,
  expires_at   timestamptz not null,
  constraint rate_limit_buckets_pkey primary key (user_id, bucket_key, window_start)
);

create index if not exists rate_limit_buckets_expires_idx
  on private.rate_limit_buckets (expires_at);

alter table private.rate_limit_buckets enable row level security;
alter table private.rate_limit_buckets force row level security;
revoke all on table private.rate_limit_buckets from public, anon, authenticated;

comment on table private.rate_limit_buckets is
  'Fixed-window request counters used by private.rate_limit(). Unlogged; written only by SECURITY DEFINER code.';

-- -----------------------------------------------------------------------------
-- private.rate_limit
--
-- Fixed window counter per caller (auth.uid(); the nil UUID when there is no
-- user) and key. The upsert is atomic: concurrent calls of the SAME caller on
-- the SAME key serialise on one row; different callers never touch the same
-- row, so nobody blocks anybody else.
--
-- When the limit is exceeded the function raises SQLSTATE PT429 (message
-- "rate_limited", the limit in DETAIL, the wait in HINT), which PostgREST
-- turns into HTTP 429. The failed call's own increment is rolled
-- back with the caller's transaction, so the counter stays at p_max until the
-- window ends and the next window starts from zero.
--
-- The function writes, therefore every function that calls it must be VOLATILE
-- and must be invoked through POST (PostgREST runs GET in a read-only
-- transaction).
--
-- Load tests that share a few accounts between many virtual users can switch
-- the limiter off for a database or role:
--     alter database <db> set app.rate_limit = 'off';
-- API clients cannot set this parameter.
-- -----------------------------------------------------------------------------
create or replace function private.rate_limit(p_key text, p_max integer, p_window interval)
returns void
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_uid   uuid := coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid);
  v_secs  double precision := extract(epoch from p_window);
  v_now   timestamptz := clock_timestamp();
  v_start timestamptz;
  v_end   timestamptz;
  v_hits  integer;
begin
  if p_key is null or btrim(p_key) = '' or p_max is null or p_max < 1
     or v_secs is null or v_secs < 1 then
    raise exception 'rate_limit: invalid arguments (key=%, max=%, window=%)', p_key, p_max, p_window
      using errcode = '22023';
  end if;

  if coalesce(current_setting('app.rate_limit', true), '') = 'off' then
    return;
  end if;

  v_start := to_timestamp(floor(extract(epoch from v_now) / v_secs) * v_secs);
  v_end   := v_start + p_window;

  insert into private.rate_limit_buckets as b (user_id, bucket_key, window_start, hits, expires_at)
  values (v_uid, p_key, v_start, 1, v_end)
  on conflict (user_id, bucket_key, window_start)
  do update set hits = b.hits + 1
  returning b.hits into v_hits;

  if v_hits = 1 then
    -- First hit of a new window: drop this caller's finished windows for the key.
    delete from private.rate_limit_buckets o
    where o.user_id = v_uid
      and o.bucket_key = p_key
      and o.window_start < v_start
      and o.expires_at <= v_now;
  end if;

  if v_hits > p_max then
    raise exception 'rate_limited'
      using errcode = 'PT429',
            detail = format('Too many requests: "%s" is limited to %s calls per %s.', p_key, p_max, p_window),
            hint = format('Retry in %s seconds.',
                          greatest(1, ceil(extract(epoch from v_end - v_now))::integer));
  end if;
end;
$$;

comment on function private.rate_limit(text, integer, interval) is
  'Fixed-window rate limiter per caller and key; raises SQLSTATE PT429 when more than p_max calls are made inside p_window. Callers must be VOLATILE.';

-- -----------------------------------------------------------------------------
-- private.rate_limit_cleanup — removes finished windows of callers that never
-- came back (active callers clean up after themselves). Safe to run at any
-- time; schedule it with the other cron jobs (hourly is plenty).
-- -----------------------------------------------------------------------------
create or replace function private.rate_limit_cleanup(p_grace interval default interval '10 minutes')
returns integer
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_deleted integer;
begin
  delete from private.rate_limit_buckets b
  where b.expires_at < clock_timestamp() - coalesce(p_grace, interval '10 minutes');
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

comment on function private.rate_limit_cleanup(interval) is
  'Deletes rate-limit windows that ended more than p_grace ago; returns the number of rows removed.';

-- -----------------------------------------------------------------------------
-- private.log_restricted — the single writer of public.restricted_access_log
-- (brief §11: who read which restricted record, and when).
--
-- Call it exactly once per statement/page that returns rows of a restricted
-- table to a caller, with the ids of the restricted rows that were returned.
-- A call with an empty id list is still recorded (it documents the attempt).
-- -----------------------------------------------------------------------------
create or replace function private.log_restricted(p_table text, p_ids uuid[], p_context text)
returns void
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  if p_table is null or p_table not in ('staff_compensation', 'community_sensitive') then
    raise exception 'log_restricted: "%" is not a restricted table', p_table
      using errcode = '22023';
  end if;

  insert into public.restricted_access_log (user_id, table_name, row_ids, row_count, context, device_id, accessed_at)
  values (
    auth.uid(),
    p_table,
    coalesce(p_ids, '{}'::uuid[]),
    coalesce(cardinality(p_ids), 0),
    nullif(left(btrim(coalesce(p_context, '')), 200), ''),
    private.device_id(),
    clock_timestamp()
  );
end;
$$;

comment on function private.log_restricted(text, uuid[], text) is
  'Appends one row to restricted_access_log: caller, device, table, ids of the restricted rows returned, count and context.';

-- -----------------------------------------------------------------------------
-- Privileges. rate_limit may be called from SECURITY INVOKER RPCs, so API
-- roles can execute it (schema private is not exposed through PostgREST).
-- log_restricted and the cleanup are for SECURITY DEFINER code and jobs only.
-- -----------------------------------------------------------------------------
revoke execute on function private.rate_limit(text, integer, interval) from public, anon;
grant  execute on function private.rate_limit(text, integer, interval) to authenticated, service_role;

revoke execute on function private.rate_limit_cleanup(interval) from public, anon, authenticated;
grant  execute on function private.rate_limit_cleanup(interval) to service_role;

revoke execute on function private.log_restricted(text, uuid[], text) from public, anon, authenticated;
grant  execute on function private.log_restricted(text, uuid[], text) to service_role;

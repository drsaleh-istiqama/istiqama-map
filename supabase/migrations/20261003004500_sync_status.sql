-- =============================================================================
-- 0045  Sync status dashboard (brief §1 "monitoring: sync status board", §4.5)
--
--   report_device_status(p_device_id, p_pending_ops, p_pending_photos, p_app_version)
--       called by the client after every sync cycle: heartbeat + outbox sizes
--   sync_status()
--       hq_admin: every user; country_manager: users of the own country.
--       Per user and device: last_seen_at, last_push_at, last_pull_at,
--       pending_ops, pending_photos, app_version, open conflicts, operations
--       rejected by sync_push in the last 7 days.
--
-- JSON shapes: docs/contracts/people-admin.md
-- =============================================================================

-- -----------------------------------------------------------------------------
-- private.sync_rejections — log of operations rejected by sync_push.
--
-- sync_push applies every operation in its own sub-transaction and does NOT
-- keep rejected operations in the idempotency ledger (they may be retried), so
-- nothing else on the server remembers them. sync_push (migration 0023) calls
-- private.log_sync_rejection() once for every result with status "rejected"
-- (errors of the op's sub-transaction, invalid_op, op_id_taken), outside the
-- rolled-back sub-transaction; sync_status() counts the last 7 days from here.
-- Rows are disposable diagnostics: private.sync_rejections_cleanup() removes
-- everything older than 30 days.
-- -----------------------------------------------------------------------------
create table if not exists private.sync_rejections (
  id          bigint      generated always as identity primary key,
  rejected_at timestamptz not null default now(),
  user_id     uuid        not null,
  device_id   text,
  op_id       uuid,
  table_name  text,
  row_id      uuid,
  code        text,
  error       jsonb
);

create index if not exists sync_rejections_user_idx
  on private.sync_rejections (user_id, rejected_at);
create index if not exists sync_rejections_rejected_at_brin
  on private.sync_rejections using brin (rejected_at);

alter table private.sync_rejections enable row level security;
alter table private.sync_rejections force row level security;
revoke all on table private.sync_rejections from public, anon, authenticated;

comment on table private.sync_rejections is
  'Operations rejected by sync_push (who, device, table, row, error code). Feeds sync_status(); pruned after 30 days.';

-- p_op is the operation as sent by the client ({op_id, table, id, ...});
-- p_error is the error object returned to the client ({code, message}).
-- Never raises: a logging problem must not turn a rejected op into a failed push.
create or replace function private.log_sync_rejection(
  p_user_id   uuid,
  p_device_id text,
  p_op        jsonb,
  p_error     jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  c_uuid constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
begin
  if p_user_id is null then
    return;
  end if;
  insert into private.sync_rejections (user_id, device_id, op_id, table_name, row_id, code, error)
  values (
    p_user_id,
    left(p_device_id, 128),
    case when p_op ->> 'op_id' ~ c_uuid then (p_op ->> 'op_id')::uuid end,
    left(p_op ->> 'table', 63),
    case when p_op ->> 'id' ~ c_uuid then (p_op ->> 'id')::uuid end,
    left(p_error ->> 'code', 100),
    p_error);
exception
  when others then
    raise warning 'log_sync_rejection failed: %', sqlerrm;
end;
$$;

comment on function private.log_sync_rejection(uuid, text, jsonb, jsonb) is
  'Records one operation rejected by sync_push. Call it outside the rolled-back sub-transaction. Never raises.';

create or replace function private.sync_rejections_cleanup(p_keep interval default interval '30 days')
returns integer
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_deleted integer;
begin
  delete from private.sync_rejections r
  where r.rejected_at < now() - coalesce(p_keep, interval '30 days');
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

comment on function private.sync_rejections_cleanup(interval) is
  'Deletes sync rejection log rows older than p_keep (default 30 days); returns the number of rows removed.';

revoke execute on function private.log_sync_rejection(uuid, text, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function private.sync_rejections_cleanup(interval) from public, anon, authenticated;
grant  execute on function private.log_sync_rejection(uuid, text, jsonb, jsonb) to service_role;
grant  execute on function private.sync_rejections_cleanup(interval) to service_role;

-- -----------------------------------------------------------------------------
-- public.report_device_status
--
-- Upserts the caller's own device row. A revoked device or a revoked session
-- may still report: the heartbeat of a lost phone is exactly what an
-- administrator wants to see. The answer tells the client whether it has been
-- revoked so that it can lock itself.
-- -----------------------------------------------------------------------------
create or replace function public.report_device_status(
  p_device_id      text,
  p_pending_ops    integer,
  p_pending_photos integer,
  p_app_version    text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_header  text;
  v_revoked timestamptz;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = 'PT401';
  end if;
  if p_device_id is null or p_device_id !~ '^[A-Za-z0-9._:-]{1,128}$' then
    raise exception 'invalid_device_id' using errcode = 'PT422',
      detail = 'device id must be 1-128 characters of [A-Za-z0-9._:-]';
  end if;

  -- Same rule as register_device(): the header is what session_ok() checks.
  v_header := nullif(btrim(nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-device-id'), '');
  if v_header is not null and v_header <> p_device_id then
    raise exception 'device_mismatch' using errcode = 'PT422',
      detail = 'x-device-id header and p_device_id differ';
  end if;

  perform private.rate_limit('report_device_status', 60, interval '1 minute');

  insert into public.devices as d
    (user_id, device_id, app_version, last_seen_at, pending_ops, pending_photos)
  values
    (v_uid, p_device_id, nullif(left(btrim(coalesce(p_app_version, '')), 40), ''), now(),
     greatest(coalesce(p_pending_ops, 0), 0), greatest(coalesce(p_pending_photos, 0), 0))
  on conflict (user_id, device_id) do update
    set app_version    = coalesce(excluded.app_version, d.app_version),
        last_seen_at   = now(),
        pending_ops    = case when p_pending_ops is null then d.pending_ops else greatest(p_pending_ops, 0) end,
        pending_photos = case when p_pending_photos is null then d.pending_photos else greatest(p_pending_photos, 0) end,
        deleted_at     = null
  returning d.revoked_at into v_revoked;

  return jsonb_build_object(
    'device_id', p_device_id,
    'revoked', v_revoked is not null,
    'revoked_at', v_revoked,
    'session_ok', coalesce(private.session_ok(), false),
    'server_time', clock_timestamp());
end;
$$;

comment on function public.report_device_status(text, integer, integer, text) is
  'Heartbeat after a sync cycle: stores pending operation/photo counts and the app version on the caller''s device row; returns {revoked, session_ok}.';

-- -----------------------------------------------------------------------------
-- public.sync_status
-- -----------------------------------------------------------------------------
create or replace function public.sync_status()
returns jsonb
language plpgsql
volatile            -- because of private.rate_limit(); the function itself only reads
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  c_stale constant interval := interval '7 days';
  v_scope  record;
  v_now    timestamptz := now();
  v_since  timestamptz := now() - interval '7 days';
  v_result jsonb;
begin
  v_scope := private.admin_scope(true);
  perform private.rate_limit('admin_read', 120, interval '1 minute');

  with u as materialized (
    select p.id, p.full_name, p.active
    from public.profiles p
    where p.deleted_at is null
      and (v_scope.is_hq or private.admin_user_in_countries(p.id, v_scope.countries))
  ),
  conf as materialized (
    select sc.client_user_id as user_id, coalesce(sc.client_device_id, '') as device_id, count(*) as n
    from public.sync_conflicts sc
    where sc.state = 'open'
      and sc.deleted_at is null
      and sc.client_user_id is not null
    group by 1, 2
  ),
  rej as materialized (
    select o.user_id, coalesce(o.device_id, '') as device_id, count(*) as n
    from private.sync_rejections o
    where o.rejected_at >= v_since
    group by 1, 2
  ),
  dev as materialized (
    select
      d.user_id, d.id, d.device_id, d.label, d.user_agent, d.app_version,
      d.last_seen_at, d.last_push_at, d.last_pull_at, d.pending_ops, d.pending_photos, d.revoked_at,
      coalesce(c.n, 0) as open_conflicts,
      coalesce(r.n, 0) as rejected_7d,
      (d.revoked_at is null and (d.last_seen_at is null or d.last_seen_at < v_now - c_stale)) as stale
    from public.devices d
    join u on u.id = d.user_id
    left join conf c on c.user_id = d.user_id and c.device_id = d.device_id
    left join rej r on r.user_id = d.user_id and r.device_id = d.device_id
    where d.deleted_at is null
  ),
  per_user as (
    select
      u.id,
      u.full_name,
      u.active,
      private.norm(coalesce(u.full_name, '')) as sort_name,
      coalesce((select sum(c.n) from conf c where c.user_id = u.id), 0) as open_conflicts,
      coalesce((select sum(r.n) from rej r where r.user_id = u.id), 0) as rejected_7d,
      coalesce(dv.device_count, 0) as device_count,
      coalesce(dv.pending_ops, 0) as pending_ops,
      coalesce(dv.pending_photos, 0) as pending_photos,
      coalesce(dv.stale_devices, 0) as stale_devices,
      dv.last_seen_at,
      dv.last_push_at,
      dv.last_pull_at,
      coalesce(dv.devices, '[]'::jsonb) as devices,
      coalesce(ro.roles, '[]'::jsonb) as roles
    from u
    left join lateral (
      select
        count(*) as device_count,
        sum(d.pending_ops) filter (where d.revoked_at is null) as pending_ops,
        sum(d.pending_photos) filter (where d.revoked_at is null) as pending_photos,
        count(*) filter (where d.stale) as stale_devices,
        max(d.last_seen_at) as last_seen_at,
        max(d.last_push_at) as last_push_at,
        max(d.last_pull_at) as last_pull_at,
        jsonb_agg(
          jsonb_build_object(
            'id', d.id,
            'device_id', d.device_id,
            'label', d.label,
            'user_agent', d.user_agent,
            'app_version', d.app_version,
            'last_seen_at', d.last_seen_at,
            'last_push_at', d.last_push_at,
            'last_pull_at', d.last_pull_at,
            'pending_ops', d.pending_ops,
            'pending_photos', d.pending_photos,
            'open_conflicts', d.open_conflicts,
            'rejected_7d', d.rejected_7d,
            'stale', d.stale,
            'revoked_at', d.revoked_at)
          order by d.last_seen_at desc nulls last, d.device_id) as devices
      from dev d
      where d.user_id = u.id
    ) dv on true
    left join lateral (
      select jsonb_agg(
               jsonb_build_object('role', ur.role, 'scope_type', ur.scope_type, 'scope_id', ur.scope_id)
               order by ur.role, ur.scope_type, ur.scope_id) as roles
      from public.user_roles ur
      where ur.user_id = u.id
        and ur.deleted_at is null
    ) ro on true
  )
  select jsonb_build_object(
    'generated_at', clock_timestamp(),
    'scope', case when v_scope.is_hq then 'all' else 'country' end,
    'country_ids', case when v_scope.is_hq then null else to_jsonb(v_scope.countries) end,
    'window_days', 7,
    'summary', jsonb_build_object(
      'users', count(*),
      'users_without_device', count(*) filter (where pu.device_count = 0),
      'devices', coalesce(sum(pu.device_count), 0),
      'stale_devices', coalesce(sum(pu.stale_devices), 0),
      'pending_ops', coalesce(sum(pu.pending_ops), 0),
      'pending_photos', coalesce(sum(pu.pending_photos), 0),
      'open_conflicts', coalesce(sum(pu.open_conflicts), 0),
      'rejected_7d', coalesce(sum(pu.rejected_7d), 0)),
    'users', coalesce(
      jsonb_agg(
        jsonb_build_object(
          'user_id', pu.id,
          'full_name', pu.full_name,
          'active', pu.active,
          'roles', pu.roles,
          'device_count', pu.device_count,
          'pending_ops', pu.pending_ops,
          'pending_photos', pu.pending_photos,
          'open_conflicts', pu.open_conflicts,
          'rejected_7d', pu.rejected_7d,
          'last_seen_at', pu.last_seen_at,
          'last_push_at', pu.last_push_at,
          'last_pull_at', pu.last_pull_at,
          'devices', pu.devices)
        -- users that need attention first, then by name
        order by (pu.open_conflicts + pu.rejected_7d) desc, pu.pending_ops desc, pu.sort_name, pu.id),
      '[]'::jsonb))
  into v_result
  from per_user pu;

  return v_result;
end;
$$;

comment on function public.sync_status() is
  'Sync status board: per user and device last seen/push/pull, pending operations and photos, app version, open conflicts and operations rejected in the last 7 days. hq_admin: all users; country_manager: users of the own country.';

-- -----------------------------------------------------------------------------
-- Privileges
-- -----------------------------------------------------------------------------
revoke execute on function public.report_device_status(text, integer, integer, text) from public, anon;
revoke execute on function public.sync_status() from public, anon;

grant execute on function public.report_device_status(text, integer, integer, text) to authenticated, service_role;
grant execute on function public.sync_status() to authenticated, service_role;

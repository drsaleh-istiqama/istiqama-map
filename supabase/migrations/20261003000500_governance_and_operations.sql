-- =============================================================================
-- 0005  Governance and operational tables
--       profiles, user_roles, devices, audit_log, sync_conflicts, sync_applied_ops,
--       restricted_access_log, export_jobs, notifications, import_batches,
--       import_rows, map_packs, app_settings,
--       private.rate_limit_buckets, private.project_code_counters
--       (brief §2.6, §3, §4, §9, §10, §11)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- profiles (id = auth.users.id)
-- -----------------------------------------------------------------------------
create table public.profiles (
  id                  uuid        primary key references auth.users (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid        references auth.users (id),
  updated_by          uuid        references auth.users (id),
  version             integer     not null default 1,
  deleted_at          timestamptz,

  full_name           text,
  phone               text,
  preferred_language  text        not null default 'ar',
  active              boolean     not null default true,
  sessions_revoked_at timestamptz,

  constraint profiles_language_ck check (preferred_language in ('ar', 'sw', 'en'))
);

comment on table public.profiles is
  'One row per auth user. active = false blocks the account; sessions_revoked_at invalidates every token issued before it.';

-- -----------------------------------------------------------------------------
-- user_roles
-- -----------------------------------------------------------------------------
create table public.user_roles (
  id         uuid        primary key default private.uuid_v7(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid        references auth.users (id),
  updated_by uuid        references auth.users (id),
  version    integer     not null default 1,
  deleted_at timestamptz,

  user_id    uuid        not null references auth.users (id),
  role       text        not null,
  scope_type text        not null,
  scope_id   uuid,                -- countries.id or branches.id (validated by trigger)

  constraint user_roles_role_ck check (
    role in ('field_collector', 'branch_supervisor', 'country_manager', 'hq_admin', 'viewer')
  ),
  constraint user_roles_scope_type_ck check (scope_type in ('global', 'country', 'branch')),
  constraint user_roles_scope_id_ck check ((scope_type = 'global') = (scope_id is null)),
  constraint user_roles_hq_global_ck check (role <> 'hq_admin' or scope_type = 'global')
);

-- One live grant per (user, role, scope); NULL scope ids (global) count as equal.
create unique index user_roles_live_key on public.user_roles (user_id, role, scope_type, scope_id)
  nulls not distinct
  where deleted_at is null;
create index user_roles_scope_idx on public.user_roles (scope_id) where scope_id is not null;

comment on table public.user_roles is
  'Role grants. scope_type global: scope_id NULL; country: countries.id; branch: branches.id. hq_admin is always global.';

-- -----------------------------------------------------------------------------
-- devices — one row per (user, device); heartbeat for the sync-status board
-- -----------------------------------------------------------------------------
create table public.devices (
  id             uuid        primary key default private.uuid_v7(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid        references auth.users (id),
  updated_by     uuid        references auth.users (id),
  version        integer     not null default 1,
  deleted_at     timestamptz,

  user_id        uuid        not null references auth.users (id),
  device_id      text        not null,
  label          text,
  user_agent     text,
  last_seen_at   timestamptz,
  last_push_at   timestamptz,
  last_pull_at   timestamptz,
  pending_ops    integer     not null default 0,
  pending_photos integer     not null default 0,
  app_version    text,
  revoked_at     timestamptz,

  constraint devices_user_device_key unique (user_id, device_id),
  constraint devices_device_id_ck check (btrim(device_id) <> '' and length(device_id) <= 128),
  constraint devices_pending_ops_ck check (pending_ops >= 0),
  constraint devices_pending_photos_ck check (pending_photos >= 0)
);

create index devices_last_seen_idx on public.devices (last_seen_at);

-- -----------------------------------------------------------------------------
-- audit_log — append-only, written by private.tg_audit() on every table
-- -----------------------------------------------------------------------------
create table public.audit_log (
  id             bigint      generated always as identity primary key,
  created_at     timestamptz not null default now(),
  table_name     text        not null,
  row_id         uuid        not null,
  op             text        not null,
  old_data       jsonb,
  new_data       jsonb,
  changed_fields text[],
  row_version    integer,
  user_id        uuid,
  device_id      text,

  constraint audit_log_op_ck check (op in ('INSERT', 'UPDATE', 'DELETE'))
);

-- sync_push field merge: "which fields changed on the server since base_version".
create index audit_log_row_idx on public.audit_log (table_name, row_id, row_version);
create index audit_log_created_at_brin on public.audit_log using brin (created_at);

comment on table public.audit_log is
  'Append-only change log (old/new row as JSONB, geometry as EWKT). No foreign keys on purpose: the log must never block or be changed by other operations.';
comment on column public.audit_log.changed_fields is
  'UPDATE only: columns whose value changed, without updated_at/updated_by/version/sync_xid. NULL for INSERT and DELETE.';
comment on column public.audit_log.row_version is
  'version of the row after the operation (before it for DELETE).';

-- -----------------------------------------------------------------------------
-- sync_conflicts — same field changed on two sides; a supervisor decides
-- -----------------------------------------------------------------------------
create table public.sync_conflicts (
  id               uuid        primary key default private.uuid_v7(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid        references auth.users (id),
  updated_by       uuid        references auth.users (id),
  version          integer     not null default 1,
  deleted_at       timestamptz,
  sync_xid         bigint      not null default private.current_xid(),

  table_name       text        not null,
  row_id           uuid        not null,
  project_id       uuid        references public.projects (id),   -- scope of the conflict
  field            text        not null,
  base_version     integer,
  server_value     jsonb,
  client_value     jsonb,
  client_user_id   uuid        references auth.users (id),
  client_device_id text,
  client_op_id     uuid,
  state            text        not null default 'open',
  resolved_by      uuid        references auth.users (id),
  resolved_at      timestamptz,

  constraint sync_conflicts_state_ck check (state in ('open', 'resolved_server', 'resolved_client'))
);

create index sync_conflicts_row_idx on public.sync_conflicts (table_name, row_id);
create index sync_conflicts_project_idx on public.sync_conflicts (project_id);
create index sync_conflicts_open_idx on public.sync_conflicts (created_at) where state = 'open' and deleted_at is null;
create index sync_conflicts_sync_idx on public.sync_conflicts (sync_xid, id);

-- -----------------------------------------------------------------------------
-- sync_applied_ops — idempotency ledger of sync_push
-- -----------------------------------------------------------------------------
create table public.sync_applied_ops (
  op_id      uuid        primary key,
  user_id    uuid        not null references auth.users (id),
  device_id  text,
  result     jsonb       not null,
  applied_at timestamptz not null default now()
);

create index sync_applied_ops_applied_at_brin on public.sync_applied_ops using brin (applied_at);

comment on table public.sync_applied_ops is
  'One row per applied sync_push operation; a repeated op_id returns the stored result. Old rows may be pruned by a maintenance job.';

-- -----------------------------------------------------------------------------
-- restricted_access_log — who read which restricted rows, and when (brief §11)
-- -----------------------------------------------------------------------------
create table public.restricted_access_log (
  id          bigint      generated always as identity primary key,
  accessed_at timestamptz not null default now(),
  user_id     uuid,
  device_id   text,
  table_name  text        not null,
  row_ids     uuid[]      not null default '{}',
  row_count   integer     not null default 0,
  context     text,

  constraint restricted_access_log_table_ck check (table_name in ('staff_compensation', 'community_sensitive'))
);

create index restricted_access_log_user_idx on public.restricted_access_log (user_id, accessed_at);
create index restricted_access_log_accessed_at_brin on public.restricted_access_log using brin (accessed_at);
create index restricted_access_log_rows_gin on public.restricted_access_log using gin (row_ids);

comment on table public.restricted_access_log is
  'Append-only. One row per read of a restricted table (written by private.log_restricted).';

-- -----------------------------------------------------------------------------
-- export_jobs — asynchronous server-side exports
--   queued -> running -> done | failed;  queued|running -> cancelled;  done -> expired
-- -----------------------------------------------------------------------------
create table public.export_jobs (
  id           uuid        primary key default private.uuid_v7(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid        references auth.users (id),
  updated_by   uuid        references auth.users (id),
  version      integer     not null default 1,
  deleted_at   timestamptz,

  user_id      uuid        not null references auth.users (id),
  format       text        not null,
  lang         text        not null default 'ar',
  filters      jsonb       not null default '{}',
  state        text        not null default 'queued',
  storage_path text,                              -- object in bucket "exports"
  file_name    text,
  bytes        bigint,
  row_count    integer,
  "cursor"     jsonb,                             -- keyset position, lets a worker resume
  stats        jsonb       not null default '{}',
  error        jsonb,
  attempts     integer     not null default 0,
  started_at   timestamptz,
  finished_at  timestamptz,
  expires_at   timestamptz,

  constraint export_jobs_format_ck check (format in ('csv', 'xlsx')),
  constraint export_jobs_lang_ck check (lang in ('ar', 'sw', 'en')),
  constraint export_jobs_state_ck check (state in ('queued', 'running', 'done', 'failed', 'cancelled', 'expired')),
  constraint export_jobs_bytes_ck check (bytes is null or bytes >= 0),
  constraint export_jobs_row_count_ck check (row_count is null or row_count >= 0)
);

create index export_jobs_user_idx on public.export_jobs (user_id, created_at desc);
create index export_jobs_active_idx on public.export_jobs (created_at) where state in ('queued', 'running');

-- -----------------------------------------------------------------------------
-- notifications — own rows only (export ready, record returned, conflict, …)
-- The client renders the text from kind + payload with its locale files.
-- -----------------------------------------------------------------------------
create table public.notifications (
  id         uuid        primary key default private.uuid_v7(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid        references auth.users (id),
  updated_by uuid        references auth.users (id),
  version    integer     not null default 1,
  deleted_at timestamptz,
  sync_xid   bigint      not null default private.current_xid(),

  user_id    uuid        not null references auth.users (id),   -- recipient
  kind       text        not null,
  payload    jsonb       not null default '{}',
  read_at    timestamptz,

  constraint notifications_kind_ck check (kind ~ '^[a-z][a-z0-9_.]*$')
);

create index notifications_user_idx on public.notifications (user_id, created_at desc);
create index notifications_user_sync_idx on public.notifications (user_id, sync_xid, id);
create index notifications_sync_idx on public.notifications (sync_xid, id);

-- -----------------------------------------------------------------------------
-- import_batches / import_rows — staged, reversible bulk import (brief §10)
--   batch: staged -> validated -> committing -> committed -> rolling_back -> rolled_back
--          (any step may end in failed)
--   row:   staged -> valid | invalid | duplicate -> applied | skipped | failed -> reverted
-- -----------------------------------------------------------------------------
create table public.import_batches (
  id             uuid        primary key default private.uuid_v7(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid        references auth.users (id),
  updated_by     uuid        references auth.users (id),
  version        integer     not null default 1,
  deleted_at     timestamptz,

  user_id        uuid        not null references auth.users (id),
  source_kind    text        not null default 'csv',
  file_name      text,
  storage_path   text,                            -- object in bucket "imports"
  country_id     uuid        references public.countries (id),
  branch_id      uuid        references public.branches (id),
  state          text        not null default 'staged',
  meta           jsonb       not null default '{}',   -- column mapping, language, options
  stats          jsonb       not null default '{}',   -- counters per row state / action
  errors         jsonb       not null default '[]',   -- batch-level errors
  row_count      integer     not null default 0,
  committed_at   timestamptz,
  committed_by   uuid        references auth.users (id),
  rolled_back_at timestamptz,
  rolled_back_by uuid        references auth.users (id),

  constraint import_batches_source_kind_ck check (source_kind in ('csv', 'xlsx', 'v2_json', 'v2_local')),
  constraint import_batches_state_ck check (
    state in ('staged', 'validated', 'committing', 'committed', 'rolling_back', 'rolled_back', 'failed')
  ),
  constraint import_batches_row_count_ck check (row_count >= 0)
);

create index import_batches_user_idx on public.import_batches (user_id, created_at desc);

create table public.import_rows (
  id           uuid        primary key default private.uuid_v7(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid        references auth.users (id),
  updated_by   uuid        references auth.users (id),
  version      integer     not null default 1,
  deleted_at   timestamptz,

  batch_id     uuid        not null references public.import_batches (id),
  row_no       integer     not null,
  external_id  text,
  raw          jsonb       not null default '{}',   -- the row as read from the file
  parsed       jsonb,                               -- normalised payload ready to apply
  state        text        not null default 'staged',
  action       text,
  errors       jsonb       not null default '[]',
  warnings     jsonb       not null default '[]',
  duplicate_of uuid        references public.projects (id),
  target_table text        not null default 'projects',
  target_id    uuid,                                -- row created or updated by the commit
  pre_image    jsonb,                               -- state before the commit (NULL = created)
  applied_at   timestamptz,

  constraint import_rows_batch_row_key unique (batch_id, row_no),
  constraint import_rows_row_no_ck check (row_no >= 1),
  constraint import_rows_state_ck check (
    state in ('staged', 'valid', 'invalid', 'duplicate', 'applied', 'skipped', 'failed', 'reverted')
  ),
  constraint import_rows_action_ck check (action is null or action in ('create', 'update', 'skip'))
);

create index import_rows_batch_state_idx on public.import_rows (batch_id, state);
create index import_rows_external_id_idx on public.import_rows (batch_id, external_id) where external_id is not null;
create index import_rows_target_idx on public.import_rows (target_id) where target_id is not null;

comment on column public.import_rows.pre_image is
  'Rows touched by the commit as they were before it (per table); NULL when the commit created the target. Used by import_rollback.';

alter table public.projects
  add constraint projects_import_batch_id_fkey
  foreign key (import_batch_id) references public.import_batches (id);

-- -----------------------------------------------------------------------------
-- map_packs — downloadable offline map regions (PMTiles extracts)
-- -----------------------------------------------------------------------------
create table public.map_packs (
  id            uuid        primary key default private.uuid_v7(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid        references auth.users (id),
  updated_by    uuid        references auth.users (id),
  version       integer     not null default 1,
  deleted_at    timestamptz,
  sync_xid      bigint      not null default private.current_xid(),

  code          text        not null,
  name_ar       text        not null,
  name_en       text,
  name_sw       text,
  country_id    uuid        references public.countries (id),
  admin_area_id uuid        references public.admin_areas (id),
  storage_path  text        not null,             -- object in bucket "tiles"
  bytes         bigint      not null default 0,
  min_zoom      smallint,
  max_zoom      smallint,
  min_lon       double precision,
  min_lat       double precision,
  max_lon       double precision,
  max_lat       double precision,
  tiles_version text,
  sha256        text,
  active        boolean     not null default true,

  constraint map_packs_code_key unique (code),
  constraint map_packs_code_ck check (btrim(code) <> ''),
  constraint map_packs_bytes_ck check (bytes >= 0),
  constraint map_packs_zoom_ck check (
    (min_zoom is null or min_zoom between 0 and 22)
    and (max_zoom is null or max_zoom between 0 and 22)
    and (min_zoom is null or max_zoom is null or min_zoom <= max_zoom)
  ),
  constraint map_packs_bbox_ck check (
    (min_lon is null and min_lat is null and max_lon is null and max_lat is null)
    or (min_lon between -180 and 180 and max_lon between -180 and 180
        and min_lat between -90 and 90 and max_lat between -90 and 90
        and min_lon <= max_lon and min_lat <= max_lat)
  )
);

create index map_packs_country_idx on public.map_packs (country_id);
create index map_packs_sync_idx on public.map_packs (sync_xid, id);

-- -----------------------------------------------------------------------------
-- app_settings — key/value configuration managed by hq_admin
-- -----------------------------------------------------------------------------
create table public.app_settings (
  id          uuid        primary key default private.uuid_v7(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid        references auth.users (id),
  updated_by  uuid        references auth.users (id),
  version     integer     not null default 1,
  deleted_at  timestamptz,

  key         text        not null,
  value       jsonb       not null default 'null',
  description text,
  is_public   boolean     not null default false,   -- readable by every signed-in user

  constraint app_settings_key_key unique (key),
  constraint app_settings_key_ck check (key ~ '^[a-z][a-z0-9_.]*$')
);

-- -----------------------------------------------------------------------------
-- private.rate_limit_buckets — fixed-window counters used by private.rate_limit()
-- (function in migration 0040). UNLOGGED: disposable and cheap to write.
-- -----------------------------------------------------------------------------
create unlogged table private.rate_limit_buckets (
  user_id      uuid        not null,
  bucket_key   text        not null,
  window_start timestamptz not null,
  hits         integer     not null default 0,
  expires_at   timestamptz not null,
  constraint rate_limit_buckets_pkey primary key (user_id, bucket_key, window_start)
);

create index rate_limit_buckets_expires_idx on private.rate_limit_buckets (expires_at);

-- -----------------------------------------------------------------------------
-- private.project_code_counters — per-country counter behind projects.code.
-- The row lock taken by the upsert serialises code generation per country.
-- -----------------------------------------------------------------------------
create table private.project_code_counters (
  country_id uuid        primary key references public.countries (id),
  last_value bigint      not null default 0,
  updated_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Default deny until the RLS migration (0010+) adds policies.
-- -----------------------------------------------------------------------------
alter table public.profiles              enable row level security;
alter table public.profiles              force row level security;
alter table public.user_roles            enable row level security;
alter table public.user_roles            force row level security;
alter table public.devices               enable row level security;
alter table public.devices               force row level security;
alter table public.audit_log             enable row level security;
alter table public.audit_log             force row level security;
alter table public.sync_conflicts        enable row level security;
alter table public.sync_conflicts        force row level security;
alter table public.sync_applied_ops      enable row level security;
alter table public.sync_applied_ops      force row level security;
alter table public.restricted_access_log enable row level security;
alter table public.restricted_access_log force row level security;
alter table public.export_jobs           enable row level security;
alter table public.export_jobs           force row level security;
alter table public.notifications         enable row level security;
alter table public.notifications         force row level security;
alter table public.import_batches        enable row level security;
alter table public.import_batches        force row level security;
alter table public.import_rows           enable row level security;
alter table public.import_rows           force row level security;
alter table public.map_packs             enable row level security;
alter table public.map_packs             force row level security;
alter table public.app_settings          enable row level security;
alter table public.app_settings          force row level security;

alter table private.rate_limit_buckets    enable row level security;
alter table private.rate_limit_buckets    force row level security;
alter table private.project_code_counters enable row level security;
alter table private.project_code_counters force row level security;

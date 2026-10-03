-- =============================================================================
-- 0003  Projects and their children
--       projects, project_land, project_facilities, project_maintenance,
--       project_photos, donors, project_donors  (brief §2.3, §6)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- projects
-- -----------------------------------------------------------------------------
create table public.projects (
  id              uuid        primary key default private.uuid_v7(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid        references auth.users (id),
  updated_by      uuid        references auth.users (id),
  version         integer     not null default 1,
  deleted_at      timestamptz,
  sync_xid        bigint      not null default private.current_xid(),

  code            text,                       -- server-generated, e.g. TZ-PN-000123
  external_id     text,                       -- import merge key
  name_ar         text        not null,
  name_latin      text,
  type            text        not null,
  status          text        not null default 'active',
  capacity        integer,
  geom            extensions.geometry(Point, 4326),
  gps_accuracy_m  real,
  location_source text,
  country_id      uuid        not null references public.countries (id),
  admin_area_id   uuid        references public.admin_areas (id),
  locality_id     uuid        references public.localities (id),
  branch_id       uuid        references public.branches (id),
  builder         text,
  build_year      smallint,
  build_date      date,
  record_state    text        not null default 'draft',
  review_note     text,
  reviewed_by     uuid        references auth.users (id),
  reviewed_at     timestamptz,
  completeness    smallint    not null default 0,
  search_norm     text        not null default '',
  import_batch_id uuid,                       -- FK added in migration 0005 (import_batches)

  constraint projects_name_ar_ck check (btrim(name_ar) <> ''),
  constraint projects_type_ck check (type in ('mosque', 'school', 'combined')),
  constraint projects_status_ck check (status in ('active', 'maintenance', 'building', 'inactive')),
  constraint projects_capacity_ck check (capacity is null or capacity >= 0),
  constraint projects_gps_accuracy_ck check (gps_accuracy_m is null or gps_accuracy_m >= 0),
  constraint projects_location_source_ck check (
    location_source is null or location_source in ('gps', 'map', 'import')
  ),
  constraint projects_build_year_ck check (build_year is null or build_year between 1800 and 2200),
  constraint projects_record_state_ck check (record_state in ('draft', 'submitted', 'approved', 'returned')),
  constraint projects_completeness_ck check (completeness between 0 and 100),
  constraint projects_geom_ck check (
    geom is null
    or (not extensions.st_isempty(geom)
        and extensions.st_x(geom) between -180 and 180
        and extensions.st_y(geom) between -90 and 90)
  ),
  -- A record can only leave the draft state with a location (brief §7.1).
  constraint projects_geom_required_ck check (geom is not null or record_state = 'draft')
);

create unique index projects_code_key on public.projects (code) where code is not null;
create unique index projects_external_id_key on public.projects (external_id) where external_id is not null;

create index projects_geom_gist on public.projects using gist (geom);
create index projects_name_ar_trgm on public.projects using gin (name_ar extensions.gin_trgm_ops);
create index projects_name_latin_trgm on public.projects using gin (name_latin extensions.gin_trgm_ops);
create index projects_search_norm_trgm on public.projects using gin (search_norm extensions.gin_trgm_ops);
create index projects_country_status_type_idx on public.projects (country_id, status, type);
create index projects_branch_idx on public.projects (branch_id);
create index projects_admin_area_idx on public.projects (admin_area_id);
create index projects_locality_idx on public.projects (locality_id) where locality_id is not null;
create index projects_created_by_idx on public.projects (created_by);
create index projects_import_batch_idx on public.projects (import_batch_id) where import_batch_id is not null;
-- Review queue: submitted records of a branch / country.
create index projects_review_queue_idx on public.projects (branch_id, country_id, updated_at)
  where record_state = 'submitted' and deleted_at is null;
-- Sync: global cursor plus scoped cursors (country manager / branch users).
create index projects_sync_idx on public.projects (sync_xid, id);
create index projects_country_sync_idx on public.projects (country_id, sync_xid, id);
create index projects_branch_sync_idx on public.projects (branch_id, sync_xid, id);

comment on table public.projects is
  'Mosques and Quran schools. On the wire geometry travels as lon/lat numbers, never WKB.';
comment on column public.projects.code is
  'Readable code <ISO2>-<level-1 short_code or XX>-<6 digit per-country counter>; generated by trigger, immutable once set.';
comment on column public.projects.admin_area_id is
  'Deepest admin_areas polygon containing geom (trigger). A client value is kept only when no polygon contains the point (decision D5).';
comment on column public.projects.completeness is
  'Server-computed 0..100; formula in docs/contracts/schema.md.';
comment on column public.projects.search_norm is
  'private.norm(name_ar, name_latin, code, locality names); maintained by trigger.';

-- -----------------------------------------------------------------------------
-- project_land (1:1)
-- -----------------------------------------------------------------------------
create table public.project_land (
  id              uuid        primary key default private.uuid_v7(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid        references auth.users (id),
  updated_by      uuid        references auth.users (id),
  version         integer     not null default 1,
  deleted_at      timestamptz,
  sync_xid        bigint      not null default private.current_xid(),

  project_id      uuid        not null references public.projects (id),
  ownership       text,
  owner_name      text,
  area_m2         numeric(14, 2),
  utilization_pct numeric(5, 2),
  expandable      boolean,
  notes           text,

  constraint project_land_ownership_ck check (
    ownership is null or ownership in ('association', 'waqf', 'person', 'government', 'other')
  ),
  constraint project_land_area_ck check (area_m2 is null or area_m2 >= 0),
  constraint project_land_utilization_ck check (utilization_pct is null or utilization_pct between 0 and 100)
);

create unique index project_land_project_live_key on public.project_land (project_id) where deleted_at is null;
create index project_land_project_idx on public.project_land (project_id);
create index project_land_sync_idx on public.project_land (sync_xid, id);

-- -----------------------------------------------------------------------------
-- project_facilities (1:1)
-- -----------------------------------------------------------------------------
create table public.project_facilities (
  id                uuid        primary key default private.uuid_v7(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid        references auth.users (id),
  updated_by        uuid        references auth.users (id),
  version           integer     not null default 1,
  deleted_at        timestamptz,
  sync_xid          bigint      not null default private.current_xid(),

  project_id        uuid        not null references public.projects (id),
  teacher_housing   boolean,
  imam_housing      boolean,
  guest_housing     boolean,
  library           boolean,
  hall              boolean,
  quran_count       integer,
  quran_need        integer,
  hall_capacity     integer,
  student_transport text,
  students_origin   text,

  constraint project_facilities_quran_count_ck check (quran_count is null or quran_count >= 0),
  constraint project_facilities_quran_need_ck check (quran_need is null or quran_need >= 0),
  constraint project_facilities_hall_capacity_ck check (hall_capacity is null or hall_capacity >= 0),
  constraint project_facilities_student_transport_ck check (
    student_transport is null or student_transport in ('available', 'needed', 'not_needed')
  ),
  constraint project_facilities_students_origin_ck check (
    students_origin is null or students_origin in ('nearby', 'mixed', 'distant')
  )
);

create unique index project_facilities_project_live_key on public.project_facilities (project_id) where deleted_at is null;
create index project_facilities_project_idx on public.project_facilities (project_id);
create index project_facilities_sync_idx on public.project_facilities (sync_xid, id);

-- -----------------------------------------------------------------------------
-- project_maintenance (1:n) — a log of entries instead of one free-text field
-- -----------------------------------------------------------------------------
create table public.project_maintenance (
  id             uuid        primary key default private.uuid_v7(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid        references auth.users (id),
  updated_by     uuid        references auth.users (id),
  version        integer     not null default 1,
  deleted_at     timestamptz,
  sync_xid       bigint      not null default private.current_xid(),

  project_id     uuid        not null references public.projects (id),
  reported_on    date        not null default current_date,
  description    text        not null,
  priority       text        not null default 'medium',
  estimated_cost numeric(14, 2),
  currency       char(3),
  state          text        not null default 'open',
  resolved_on    date,

  constraint project_maintenance_description_ck check (btrim(description) <> ''),
  constraint project_maintenance_priority_ck check (priority in ('low', 'medium', 'high', 'urgent')),
  constraint project_maintenance_cost_ck check (estimated_cost is null or estimated_cost >= 0),
  constraint project_maintenance_currency_ck check (currency is null or currency ~ '^[A-Z]{3}$'),
  constraint project_maintenance_state_ck check (state in ('open', 'in_progress', 'done', 'cancelled'))
);

create index project_maintenance_project_idx on public.project_maintenance (project_id);
create index project_maintenance_open_idx on public.project_maintenance (project_id, priority)
  where deleted_at is null and state in ('open', 'in_progress');
create index project_maintenance_sync_idx on public.project_maintenance (sync_xid, id);

-- -----------------------------------------------------------------------------
-- project_photos (1:n, at most 10 live rows and one live cover per project)
-- Storage path: projects/{country_iso2}/{project_id}/{photo_id}_{full|thumb}.webp
-- -----------------------------------------------------------------------------
create table public.project_photos (
  id                 uuid        primary key default private.uuid_v7(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid        references auth.users (id),
  updated_by         uuid        references auth.users (id),
  version            integer     not null default 1,
  deleted_at         timestamptz,
  sync_xid           bigint      not null default private.current_xid(),

  project_id         uuid        not null references public.projects (id),
  storage_path_full  text        not null,
  storage_path_thumb text        not null,
  taken_at           timestamptz,
  width              integer,
  height             integer,
  bytes              integer,
  is_cover           boolean     not null default false,
  category           text        not null default 'unspecified',
  caption            text,
  upload_state       text        not null default 'pending',
  purged_at          timestamptz,

  constraint project_photos_category_ck check (
    category in ('unspecified', 'mosque_front', 'mosque_inside', 'school_front', 'school_inside',
                 'land', 'facilities', 'maintenance', 'other')
  ),
  constraint project_photos_upload_state_ck check (upload_state in ('pending', 'uploaded')),
  constraint project_photos_width_ck check (width is null or width > 0),
  constraint project_photos_height_ck check (height is null or height > 0),
  constraint project_photos_bytes_ck check (bytes is null or bytes >= 0),
  -- A photo row can only point at its own objects: the path embeds the project
  -- id and the photo id, so a row can never be aimed at somebody else's file.
  constraint project_photos_path_full_ck check (
    storage_path_full ~ ('^projects/[A-Z]{2}/' || project_id::text || '/' || id::text || '_full\.(webp|jpg|jpeg)$')
  ),
  constraint project_photos_path_thumb_ck check (
    storage_path_thumb ~ ('^projects/[A-Z]{2}/' || project_id::text || '/' || id::text || '_thumb\.(webp|jpg|jpeg)$')
  )
);

create unique index project_photos_cover_key on public.project_photos (project_id)
  where is_cover and deleted_at is null;
create index project_photos_project_idx on public.project_photos (project_id);
create index project_photos_sync_idx on public.project_photos (sync_xid, id);
-- Retention job: soft-deleted photos whose objects are not purged yet (brief §11).
create index project_photos_purge_idx on public.project_photos (deleted_at)
  where deleted_at is not null and purged_at is null;

comment on column public.project_photos.storage_path_full is
  'projects/{ISO2}/{project_id}/{id}_full.webp (jpg fallback). Filled by trigger when NULL on insert.';
comment on column public.project_photos.purged_at is
  'Set by the retention job when the objects of a soft-deleted photo were removed from storage (90 days).';

-- -----------------------------------------------------------------------------
-- donors and project_donors (many-to-many, optional amount and year)
-- -----------------------------------------------------------------------------
create table public.donors (
  id         uuid        primary key default private.uuid_v7(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid        references auth.users (id),
  updated_by uuid        references auth.users (id),
  version    integer     not null default 1,
  deleted_at timestamptz,
  sync_xid   bigint      not null default private.current_xid(),

  name_ar    text,
  name_latin text,
  name_norm  text        not null default '',
  notes      text,

  constraint donors_name_ck check (
    coalesce(nullif(btrim(name_ar), ''), nullif(btrim(name_latin), '')) is not null
  )
);

create index donors_name_norm_trgm on public.donors using gin (name_norm extensions.gin_trgm_ops);
create index donors_sync_idx on public.donors (sync_xid, id);

create table public.project_donors (
  id         uuid        primary key default private.uuid_v7(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid        references auth.users (id),
  updated_by uuid        references auth.users (id),
  version    integer     not null default 1,
  deleted_at timestamptz,
  sync_xid   bigint      not null default private.current_xid(),

  project_id uuid        not null references public.projects (id),
  donor_id   uuid        not null references public.donors (id),
  amount     numeric(14, 2),
  currency   char(3),
  year       smallint,

  constraint project_donors_amount_ck check (amount is null or amount >= 0),
  constraint project_donors_currency_ck check (currency is null or currency ~ '^[A-Z]{3}$'),
  constraint project_donors_year_ck check (year is null or year between 1800 and 2200)
);

-- One live link per (project, donor, year); a NULL year counts as one value.
create unique index project_donors_live_key on public.project_donors (project_id, donor_id, coalesce(year, 0))
  where deleted_at is null;
create index project_donors_project_idx on public.project_donors (project_id);
create index project_donors_donor_idx on public.project_donors (donor_id);
create index project_donors_sync_idx on public.project_donors (sync_xid, id);

-- -----------------------------------------------------------------------------
-- Default deny until the RLS migration (0010+) adds policies.
-- -----------------------------------------------------------------------------
alter table public.projects            enable row level security;
alter table public.projects            force row level security;
alter table public.project_land        enable row level security;
alter table public.project_land        force row level security;
alter table public.project_facilities  enable row level security;
alter table public.project_facilities  force row level security;
alter table public.project_maintenance enable row level security;
alter table public.project_maintenance force row level security;
alter table public.project_photos      enable row level security;
alter table public.project_photos      force row level security;
alter table public.donors              enable row level security;
alter table public.donors              force row level security;
alter table public.project_donors      enable row level security;
alter table public.project_donors      force row level security;

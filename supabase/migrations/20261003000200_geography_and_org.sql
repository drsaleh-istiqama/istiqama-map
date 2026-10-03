-- =============================================================================
-- 0002  Geography and organisation tables
--       countries, admin_areas, localities, branches  (brief §2.1, §2.2)
--
-- Standard columns on every table (ARCHITECTURE §2.1):
--   id, created_at, updated_at, created_by, updated_by, version, deleted_at
-- Syncable tables add sync_xid (maintained by private.tg_std, migration 0006).
-- Soft delete only: rows are never removed, deleted_at is set instead.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- countries
-- -----------------------------------------------------------------------------
create table public.countries (
  id               uuid        primary key default private.uuid_v7(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid        references auth.users (id),
  updated_by       uuid        references auth.users (id),
  version          integer     not null default 1,
  deleted_at       timestamptz,
  sync_xid         bigint      not null default private.current_xid(),

  iso2             char(2)     not null,
  iso3             char(3),
  name_ar          text        not null,
  name_en          text        not null,
  name_sw          text,
  default_currency char(3),
  active           boolean     not null default true,

  constraint countries_iso2_key unique (iso2),
  constraint countries_iso2_ck check (iso2 ~ '^[A-Z]{2}$'),
  constraint countries_iso3_ck check (iso3 is null or iso3 ~ '^[A-Z]{3}$'),
  constraint countries_default_currency_ck check (default_currency is null or default_currency ~ '^[A-Z]{3}$'),
  constraint countries_name_ar_ck check (btrim(name_ar) <> ''),
  constraint countries_name_en_ck check (btrim(name_en) <> '')
);

create unique index countries_iso3_key on public.countries (iso3) where iso3 is not null;
create index countries_sync_idx on public.countries (sync_xid, id);

comment on table public.countries is
  'Countries served by the association. Managed from the admin screens, never from code.';

-- -----------------------------------------------------------------------------
-- admin_areas: official boundaries ADM1..ADM3 (geoBoundaries / OCHA COD-AB)
-- -----------------------------------------------------------------------------
create table public.admin_areas (
  id          uuid        primary key default private.uuid_v7(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid        references auth.users (id),
  updated_by  uuid        references auth.users (id),
  version     integer     not null default 1,
  deleted_at  timestamptz,
  sync_xid    bigint      not null default private.current_xid(),

  country_id  uuid        not null references public.countries (id),
  parent_id   uuid        references public.admin_areas (id),
  level       smallint    not null,
  code        text        not null,
  short_code  text,
  name_ar     text,
  name_en     text,
  name_sw     text,
  geom        extensions.geometry(MultiPolygon, 4326),
  geom_simple extensions.geometry(MultiPolygon, 4326),

  constraint admin_areas_country_level_code_key unique (country_id, level, code),
  constraint admin_areas_level_ck check (level between 1 and 3),
  constraint admin_areas_code_ck check (btrim(code) <> ''),
  constraint admin_areas_short_code_ck check (short_code is null or short_code ~ '^[A-Z0-9]{2,3}$'),
  constraint admin_areas_name_ck check (
    coalesce(nullif(btrim(name_ar), ''), nullif(btrim(name_en), ''), nullif(btrim(name_sw), '')) is not null
  ),
  constraint admin_areas_parent_ck check (parent_id is null or (level > 1 and parent_id <> id))
);

create index admin_areas_geom_gist on public.admin_areas using gist (geom);
create index admin_areas_parent_idx on public.admin_areas (parent_id);
create index admin_areas_sync_idx on public.admin_areas (sync_xid, id);

comment on table public.admin_areas is
  'Administrative boundaries: level 1 = region/governorate, 2 = district, 3 = ward/village. code = geoBoundaries shapeID or COD-AB p-code.';
comment on column public.admin_areas.short_code is
  '2-3 upper-case letters/digits; the level-1 value is used inside project codes (TZ-PN-000123).';
comment on column public.admin_areas.geom_simple is
  'Simplified shape for offline geofill; filled by trigger from geom when not supplied.';

-- -----------------------------------------------------------------------------
-- localities: villages and settlements missing from the official boundaries.
-- Manual entry in the form creates a "proposed" row; a supervisor approves it.
-- -----------------------------------------------------------------------------
create table public.localities (
  id            uuid        primary key default private.uuid_v7(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid        references auth.users (id),
  updated_by    uuid        references auth.users (id),
  version       integer     not null default 1,
  deleted_at    timestamptz,
  sync_xid      bigint      not null default private.current_xid(),

  country_id    uuid        not null references public.countries (id),
  admin_area_id uuid        references public.admin_areas (id),
  name_ar       text,
  name_latin    text,
  name_norm     text        not null default '',
  geom          extensions.geometry(Point, 4326),
  status        text        not null default 'proposed',
  approved_by   uuid        references auth.users (id),
  approved_at   timestamptz,

  constraint localities_status_ck check (status in ('proposed', 'approved')),
  constraint localities_name_ck check (
    coalesce(nullif(btrim(name_ar), ''), nullif(btrim(name_latin), '')) is not null
  ),
  constraint localities_geom_ck check (
    geom is null
    or (not extensions.st_isempty(geom)
        and extensions.st_x(geom) between -180 and 180
        and extensions.st_y(geom) between -90 and 90)
  )
);

create index localities_name_norm_trgm on public.localities using gin (name_norm extensions.gin_trgm_ops);
create index localities_geom_gist on public.localities using gist (geom);
create index localities_admin_area_idx on public.localities (admin_area_id);
create index localities_country_status_idx on public.localities (country_id, status);
create index localities_sync_idx on public.localities (sync_xid, id);

comment on table public.localities is
  'Villages/settlements not present in the official boundaries. status: proposed -> approved (by a supervisor).';
comment on column public.localities.name_norm is
  'private.norm(name_ar || '' '' || name_latin); maintained by trigger.';

-- -----------------------------------------------------------------------------
-- branches: association branches and their geographic scope
-- -----------------------------------------------------------------------------
create table public.branches (
  id             uuid        primary key default private.uuid_v7(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid        references auth.users (id),
  updated_by     uuid        references auth.users (id),
  version        integer     not null default 1,
  deleted_at     timestamptz,
  sync_xid       bigint      not null default private.current_xid(),

  country_id     uuid        not null references public.countries (id),
  code           text        not null,
  name_ar        text        not null,
  name_en        text,
  name_sw        text,
  admin_area_ids uuid[]      not null default '{}',
  active         boolean     not null default true,

  constraint branches_country_code_key unique (country_id, code),
  constraint branches_code_ck check (btrim(code) <> ''),
  constraint branches_name_ar_ck check (btrim(name_ar) <> '')
);

create index branches_sync_idx on public.branches (sync_xid, id);

comment on table public.branches is
  'Association branches. admin_area_ids = admin_areas covered by the branch (geographic scope).';

-- -----------------------------------------------------------------------------
-- Default deny until the RLS migration (0010+) adds policies.
-- -----------------------------------------------------------------------------
alter table public.countries   enable row level security;
alter table public.countries   force row level security;
alter table public.admin_areas enable row level security;
alter table public.admin_areas force row level security;
alter table public.localities  enable row level security;
alter table public.localities  force row level security;
alter table public.branches    enable row level security;
alter table public.branches    force row level security;

-- =============================================================================
-- 0004  People and community tables
--       persons, person_merge_requests, project_staff, staff_compensation (RESTRICTED),
--       fx_rates, option_values, community_profiles, community_sensitive (RESTRICTED)
--       (brief §2.4, §2.5)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- persons — never merged automatically by name (brief §2.4)
-- -----------------------------------------------------------------------------
create table public.persons (
  id                 uuid        primary key default private.uuid_v7(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid        references auth.users (id),
  updated_by         uuid        references auth.users (id),
  version            integer     not null default 1,
  deleted_at         timestamptz,
  sync_xid           bigint      not null default private.current_xid(),

  name_ar            text,
  name_latin         text,
  name_normalized    text        not null default '',
  phone_e164         text,
  gender             text,
  birth_year         smallint,
  birth_date         date,
  home_admin_area_id uuid        references public.admin_areas (id),
  home_area_text     text,
  education_level    text,
  graduated_from     text,
  country_id         uuid        references public.countries (id),   -- scope
  branch_id          uuid        references public.branches (id),    -- scope
  merged_into_id     uuid        references public.persons (id),

  constraint persons_name_ck check (
    coalesce(nullif(btrim(name_ar), ''), nullif(btrim(name_latin), '')) is not null
  ),
  constraint persons_phone_ck check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  constraint persons_gender_ck check (gender is null or gender in ('male', 'female')),
  constraint persons_birth_year_ck check (birth_year is null or birth_year between 1900 and 2100),
  constraint persons_merged_into_ck check (merged_into_id is null or merged_into_id <> id)
);

create index persons_name_normalized_trgm on public.persons using gin (name_normalized extensions.gin_trgm_ops);
create index persons_phone_idx on public.persons (phone_e164) where phone_e164 is not null;
create index persons_home_area_idx on public.persons (home_admin_area_id) where home_admin_area_id is not null;
create index persons_merged_into_idx on public.persons (merged_into_id) where merged_into_id is not null;
create index persons_sync_idx on public.persons (sync_xid, id);
create index persons_country_sync_idx on public.persons (country_id, sync_xid, id);
create index persons_branch_sync_idx on public.persons (branch_id, sync_xid, id);

comment on table public.persons is
  'Imams, teachers, agents, administrators. Matching is always confirmed by a human; merges go through person_merge_requests.';
comment on column public.persons.name_normalized is
  'private.norm(name_ar || '' '' || name_latin); maintained by trigger. Match with word similarity (<% / <<%), the column holds both scripts.';
comment on column public.persons.merged_into_id is
  'Set on the source row of an accepted merge; the row is also soft-deleted.';

-- -----------------------------------------------------------------------------
-- person_merge_requests — manual, reversible merge tool for supervisors
-- -----------------------------------------------------------------------------
create table public.person_merge_requests (
  id               uuid        primary key default private.uuid_v7(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid        references auth.users (id),
  updated_by       uuid        references auth.users (id),
  version          integer     not null default 1,
  deleted_at       timestamptz,
  sync_xid         bigint      not null default private.current_xid(),

  source_person_id uuid        not null references public.persons (id),
  target_person_id uuid        not null references public.persons (id),
  state            text        not null default 'pending',
  reason           text,
  decided_by       uuid        references auth.users (id),
  decided_at       timestamptz,
  undo             jsonb,

  constraint person_merge_requests_state_ck check (state in ('pending', 'merged', 'rejected', 'reverted')),
  constraint person_merge_requests_distinct_ck check (source_person_id <> target_person_id)
);

create index person_merge_requests_source_idx on public.person_merge_requests (source_person_id);
create index person_merge_requests_target_idx on public.person_merge_requests (target_person_id);
create index person_merge_requests_sync_idx on public.person_merge_requests (sync_xid, id);

comment on column public.person_merge_requests.undo is
  'Everything needed to revert the merge (rows re-pointed, source pre-image); shape owned by merge_persons().';

-- -----------------------------------------------------------------------------
-- project_staff — a person can work in several projects and in several roles
-- -----------------------------------------------------------------------------
create table public.project_staff (
  id         uuid        primary key default private.uuid_v7(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid        references auth.users (id),
  updated_by uuid        references auth.users (id),
  version    integer     not null default 1,
  deleted_at timestamptz,
  sync_xid   bigint      not null default private.current_xid(),

  project_id uuid        not null references public.projects (id),
  person_id  uuid        not null references public.persons (id),
  role       text        not null,
  start_date date,
  end_date   date,

  constraint project_staff_role_ck check (
    role in ('imam', 'teacher', 'agent', 'administrator', 'manager', 'other')
  ),
  constraint project_staff_dates_ck check (start_date is null or end_date is null or end_date >= start_date)
);

create index project_staff_project_idx on public.project_staff (project_id);
create index project_staff_person_idx on public.project_staff (person_id);
create index project_staff_sync_idx on public.project_staff (sync_xid, id);

-- -----------------------------------------------------------------------------
-- staff_compensation — RESTRICTED: no direct API access, logged reads only
-- -----------------------------------------------------------------------------
create table public.staff_compensation (
  id               uuid           primary key default private.uuid_v7(),
  created_at       timestamptz    not null default now(),
  updated_at       timestamptz    not null default now(),
  created_by       uuid           references auth.users (id),
  updated_by       uuid           references auth.users (id),
  version          integer        not null default 1,
  deleted_at       timestamptz,
  sync_xid         bigint         not null default private.current_xid(),

  project_staff_id uuid           not null references public.project_staff (id),
  monthly_amount   numeric(14, 2) not null,
  currency         char(3)        not null,
  effective_from   date           not null default current_date,

  constraint staff_compensation_amount_ck check (monthly_amount >= 0),
  constraint staff_compensation_currency_ck check (
    currency in ('TZS', 'KES', 'UGX', 'RWF', 'BIF', 'MZN', 'OMR', 'USD')
  )
);

-- One live amount per assignment and effective date (payroll never double counts).
create unique index staff_compensation_live_key on public.staff_compensation (project_staff_id, effective_from)
  where deleted_at is null;
create index staff_compensation_staff_idx on public.staff_compensation (project_staff_id, effective_from desc);
create index staff_compensation_sync_idx on public.staff_compensation (sync_xid, id);

comment on table public.staff_compensation is
  'RESTRICTED. Monthly pay per assignment. Never add amounts of different currencies without fx_rates.';

-- -----------------------------------------------------------------------------
-- fx_rates — conversion to USD for reports
-- -----------------------------------------------------------------------------
create table public.fx_rates (
  id             uuid           primary key default private.uuid_v7(),
  created_at     timestamptz    not null default now(),
  updated_at     timestamptz    not null default now(),
  created_by     uuid           references auth.users (id),
  updated_by     uuid           references auth.users (id),
  version        integer        not null default 1,
  deleted_at     timestamptz,
  sync_xid       bigint         not null default private.current_xid(),

  currency       char(3)        not null,
  usd_per_unit   numeric(20, 10) not null,
  effective_date date           not null default current_date,

  constraint fx_rates_currency_date_key unique (currency, effective_date),
  constraint fx_rates_currency_ck check (currency ~ '^[A-Z]{3}$'),
  constraint fx_rates_rate_ck check (usd_per_unit > 0)
);

create index fx_rates_sync_idx on public.fx_rates (sync_xid, id);

comment on column public.fx_rates.usd_per_unit is 'USD value of one unit of the currency on effective_date.';

-- -----------------------------------------------------------------------------
-- option_values — manageable, translatable multi-choice lists
-- -----------------------------------------------------------------------------
create table public.option_values (
  id         uuid        primary key default private.uuid_v7(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid        references auth.users (id),
  updated_by uuid        references auth.users (id),
  version    integer     not null default 1,
  deleted_at timestamptz,
  sync_xid   bigint      not null default private.current_xid(),

  list_key   text        not null,
  code       text        not null,
  name_ar    text        not null,
  name_en    text,
  name_sw    text,
  sort_order integer     not null default 0,
  active     boolean     not null default true,

  constraint option_values_list_code_key unique (list_key, code),
  constraint option_values_list_key_ck check (
    list_key in ('daawa_activities', 'social_features', 'livelihoods', 'religious_issues',
                 'religious_challenges', 'social_challenges', 'proposed_activities')
  ),
  constraint option_values_code_ck check (btrim(code) <> ''),
  constraint option_values_name_ar_ck check (btrim(name_ar) <> '')
);

create index option_values_sync_idx on public.option_values (sync_xid, id);

-- -----------------------------------------------------------------------------
-- community_profiles (1:1 project) — general, visible inside the system.
-- Multi-choice fields are arrays of option_values.id (validated by trigger),
-- plus a short free text used only when "other" is chosen (v2 parity).
-- -----------------------------------------------------------------------------
create table public.community_profiles (
  id                         uuid        primary key default private.uuid_v7(),
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  created_by                 uuid        references auth.users (id),
  updated_by                 uuid        references auth.users (id),
  version                    integer     not null default 1,
  deleted_at                 timestamptz,
  sync_xid                   bigint      not null default private.current_xid(),

  project_id                 uuid        not null references public.projects (id),
  branch_name                text,
  population                 integer,
  muslim_pct                 numeric(5, 2),
  daawa_activities           uuid[]      not null default '{}',
  daawa_activities_other     text,
  social_features            uuid[]      not null default '{}',
  social_features_other      text,
  livelihoods                uuid[]      not null default '{}',
  livelihoods_other          text,
  religious_issues           uuid[]      not null default '{}',
  religious_issues_other     text,
  religious_challenges       uuid[]      not null default '{}',
  religious_challenges_other text,
  social_challenges          uuid[]      not null default '{}',
  social_challenges_other    text,
  proposed_activities        uuid[]      not null default '{}',
  proposed_activities_other  text,

  constraint community_profiles_population_ck check (population is null or population >= 0),
  constraint community_profiles_muslim_pct_ck check (muslim_pct is null or muslim_pct between 0 and 100)
);

create unique index community_profiles_project_live_key on public.community_profiles (project_id) where deleted_at is null;
create index community_profiles_project_idx on public.community_profiles (project_id);
create index community_profiles_sync_idx on public.community_profiles (sync_xid, id);

-- -----------------------------------------------------------------------------
-- community_sensitive (1:1 project) — RESTRICTED
-- -----------------------------------------------------------------------------
create table public.community_sensitive (
  id                       uuid        primary key default private.uuid_v7(),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  created_by               uuid        references auth.users (id),
  updated_by               uuid        references auth.users (id),
  version                  integer     not null default 1,
  deleted_at               timestamptz,
  sync_xid                 bigint      not null default private.current_xid(),

  project_id               uuid        not null references public.projects (id),
  ibadi_families           integer,
  omani_families           integer,
  omani_student_pct        numeric(5, 2),
  ibadi_student_pct        numeric(5, 2),
  omani_teacher_pct        numeric(5, 2),
  ibadi_teacher_pct        numeric(5, 2),
  guest_financial_capacity text,

  constraint community_sensitive_ibadi_families_ck check (ibadi_families is null or ibadi_families >= 0),
  constraint community_sensitive_omani_families_ck check (omani_families is null or omani_families >= 0),
  constraint community_sensitive_omani_student_pct_ck check (omani_student_pct is null or omani_student_pct between 0 and 100),
  constraint community_sensitive_ibadi_student_pct_ck check (ibadi_student_pct is null or ibadi_student_pct between 0 and 100),
  constraint community_sensitive_omani_teacher_pct_ck check (omani_teacher_pct is null or omani_teacher_pct between 0 and 100),
  constraint community_sensitive_ibadi_teacher_pct_ck check (ibadi_teacher_pct is null or ibadi_teacher_pct between 0 and 100),
  constraint community_sensitive_guest_capacity_ck check (
    guest_financial_capacity is null or guest_financial_capacity in ('good', 'limited', 'none')
  )
);

create unique index community_sensitive_project_live_key on public.community_sensitive (project_id) where deleted_at is null;
create index community_sensitive_project_idx on public.community_sensitive (project_id);
create index community_sensitive_sync_idx on public.community_sensitive (sync_xid, id);

comment on table public.community_sensitive is
  'RESTRICTED. Sensitive community figures; no direct API access, logged reads only.';

-- -----------------------------------------------------------------------------
-- Default deny until the RLS migration (0010+) adds policies.
-- -----------------------------------------------------------------------------
alter table public.persons               enable row level security;
alter table public.persons               force row level security;
alter table public.person_merge_requests enable row level security;
alter table public.person_merge_requests force row level security;
alter table public.project_staff         enable row level security;
alter table public.project_staff         force row level security;
alter table public.staff_compensation    enable row level security;
alter table public.staff_compensation    force row level security;
alter table public.fx_rates              enable row level security;
alter table public.fx_rates              force row level security;
alter table public.option_values         enable row level security;
alter table public.option_values         force row level security;
alter table public.community_profiles    enable row level security;
alter table public.community_profiles    force row level security;
alter table public.community_sensitive   enable row level security;
alter table public.community_sensitive   force row level security;

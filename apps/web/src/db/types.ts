/**
 * Row types exactly as rows travel on the wire (`sync_pull` / `sync_push`):
 * every column of the table in snake_case, ISO strings for dates and timestamps, JSON numbers
 * for numeric columns, `lon` / `lat` instead of `geom`, no `sync_xid`.
 * Source of truth: docs/contracts/schema.md + docs/contracts/sync.md. The live check
 * `apps/web/tests/integration/registry.live.test.ts` compares the column lists in
 * `tables.ts` (which are type-checked against these interfaces) with the database.
 */

// ---------------------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------------------

/** UUID in canonical text form (rows created on the device use UUIDv7). */
export type Uuid = string;
/** `YYYY-MM-DD`. */
export type IsoDate = string;
/** ISO 8601 timestamp with offset, e.g. `2026-10-03T10:00:00.123456+00:00`. */
export type IsoTimestamp = string;

// ---------------------------------------------------------------------------------------
// Enumerations (text + CHECK in the database). Arrays are exported for selects / chips,
// in the order the UI should offer them.
// ---------------------------------------------------------------------------------------

export const PROJECT_TYPES = ['mosque', 'school', 'combined'] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

export const PROJECT_STATUSES = ['active', 'maintenance', 'building', 'inactive'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const RECORD_STATES = ['draft', 'submitted', 'approved', 'returned'] as const;
export type RecordState = (typeof RECORD_STATES)[number];

export const LOCATION_SOURCES = ['gps', 'map', 'import'] as const;
export type LocationSource = (typeof LOCATION_SOURCES)[number];

export const LAND_OWNERSHIPS = ['association', 'waqf', 'person', 'government', 'other'] as const;
export type LandOwnership = (typeof LAND_OWNERSHIPS)[number];

export const STUDENT_TRANSPORTS = ['available', 'needed', 'not_needed'] as const;
export type StudentTransport = (typeof STUDENT_TRANSPORTS)[number];

export const STUDENTS_ORIGINS = ['nearby', 'mixed', 'distant'] as const;
export type StudentsOrigin = (typeof STUDENTS_ORIGINS)[number];

export const MAINTENANCE_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type MaintenancePriority = (typeof MAINTENANCE_PRIORITIES)[number];

export const MAINTENANCE_STATES = ['open', 'in_progress', 'done', 'cancelled'] as const;
export type MaintenanceState = (typeof MAINTENANCE_STATES)[number];
/** States that count as "open maintenance" (lists, badges, heat map). */
export const OPEN_MAINTENANCE_STATES: readonly MaintenanceState[] = ['open', 'in_progress'];

export const PHOTO_CATEGORIES = [
  'unspecified',
  'mosque_front',
  'mosque_inside',
  'school_front',
  'school_inside',
  'land',
  'facilities',
  'maintenance',
  'other',
] as const;
export type PhotoCategory = (typeof PHOTO_CATEGORIES)[number];

export const PHOTO_UPLOAD_STATES = ['pending', 'uploaded'] as const;
export type PhotoUploadState = (typeof PHOTO_UPLOAD_STATES)[number];

export const STAFF_ROLES = ['imam', 'teacher', 'agent', 'administrator', 'manager', 'other'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const CURRENCIES = ['TZS', 'KES', 'UGX', 'RWF', 'BIF', 'MZN', 'OMR', 'USD'] as const;
export type Currency = (typeof CURRENCIES)[number];

export const GENDERS = ['male', 'female'] as const;
export type Gender = (typeof GENDERS)[number];

export const LOCALITY_STATUSES = ['proposed', 'approved'] as const;
export type LocalityStatus = (typeof LOCALITY_STATUSES)[number];

export const OPTION_LIST_KEYS = [
  'daawa_activities',
  'social_features',
  'livelihoods',
  'religious_issues',
  'religious_challenges',
  'social_challenges',
  'proposed_activities',
] as const;
export type OptionListKey = (typeof OPTION_LIST_KEYS)[number];

export const GUEST_FINANCIAL_CAPACITIES = ['good', 'limited', 'none'] as const;
export type GuestFinancialCapacity = (typeof GUEST_FINANCIAL_CAPACITIES)[number];

export const MERGE_REQUEST_STATES = ['pending', 'merged', 'rejected', 'reverted'] as const;
export type MergeRequestState = (typeof MERGE_REQUEST_STATES)[number];

export const CONFLICT_STATES = ['open', 'resolved_server', 'resolved_client'] as const;
export type ConflictState = (typeof CONFLICT_STATES)[number];

export const USER_ROLES = [
  'field_collector',
  'branch_supervisor',
  'country_manager',
  'hq_admin',
  'viewer',
] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const SCOPE_TYPES = ['global', 'country', 'branch'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

export const LANGUAGES = ['ar', 'sw', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];

export const ADMIN_LEVELS = [1, 2, 3] as const;
export type AdminLevel = (typeof ADMIN_LEVELS)[number];

// ---------------------------------------------------------------------------------------
// Standard columns + local row state
// ---------------------------------------------------------------------------------------

/**
 * Local-only bookkeeping carried by rows in IndexedDB. Never sent to the server; server rows
 * never contain these keys.
 */
export interface LocalRowState {
  /** 1 while the row has local changes the server has not acknowledged. */
  _dirty?: 1;
  /** 1 after a push answered `conflict` for this row; a reviewer decides. */
  _conflict?: 1;
  /** Fields whose local value was replaced by the server value because of a conflict. */
  _conflict_fields?: string[];
  /** Server version at the time of the conflict (the flag is dropped by a newer version). */
  _conflict_version?: number;
  /** 1 while an operation of this row sits in `failed_ops` ("needs attention"). */
  _failed?: 1;
}

/** Columns every table has (docs/contracts/schema.md §1). */
export interface StdColumns extends LocalRowState {
  id: Uuid;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
  created_by: Uuid | null;
  updated_by: Uuid | null;
  /** Server version; 0 for a row created on this device and not acknowledged yet. */
  version: number;
  deleted_at: IsoTimestamp | null;
}

// ---------------------------------------------------------------------------------------
// Geography / organisation
// ---------------------------------------------------------------------------------------

export interface CountryRow extends StdColumns {
  iso2: string;
  iso3: string | null;
  name_ar: string;
  name_en: string;
  name_sw: string | null;
  default_currency: string | null;
  active: boolean;
}

/** Sent without shapes (`admin_area_shapes` delivers simplified GeoJSON separately). */
export interface AdminAreaRow extends StdColumns {
  country_id: Uuid;
  parent_id: Uuid | null;
  level: AdminLevel;
  code: string;
  short_code: string | null;
  name_ar: string | null;
  name_en: string | null;
  name_sw: string | null;
}

export interface BranchRow extends StdColumns {
  country_id: Uuid;
  code: string;
  name_ar: string;
  name_en: string | null;
  name_sw: string | null;
  admin_area_ids: Uuid[];
  active: boolean;
}

export interface OptionValueRow extends StdColumns {
  list_key: OptionListKey;
  code: string;
  name_ar: string;
  name_en: string | null;
  name_sw: string | null;
  sort_order: number;
  active: boolean;
}

export interface FxRateRow extends StdColumns {
  currency: string;
  /** USD value of one unit of `currency`. */
  usd_per_unit: number;
  effective_date: IsoDate;
}

export interface LocalityRow extends StdColumns {
  country_id: Uuid;
  admin_area_id: Uuid | null;
  name_ar: string | null;
  name_latin: string | null;
  /** Server-maintained: `norm(name_ar || ' ' || name_latin)`. */
  name_norm: string;
  status: LocalityStatus;
  approved_by: Uuid | null;
  approved_at: IsoTimestamp | null;
  lon: number | null;
  lat: number | null;
}

// ---------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------

export interface DonorRow extends StdColumns {
  name_ar: string | null;
  name_latin: string | null;
  /** Server-maintained. */
  name_norm: string;
  notes: string | null;
}

export interface ProjectRow extends StdColumns {
  /** Server-generated (`TZ-PN-000123`); null until the first sync. */
  code: string | null;
  external_id: string | null;
  name_ar: string;
  name_latin: string | null;
  type: ProjectType;
  status: ProjectStatus;
  capacity: number | null;
  gps_accuracy_m: number | null;
  location_source: LocationSource | null;
  country_id: Uuid | null;
  admin_area_id: Uuid | null;
  locality_id: Uuid | null;
  branch_id: Uuid | null;
  builder: string | null;
  build_year: number | null;
  build_date: IsoDate | null;
  record_state: RecordState;
  review_note: string | null;
  reviewed_by: Uuid | null;
  reviewed_at: IsoTimestamp | null;
  /** Server-computed 0..100. Offline estimate: `projectCompleteness(bundle)`. */
  completeness: number;
  /** Server-maintained search text. */
  search_norm: string;
  import_batch_id: Uuid | null;
  lon: number | null;
  lat: number | null;
}

export interface ProjectLandRow extends StdColumns {
  project_id: Uuid;
  ownership: LandOwnership | null;
  owner_name: string | null;
  area_m2: number | null;
  utilization_pct: number | null;
  expandable: boolean | null;
  notes: string | null;
}

export interface ProjectFacilitiesRow extends StdColumns {
  project_id: Uuid;
  teacher_housing: boolean | null;
  imam_housing: boolean | null;
  guest_housing: boolean | null;
  library: boolean | null;
  hall: boolean | null;
  quran_count: number | null;
  quran_need: number | null;
  hall_capacity: number | null;
  student_transport: StudentTransport | null;
  students_origin: StudentsOrigin | null;
}

export interface ProjectMaintenanceRow extends StdColumns {
  project_id: Uuid;
  reported_on: IsoDate;
  description: string;
  priority: MaintenancePriority;
  estimated_cost: number | null;
  currency: string | null;
  state: MaintenanceState;
  resolved_on: IsoDate | null;
}

export interface ProjectPhotoRow extends StdColumns {
  project_id: Uuid;
  /** `projects/{ISO2}/{project_id}/{id}_full.webp|jpg` — bucket `photos`. */
  storage_path_full: string;
  storage_path_thumb: string;
  taken_at: IsoTimestamp | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  is_cover: boolean;
  category: PhotoCategory;
  caption: string | null;
  upload_state: PhotoUploadState;
  purged_at: IsoTimestamp | null;
}

export interface ProjectDonorRow extends StdColumns {
  project_id: Uuid;
  donor_id: Uuid;
  amount: number | null;
  currency: string | null;
  year: number | null;
}

// ---------------------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------------------

export interface PersonRow extends StdColumns {
  name_ar: string | null;
  name_latin: string | null;
  /** Server-maintained (both scripts in one string). */
  name_normalized: string;
  phone_e164: string | null;
  gender: Gender | null;
  birth_year: number | null;
  birth_date: IsoDate | null;
  home_admin_area_id: Uuid | null;
  home_area_text: string | null;
  education_level: string | null;
  graduated_from: string | null;
  country_id: Uuid | null;
  branch_id: Uuid | null;
  merged_into_id: Uuid | null;
}

export interface ProjectStaffRow extends StdColumns {
  project_id: Uuid;
  person_id: Uuid;
  role: StaffRole;
  start_date: IsoDate | null;
  end_date: IsoDate | null;
}

type OptionColumns = { [K in OptionListKey]: Uuid[] } & { [K in OptionListKey as `${K}_other`]: string | null };

export interface CommunityProfileRow extends StdColumns, OptionColumns {
  project_id: Uuid;
  branch_name: string | null;
  population: number | null;
  muslim_pct: number | null;
}

/** RESTRICTED: never pulled by collectors or supervisors. */
export interface StaffCompensationRow extends StdColumns {
  project_staff_id: Uuid;
  monthly_amount: number;
  currency: Currency;
  effective_from: IsoDate;
}

/** RESTRICTED. */
export interface CommunitySensitiveRow extends StdColumns {
  project_id: Uuid;
  ibadi_families: number | null;
  omani_families: number | null;
  omani_student_pct: number | null;
  ibadi_student_pct: number | null;
  omani_teacher_pct: number | null;
  ibadi_teacher_pct: number | null;
  guest_financial_capacity: GuestFinancialCapacity | null;
}

// ---------------------------------------------------------------------------------------
// Review / operations
// ---------------------------------------------------------------------------------------

export interface PersonMergeRequestRow extends StdColumns {
  source_person_id: Uuid;
  target_person_id: Uuid;
  state: MergeRequestState;
  reason: string | null;
  decided_by: Uuid | null;
  decided_at: IsoTimestamp | null;
  /** Owned by the merge functions; opaque to the client. */
  undo: unknown;
}

export interface SyncConflictRow extends StdColumns {
  table_name: string;
  row_id: Uuid;
  project_id: Uuid | null;
  /** Column name; `geom` for a location conflict (values are `{lon, lat}`). */
  field: string;
  base_version: number | null;
  server_value: unknown;
  client_value: unknown;
  client_user_id: Uuid | null;
  client_device_id: string | null;
  client_op_id: Uuid | null;
  state: ConflictState;
  resolved_by: Uuid | null;
  resolved_at: IsoTimestamp | null;
}

export interface NotificationRow extends StdColumns {
  user_id: Uuid;
  /** e.g. `export.ready`; the client renders the text from `kind` + `payload`. */
  kind: string;
  payload: Record<string, unknown>;
  read_at: IsoTimestamp | null;
}

export interface MapPackRow extends StdColumns {
  code: string;
  name_ar: string;
  name_en: string | null;
  name_sw: string | null;
  country_id: Uuid | null;
  admin_area_id: Uuid | null;
  /** Object in bucket `tiles`. */
  storage_path: string;
  bytes: number;
  min_zoom: number | null;
  max_zoom: number | null;
  min_lon: number | null;
  min_lat: number | null;
  max_lon: number | null;
  max_lat: number | null;
  tiles_version: string | null;
  sha256: string | null;
  active: boolean;
}

// ---------------------------------------------------------------------------------------
// Table name union and the Row<T> lookup
// ---------------------------------------------------------------------------------------

/** One entry per syncable table, in pull order (`private.sync_tables`). */
export interface RowMap {
  countries: CountryRow;
  admin_areas: AdminAreaRow;
  branches: BranchRow;
  option_values: OptionValueRow;
  fx_rates: FxRateRow;
  localities: LocalityRow;
  donors: DonorRow;
  projects: ProjectRow;
  project_land: ProjectLandRow;
  project_facilities: ProjectFacilitiesRow;
  project_maintenance: ProjectMaintenanceRow;
  project_photos: ProjectPhotoRow;
  project_donors: ProjectDonorRow;
  persons: PersonRow;
  project_staff: ProjectStaffRow;
  community_profiles: CommunityProfileRow;
  staff_compensation: StaffCompensationRow;
  community_sensitive: CommunitySensitiveRow;
  person_merge_requests: PersonMergeRequestRow;
  sync_conflicts: SyncConflictRow;
  notifications: NotificationRow;
  map_packs: MapPackRow;
}

export type TableName = keyof RowMap;
export type Row<T extends TableName> = RowMap[T];
export type AnyRow = RowMap[TableName];

/** Tables whose rows are RESTRICTED (brief §3). */
export type RestrictedTableName = 'staff_compensation' | 'community_sensitive';

/** Children of a project that are dropped locally with it (tombstone / `gone`). */
export type ProjectChildTable =
  | 'project_land'
  | 'project_facilities'
  | 'project_maintenance'
  | 'project_photos'
  | 'project_donors'
  | 'project_staff'
  | 'community_profiles'
  | 'community_sensitive';

// ---------------------------------------------------------------------------------------
// Sync wire shapes (docs/contracts/sync.md §4–5)
// ---------------------------------------------------------------------------------------

export type PushKind = 'upsert' | 'delete';

/** One element of `sync_push(p_ops)`. */
export interface PushOp {
  op_id: Uuid;
  table: TableName;
  id: Uuid;
  kind: PushKind;
  /** Version of the row the edit was made on; 0 = created on this device. */
  base_version: number;
  fields: Record<string, unknown>;
  client_ts: IsoTimestamp;
}

export type PushStatus = 'applied' | 'merged' | 'conflict' | 'rejected' | 'duplicate';

export interface PushError {
  code: string;
  message?: string;
  sqlstate?: string;
  constraint?: string;
  column?: string;
}

/** One element of `sync_push().results`. */
export interface PushResult {
  op_id: Uuid;
  status: PushStatus;
  version?: number;
  /** Present on `duplicate`: the status the operation had when it was first applied. */
  original_status?: Exclude<PushStatus, 'duplicate' | 'rejected'>;
  /** Natural-key redirect: the op was applied to this already existing row. */
  row_id?: Uuid;
  conflict_ids?: Uuid[];
  conflict_fields?: string[];
  /** Never present for restricted tables. A location conflict is `{ geom: { lon, lat } }`. */
  server_values?: Record<string, unknown>;
  ignored_fields?: string[];
  error?: PushError;
}

/** One element of `sync_pull().changes`. */
export interface PullChange<T extends TableName = TableName> {
  table: T;
  rows?: Array<Row<T>>;
  /** Ids that left the caller's scope. */
  gone?: Uuid[];
}

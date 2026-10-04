/**
 * Registry of syncable tables — the web twin of `private.sync_tables`
 * (docs/contracts/sync.md §1; migration 0020). Order, audience, restricted flag, natural keys
 * and server-managed columns must stay identical to the server:
 *   - `tables.test.ts` fails when this file drifts from docs/contracts/sync.md;
 *   - `apps/web/tests/integration/registry.live.test.ts` compares it with the database.
 */
import type { LocalRowState, RestrictedTableName, Row, StdColumns, TableName } from './types';

export type ScopeKind =
  'global' | 'country' | 'row' | 'project' | 'staff' | 'person' | 'own' | 'conflict' | 'donor';
export type Audience = 'all' | 'people' | 'restricted' | 'review';
export type PushClass = 'none' | 'writer' | 'creator' | 'project_editor' | 'reviewer' | 'self';

export interface SyncTableDef<T extends TableName = TableName> {
  name: T;
  /** `pull_order`: tables are pulled, and parents are pushed, in ascending order. */
  order: number;
  scope: ScopeKind;
  /** Column that ties the row to its scope parent (`project_id`, `project_staff_id`, …). */
  scopeCol: string | null;
  audience: Audience;
  /** Restricted tables: blind writes, pulled only by country managers / HQ at aal2. */
  restricted: boolean;
  push: { insert: PushClass; update: PushClass; delete: PushClass };
  /** Columns identifying the one LIVE row (server applies an insert to that row). */
  naturalKey: readonly string[] | null;
  /** The table has a point: `lon`/`lat` on the wire, always sent together. */
  geomPoint: boolean;
  /** Server-managed columns of this table (in addition to `STD_SERVER_COLUMNS`). */
  protectedCols: readonly string[];
  /** Set on insert, never changed afterwards (parent links). */
  immutableCols: readonly string[];
  /** When set: the only columns a client may write. */
  writableCols: readonly string[] | null;
  /**
   * Foreign keys to tables whose rows can be created on the device. The outbox uses them to
   * keep a parent in front of its children.
   */
  refs: Readonly<Record<string, TableName>>;
  /** Wire columns of the table without the standard ones (`lon`/`lat` included). */
  columns: readonly string[];
}

/**
 * Standard columns the server manages; `sync_push` ignores them silently, so they are never
 * put into an outbox operation. (`created_at` is the offline entry time: see
 * `CLIENT_INSERT_COLUMNS`.)
 */
export const STD_SERVER_COLUMNS = [
  'id',
  'version',
  'created_at',
  'created_by',
  'updated_at',
  'updated_by',
  'deleted_at',
  'sync_xid',
] as const;

/** Never on the wire: points travel as `lon` / `lat`. */
export const GEOMETRY_COLUMNS = ['geom', 'geom_simple'] as const;

/** The standard columns present on every wire row. */
export const STD_COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
  'version',
  'deleted_at',
] as const satisfies ReadonlyArray<Exclude<keyof StdColumns, keyof LocalRowState>>;

type OwnKey<T extends TableName> = Exclude<keyof Row<T>, keyof StdColumns> & string;

/**
 * Column list of a table, checked both ways by the compiler: every name must be a column of
 * `Row<T>` and no column of `Row<T>` may be missing.
 */
function columns<T extends TableName>() {
  return <const L extends ReadonlyArray<OwnKey<T>>>(
    list: L &
      (Exclude<OwnKey<T>, L[number]> extends never
        ? unknown
        : { missing: Exclude<OwnKey<T>, L[number]> }),
  ): L => list;
}

const OPTION_COLUMNS = [
  'daawa_activities',
  'daawa_activities_other',
  'social_features',
  'social_features_other',
  'livelihoods',
  'livelihoods_other',
  'religious_issues',
  'religious_issues_other',
  'religious_challenges',
  'religious_challenges_other',
  'social_challenges',
  'social_challenges_other',
  'proposed_activities',
  'proposed_activities_other',
] as const;

/** Wire columns per table (without the standard columns), in database order. */
export const TABLE_COLUMNS = {
  countries: columns<'countries'>()([
    'iso2',
    'iso3',
    'name_ar',
    'name_en',
    'name_sw',
    'default_currency',
    'active',
  ]),
  admin_areas: columns<'admin_areas'>()([
    'country_id',
    'parent_id',
    'level',
    'code',
    'short_code',
    'name_ar',
    'name_en',
    'name_sw',
  ]),
  branches: columns<'branches'>()([
    'country_id',
    'code',
    'name_ar',
    'name_en',
    'name_sw',
    'admin_area_ids',
    'active',
  ]),
  option_values: columns<'option_values'>()([
    'list_key',
    'code',
    'name_ar',
    'name_en',
    'name_sw',
    'sort_order',
    'active',
  ]),
  fx_rates: columns<'fx_rates'>()(['currency', 'usd_per_unit', 'effective_date']),
  localities: columns<'localities'>()([
    'country_id',
    'admin_area_id',
    'name_ar',
    'name_latin',
    'name_norm',
    'status',
    'approved_by',
    'approved_at',
    'lon',
    'lat',
  ]),
  donors: columns<'donors'>()(['name_ar', 'name_latin', 'name_norm', 'notes']),
  projects: columns<'projects'>()([
    'code',
    'external_id',
    'name_ar',
    'name_latin',
    'type',
    'status',
    'capacity',
    'gps_accuracy_m',
    'location_source',
    'country_id',
    'admin_area_id',
    'locality_id',
    'branch_id',
    'builder',
    'build_year',
    'build_date',
    'record_state',
    'review_note',
    'reviewed_by',
    'reviewed_at',
    'completeness',
    'search_norm',
    'import_batch_id',
    'migration_note',
    'lon',
    'lat',
  ]),
  project_land: columns<'project_land'>()([
    'project_id',
    'ownership',
    'owner_name',
    'area_m2',
    'utilization_pct',
    'expandable',
    'notes',
  ]),
  project_facilities: columns<'project_facilities'>()([
    'project_id',
    'teacher_housing',
    'imam_housing',
    'guest_housing',
    'library',
    'hall',
    'quran_count',
    'quran_need',
    'hall_capacity',
    'student_transport',
    'students_origin',
  ]),
  project_maintenance: columns<'project_maintenance'>()([
    'project_id',
    'reported_on',
    'description',
    'priority',
    'estimated_cost',
    'currency',
    'state',
    'resolved_on',
  ]),
  project_photos: columns<'project_photos'>()([
    'project_id',
    'storage_path_full',
    'storage_path_thumb',
    'taken_at',
    'width',
    'height',
    'bytes',
    'is_cover',
    'category',
    'caption',
    'upload_state',
    'purged_at',
  ]),
  project_donors: columns<'project_donors'>()([
    'project_id',
    'donor_id',
    'amount',
    'currency',
    'year',
  ]),
  persons: columns<'persons'>()([
    'name_ar',
    'name_latin',
    'name_normalized',
    'phone_e164',
    'gender',
    'birth_year',
    'birth_date',
    'home_admin_area_id',
    'home_area_text',
    'education_level',
    'graduated_from',
    'country_id',
    'branch_id',
    'merged_into_id',
  ]),
  project_staff: columns<'project_staff'>()([
    'project_id',
    'person_id',
    'role',
    'start_date',
    'end_date',
  ]),
  community_profiles: columns<'community_profiles'>()([
    'project_id',
    'branch_name',
    'population',
    'muslim_pct',
    ...OPTION_COLUMNS,
  ]),
  staff_compensation: columns<'staff_compensation'>()([
    'project_staff_id',
    'monthly_amount',
    'currency',
    'effective_from',
  ]),
  community_sensitive: columns<'community_sensitive'>()([
    'project_id',
    'ibadi_families',
    'omani_families',
    'omani_student_pct',
    'ibadi_student_pct',
    'omani_teacher_pct',
    'ibadi_teacher_pct',
    'guest_financial_capacity',
  ]),
  person_merge_requests: columns<'person_merge_requests'>()([
    'source_person_id',
    'target_person_id',
    'state',
    'reason',
    'decided_by',
    'decided_at',
    'undo',
  ]),
  sync_conflicts: columns<'sync_conflicts'>()([
    'table_name',
    'row_id',
    'project_id',
    'field',
    'base_version',
    'server_value',
    'client_value',
    'client_user_id',
    'client_device_id',
    'client_op_id',
    'state',
    'resolved_by',
    'resolved_at',
  ]),
  notifications: columns<'notifications'>()(['user_id', 'kind', 'payload', 'read_at']),
  map_packs: columns<'map_packs'>()([
    'code',
    'name_ar',
    'name_en',
    'name_sw',
    'country_id',
    'admin_area_id',
    'storage_path',
    'bytes',
    'min_zoom',
    'max_zoom',
    'min_lon',
    'min_lat',
    'max_lon',
    'max_lat',
    'tiles_version',
    'sha256',
    'active',
  ]),
} as const satisfies { [T in TableName]: readonly string[] };

type DefInput = Partial<
  Pick<
    SyncTableDef,
    | 'scopeCol'
    | 'audience'
    | 'naturalKey'
    | 'geomPoint'
    | 'protectedCols'
    | 'immutableCols'
    | 'writableCols'
    | 'refs'
  >
>;

function def<T extends TableName>(
  name: T,
  order: number,
  scope: ScopeKind,
  push: [PushClass, PushClass, PushClass],
  extra: DefInput = {},
): SyncTableDef<T> {
  const audience = extra.audience ?? 'all';
  return {
    name,
    order,
    scope,
    scopeCol: extra.scopeCol ?? null,
    audience,
    restricted: audience === 'restricted',
    push: { insert: push[0], update: push[1], delete: push[2] },
    naturalKey: extra.naturalKey ?? null,
    geomPoint: extra.geomPoint ?? false,
    protectedCols: extra.protectedCols ?? [],
    immutableCols: extra.immutableCols ?? [],
    writableCols: extra.writableCols ?? null,
    refs: extra.refs ?? {},
    columns: TABLE_COLUMNS[name],
  };
}

const NONE: [PushClass, PushClass, PushClass] = ['none', 'none', 'none'];
const EDITOR: [PushClass, PushClass, PushClass] = [
  'project_editor',
  'project_editor',
  'project_editor',
];
const projectChild = (extra: DefInput = {}): DefInput => ({
  scopeCol: 'project_id',
  immutableCols: ['project_id'],
  ...extra,
  refs: { project_id: 'projects', ...(extra.refs ?? {}) },
});

/** Same tables, same order as `private.sync_tables`. */
export const SYNC_TABLES: readonly SyncTableDef[] = [
  def('countries', 10, 'global', NONE),
  def('admin_areas', 20, 'country', NONE),
  def('branches', 30, 'global', NONE),
  def('option_values', 40, 'global', NONE),
  def('fx_rates', 50, 'global', NONE),
  def('localities', 60, 'country', ['writer', 'creator', 'creator'], {
    geomPoint: true,
    protectedCols: ['name_norm', 'approved_by', 'approved_at'],
  }),
  // donors have no country/branch: visible to global readers, their creator, and through
  // project_donors -> projects in the read scope (sync.md 5.5). No `gone` list for them.
  def('donors', 70, 'donor', ['writer', 'writer', 'creator'], { protectedCols: ['name_norm'] }),
  def('projects', 80, 'row', ['writer', 'creator', 'creator'], {
    geomPoint: true,
    protectedCols: [
      'code',
      'completeness',
      'search_norm',
      'import_batch_id',
      'reviewed_by',
      'reviewed_at',
    ],
    refs: { locality_id: 'localities' },
  }),
  def('project_land', 90, 'project', EDITOR, projectChild({ naturalKey: ['project_id'] })),
  def('project_facilities', 100, 'project', EDITOR, projectChild({ naturalKey: ['project_id'] })),
  def('project_maintenance', 110, 'project', ['writer', 'creator', 'creator'], projectChild()),
  def(
    'project_photos',
    120,
    'project',
    ['writer', 'creator', 'creator'],
    projectChild({ protectedCols: ['purged_at'] }),
  ),
  def('project_donors', 130, 'project', EDITOR, projectChild({ refs: { donor_id: 'donors' } })),
  def('persons', 140, 'row', ['writer', 'writer', 'creator'], {
    audience: 'people',
    protectedCols: ['name_normalized', 'merged_into_id'],
  }),
  def(
    'project_staff',
    150,
    'project',
    EDITOR,
    projectChild({ audience: 'people', refs: { person_id: 'persons' } }),
  ),
  def('community_profiles', 160, 'project', EDITOR, projectChild({ naturalKey: ['project_id'] })),
  def('staff_compensation', 170, 'staff', ['writer', 'writer', 'creator'], {
    scopeCol: 'project_staff_id',
    audience: 'restricted',
    naturalKey: ['project_staff_id', 'effective_from'],
    immutableCols: ['project_staff_id'],
    refs: { project_staff_id: 'project_staff' },
  }),
  def(
    'community_sensitive',
    180,
    'project',
    ['writer', 'writer', 'creator'],
    projectChild({ audience: 'restricted', naturalKey: ['project_id'] }),
  ),
  def('person_merge_requests', 190, 'person', ['reviewer', 'reviewer', 'reviewer'], {
    scopeCol: 'source_person_id',
    audience: 'review',
    protectedCols: ['decided_by', 'decided_at', 'undo'],
    immutableCols: ['source_person_id', 'target_person_id'],
    refs: { source_person_id: 'persons', target_person_id: 'persons' },
  }),
  def('sync_conflicts', 200, 'conflict', NONE, { audience: 'review' }),
  def('notifications', 210, 'own', ['none', 'self', 'none'], {
    scopeCol: 'user_id',
    writableCols: ['read_at'],
  }),
  def('map_packs', 220, 'global', NONE),
];

export const TABLE_NAMES: readonly TableName[] = SYNC_TABLES.map((t) => t.name);

const BY_NAME = new Map<TableName, SyncTableDef>(SYNC_TABLES.map((t) => [t.name, t]));

export function isTableName(name: unknown): name is TableName {
  return typeof name === 'string' && BY_NAME.has(name as TableName);
}

export function tableDef(name: TableName): SyncTableDef {
  const d = BY_NAME.get(name);
  if (!d) throw new Error(`unknown sync table: ${String(name)}`);
  return d;
}

export const RESTRICTED_TABLES: readonly RestrictedTableName[] = [
  'staff_compensation',
  'community_sensitive',
];

export function isRestrictedTable(name: TableName): name is RestrictedTableName {
  return tableDef(name).restricted;
}

/** Tables with a direct `project_id` link that are dropped locally together with the project. */
export const PROJECT_CHILD_TABLES = SYNC_TABLES.filter(
  (t) => t.scope === 'project' && t.scopeCol === 'project_id',
).map((t) => t.name);

/** The five child tables that count towards `projects.completeness` (schema.md §5). */
export const COMPLETENESS_CHILD_TABLES = [
  'project_photos',
  'project_land',
  'project_facilities',
  'project_staff',
  'community_profiles',
] as const satisfies readonly TableName[];

/**
 * Standard columns a client may send on INSERT only. `created_at` carries the offline entry
 * time (schema.md §1: a supplied value is kept unless it lies more than 5 minutes in the
 * future); the server ignores it on updates.
 */
export const CLIENT_INSERT_COLUMNS: readonly string[] = ['created_at'];

const writableCache = new Map<TableName, ReadonlySet<string>>();

/**
 * Columns a client may put into `fields` of an upsert — the twin of
 * `private.sync_writable_columns()` (plus `lon`/`lat` for point tables). Empty for tables
 * that are not writable through `sync_push`.
 */
export function writableColumns(name: TableName): ReadonlySet<string> {
  let set = writableCache.get(name);
  if (!set) {
    const d = tableDef(name);
    const out = new Set<string>();
    const isWritable = d.push.insert !== 'none' || d.push.update !== 'none';
    if (isWritable) {
      for (const c of d.columns) {
        if (d.protectedCols.includes(c)) continue;
        if (d.writableCols && !d.writableCols.includes(c)) continue;
        out.add(c);
      }
    }
    set = out;
    writableCache.set(name, set);
  }
  return set;
}

/** Whether rows of the table can be created / changed / deleted through the outbox at all. */
export function canPush(name: TableName, action: 'insert' | 'update' | 'delete'): boolean {
  return tableDef(name).push[action] !== 'none';
}

/** Every column of a wire row (standard columns first). */
export function wireColumns(name: TableName): readonly string[] {
  return [...STD_COLUMNS, ...tableDef(name).columns];
}

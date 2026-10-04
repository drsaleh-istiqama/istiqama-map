/**
 * Shapes of the administration RPCs and Edge Function (docs/contracts/people-admin.md §6–7,
 * supabase/functions/README.md §5.6) and of the reference rows the console edits through
 * PostgREST (docs/contracts/schema.md §3, authz.md §4.1).
 */
import type { RoleName } from '../auth';

export type ScopeType = 'global' | 'country' | 'branch';

export const ROLE_NAMES: readonly RoleName[] = [
  'hq_admin',
  'country_manager',
  'branch_supervisor',
  'field_collector',
  'viewer',
];

/** `admin_users()` → roles[] */
export interface AdminRole {
  id: string;
  role: RoleName;
  scope_type: ScopeType;
  scope_id: string | null;
  scope_name_ar: string | null;
  scope_name_en: string | null;
  scope_name_sw: string | null;
  country_id: string | null;
  created_at: string;
}

/** `admin_users()` → devices[] */
export interface AdminDevice {
  id: string;
  device_id: string;
  label: string | null;
  user_agent: string | null;
  app_version: string | null;
  last_seen_at: string | null;
  last_push_at: string | null;
  last_pull_at: string | null;
  pending_ops: number;
  pending_photos: number;
  revoked_at: string | null;
}

/** One row of `admin_users()`. */
export interface AdminUser {
  id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  preferred_language: 'ar' | 'sw' | 'en' | null;
  active: boolean;
  sessions_revoked_at: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  roles: AdminRole[];
  devices: AdminDevice[];
}

export interface SetRoleResult {
  id: string;
  user_id: string;
  role: RoleName;
  scope_type: ScopeType;
  scope_id: string | null;
  created: boolean;
}

export interface RemoveRoleResult {
  id: string;
  user_id: string;
  removed: boolean;
}

/** Second half of a revocation done by the Edge Function (refresh tokens). */
export interface AuthLogoutOutcome {
  done: boolean;
  method?: string;
  detail?: string;
}

export interface RevokeResult {
  user_id: string;
  device_id: string | null;
  scope: 'user' | 'device';
  revoked_at: string;
  auth_logout_required: boolean;
  auth_logout?: AuthLogoutOutcome;
}

export interface SetActiveResult {
  user_id: string;
  active: boolean;
  changed: boolean;
  auth_logout_required: boolean;
  auth_logout?: AuthLogoutOutcome;
  auth_ban?: { done: boolean; banned?: boolean; detail?: string };
}

export interface RestoreDeviceResult {
  user_id: string;
  device_id: string;
  restored: boolean;
}

export interface CreateUserInput {
  email: string | null;
  phone: string | null;
  full_name: string;
  preferred_language: 'ar' | 'sw' | 'en';
  role: RoleName | null;
  scope_type: ScopeType | null;
  scope_id: string | null;
}

export interface CreateUserResult {
  user_id: string;
  email: string | null;
  phone: string | null;
  profile: { id: string; full_name: string | null } | null;
  role: SetRoleResult | null;
  role_error: { code?: string; message?: string; details?: string | null } | null;
}

// ---------------------------------------------------------------------------------------------
// sync_status()
// ---------------------------------------------------------------------------------------------

export interface SyncStatusDevice {
  id: string;
  device_id: string;
  label: string | null;
  user_agent: string | null;
  app_version: string | null;
  last_seen_at: string | null;
  last_push_at: string | null;
  last_pull_at: string | null;
  pending_ops: number;
  pending_photos: number;
  open_conflicts: number;
  rejected_7d: number;
  stale: boolean;
  revoked_at: string | null;
}

export interface SyncStatusUser {
  user_id: string;
  full_name: string | null;
  active: boolean;
  roles: Array<{ role: RoleName; scope_type: ScopeType; scope_id: string | null }>;
  device_count: number;
  pending_ops: number;
  pending_photos: number;
  open_conflicts: number;
  rejected_7d: number;
  last_seen_at: string | null;
  last_push_at: string | null;
  last_pull_at: string | null;
  devices: SyncStatusDevice[];
}

export interface SyncStatusReport {
  generated_at: string;
  scope: 'all' | 'country';
  country_ids: string[] | null;
  window_days: number;
  summary: {
    users: number;
    users_without_device: number;
    devices: number;
    stale_devices: number;
    pending_ops: number;
    pending_photos: number;
    open_conflicts: number;
    rejected_7d: number;
  };
  users: SyncStatusUser[];
}

// ---------------------------------------------------------------------------------------------
// Reference rows (direct PostgREST, hq_admin through RLS)
// ---------------------------------------------------------------------------------------------

interface ServerStd {
  id: string;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface CountryRec extends ServerStd {
  iso2: string;
  iso3: string | null;
  name_ar: string;
  name_en: string;
  name_sw: string | null;
  default_currency: string | null;
  active: boolean;
}

export interface BranchRec extends ServerStd {
  country_id: string;
  code: string;
  name_ar: string;
  name_en: string | null;
  name_sw: string | null;
  admin_area_ids: string[];
  active: boolean;
}

export const OPTION_LISTS = [
  'daawa_activities',
  'social_features',
  'livelihoods',
  'religious_issues',
  'religious_challenges',
  'social_challenges',
  'proposed_activities',
] as const;
export type OptionListKey = (typeof OPTION_LISTS)[number];

export interface OptionRec extends ServerStd {
  list_key: OptionListKey;
  code: string;
  name_ar: string;
  name_en: string | null;
  name_sw: string | null;
  sort_order: number;
  active: boolean;
}

export interface FxRateRec extends ServerStd {
  currency: string;
  usd_per_unit: number;
  effective_date: string;
}

export interface SettingRec extends ServerStd {
  key: string;
  value: unknown;
  description: string | null;
  is_public: boolean;
}

export interface MapPackRec extends ServerStd {
  code: string;
  name_ar: string;
  name_en: string | null;
  name_sw: string | null;
  country_id: string | null;
  admin_area_id: string | null;
  storage_path: string;
  bytes: number;
  min_zoom: number | null;
  max_zoom: number | null;
  tiles_version: string | null;
  sha256: string | null;
  active: boolean;
}

/** Tables the console writes with direct DML (authz.md §5). */
export type RefTable =
  'countries' | 'branches' | 'option_values' | 'fx_rates' | 'app_settings' | 'map_packs';

/** Tables whose rows reach the devices through `sync_pull` (a change is followed by syncNow). */
export const SYNCED_REF_TABLES: ReadonlySet<RefTable> = new Set<RefTable>([
  'countries',
  'branches',
  'option_values',
  'fx_rates',
  'map_packs',
]);

/** Admin-area row as the picker needs it (local Dexie copy or a PostgREST fallback). */
export interface AreaNode {
  id: string;
  country_id: string;
  parent_id: string | null;
  level: number;
  name_ar: string | null;
  name_en: string | null;
  name_sw: string | null;
}

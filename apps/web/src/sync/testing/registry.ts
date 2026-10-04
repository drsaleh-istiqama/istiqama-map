/**
 * TEST SUPPORT — the table registry of docs/contracts/sync.md §1 (order and restricted flag),
 * used by the reference local store and the fake server. Production code takes the registry
 * from `src/db` (`SYNC_TABLES`).
 */
import type { SyncTableInfo } from '../ports';

export const REGISTRY: readonly SyncTableInfo[] = [
  { name: 'countries' },
  { name: 'admin_areas' },
  { name: 'branches' },
  { name: 'option_values' },
  { name: 'fx_rates' },
  { name: 'localities' },
  { name: 'donors' },
  { name: 'projects' },
  { name: 'project_land' },
  { name: 'project_facilities' },
  { name: 'project_maintenance' },
  { name: 'project_photos' },
  { name: 'project_donors' },
  { name: 'persons' },
  { name: 'project_staff' },
  { name: 'community_profiles' },
  { name: 'staff_compensation', restricted: true },
  { name: 'community_sensitive', restricted: true },
  { name: 'person_merge_requests' },
  { name: 'sync_conflicts' },
  { name: 'notifications' },
  { name: 'map_packs' },
];

/** Tables whose rows belong to a project (`project_id`). */
export const PROJECT_CHILDREN: readonly string[] = [
  'project_land',
  'project_facilities',
  'project_maintenance',
  'project_photos',
  'project_donors',
  'project_staff',
  'community_profiles',
  'community_sensitive',
];

/** One live row per project (natural key `project_id`). */
export const ONE_PER_PROJECT: readonly string[] = [
  'project_land',
  'project_facilities',
  'community_profiles',
  'community_sensitive',
];

export function isRestricted(table: string): boolean {
  return REGISTRY.some((t) => t.name === table && t.restricted === true);
}

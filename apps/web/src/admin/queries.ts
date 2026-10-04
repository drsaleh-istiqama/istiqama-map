/**
 * Read-only local queries of the console on top of the exported Dexie instance
 * (docs/contracts/web.md §5): the synced administrative areas for the branch scope picker.
 */
import { db } from '../db';
import type { AreaNode } from './types';

/** Live admin areas of one country on this device (levels 1–3). */
export async function localAreas(countryId: string): Promise<AreaNode[]> {
  const rows = await db.admin_areas
    .where('[country_id+level]')
    .between([countryId, 0], [countryId, 99])
    .toArray();
  return rows
    .filter((r) => !r.deleted_at)
    .map((r) => ({
      id: r.id,
      country_id: r.country_id,
      parent_id: r.parent_id,
      level: r.level,
      name_ar: r.name_ar,
      name_en: r.name_en,
      name_sw: r.name_sw,
    }));
}

/** Names of a few areas (chips of a branch) from the local copy. */
export async function localAreaNames(ids: readonly string[]): Promise<Map<string, AreaNode>> {
  const out = new Map<string, AreaNode>();
  if (ids.length === 0) return out;
  const rows = await db.admin_areas.bulkGet([...ids]);
  for (const r of rows) {
    if (!r) continue;
    out.set(r.id, {
      id: r.id,
      country_id: r.country_id,
      parent_id: r.parent_id,
      level: r.level,
      name_ar: r.name_ar,
      name_en: r.name_en,
      name_sw: r.name_sw,
    });
  }
  return out;
}

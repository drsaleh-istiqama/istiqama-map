/**
 * The last dashboard of each scope, kept on the device for offline viewing (brief §4, §9).
 *
 * Stored in the local `meta` store of src/db under `reports.dashboard:<user>|<scope>` so that
 * a revoked session or device (`wipeAllLocalData`) and a change of user remove it with
 * everything else. An entry is shown only to the user who fetched it and only while his
 * roles are unchanged (`scope_epoch` of `my_context()`): after a change of roles the old
 * figures — possibly with payroll the user may no longer read — are ignored and pruned.
 */
import { deleteMeta, getMeta, listMeta, setMeta } from '../db';
import { scopeKey } from './scope';
import { parseDashboard, type Dashboard, type ScopeRef } from './types';

export const DASHBOARD_CACHE_PREFIX = 'reports.dashboard:';
/** Scopes kept per user (the most recently fetched ones). */
export const DASHBOARD_CACHE_MAX = 12;

interface StoredDashboard {
  epoch: string;
  savedAt: number;
  data: unknown;
}

export interface CachedDashboard {
  savedAt: number;
  data: Dashboard;
}

const keyOf = (userId: string, scope: ScopeRef): string =>
  `${DASHBOARD_CACHE_PREFIX}${userId}|${scopeKey(scope)}`;

function isStored(v: unknown): v is StoredDashboard {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as StoredDashboard).epoch === 'string' &&
    typeof (v as StoredDashboard).savedAt === 'number'
  );
}

export async function readCachedDashboard(
  userId: string,
  epoch: string,
  scope: ScopeRef,
): Promise<CachedDashboard | null> {
  try {
    const value = await getMeta<unknown>(keyOf(userId, scope));
    if (!isStored(value) || value.epoch !== epoch) return null;
    return { savedAt: value.savedAt, data: parseDashboard(value.data) };
  } catch {
    return null; // local database unavailable: behave as "nothing cached"
  }
}

/** Saves `data` and drops entries of other users, of an older scope epoch and the oldest beyond the limit. */
export async function writeCachedDashboard(
  userId: string,
  epoch: string,
  scope: ScopeRef,
  data: unknown,
  now = Date.now(),
): Promise<void> {
  try {
    const value: StoredDashboard = { epoch, savedAt: now, data };
    await setMeta(keyOf(userId, scope), value);
    const all = await listMeta<unknown>(DASHBOARD_CACHE_PREFIX);
    const mine: Array<{ key: string; savedAt: number }> = [];
    for (const entry of all) {
      const ownedByUser = entry.key.startsWith(`${DASHBOARD_CACHE_PREFIX}${userId}|`);
      if (!ownedByUser || !isStored(entry.value) || entry.value.epoch !== epoch) {
        await deleteMeta(entry.key);
      } else {
        mine.push({ key: entry.key, savedAt: entry.value.savedAt });
      }
    }
    mine.sort((a, b) => b.savedAt - a.savedAt);
    for (const stale of mine.slice(DASHBOARD_CACHE_MAX)) await deleteMeta(stale.key);
  } catch {
    // Quota or a closed database: the live figures are on screen anyway.
  }
}

/** Removes every cached dashboard of this device. */
export async function clearDashboardCache(): Promise<void> {
  try {
    for (const entry of await listMeta<unknown>(DASHBOARD_CACHE_PREFIX))
      await deleteMeta(entry.key);
  } catch {
    /* nothing to clear */
  }
}

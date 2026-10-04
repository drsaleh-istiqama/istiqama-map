import { beforeEach, describe, expect, it } from 'vitest';
import { listMeta, wipeAllLocalData } from '../db';
import { freshDb } from '../db/testing/factory';
import {
  clearDashboardCache,
  DASHBOARD_CACHE_MAX,
  DASHBOARD_CACHE_PREFIX,
  readCachedDashboard,
  writeCachedDashboard,
} from './cache';
import { dashboardFor, PEMBA, TZ } from './testkit';

const A = 'user-a';
const B = 'user-b';
const GLOBAL = { type: 'global' as const, id: null };
const COUNTRY = { type: 'country' as const, id: TZ };

beforeEach(async () => {
  await freshDb();
});

describe('dashboard cache', () => {
  it('returns the saved figures with the time they were saved', async () => {
    await writeCachedDashboard(A, 'e1', GLOBAL, dashboardFor('viewer'), 1000);
    const cached = await readCachedDashboard(A, 'e1', GLOBAL);
    expect(cached?.savedAt).toBe(1000);
    expect(cached?.data.totals.projects).toBe(33);
    expect(cached?.data.last_refreshed_at).toBe('2026-10-04T16:51:45.110089+00:00');
    expect(await readCachedDashboard(A, 'e1', COUNTRY)).toBeNull();
  });

  it('is per user and per scope epoch (a change of roles hides old payroll)', async () => {
    await writeCachedDashboard(A, 'e1', COUNTRY, dashboardFor('country_manager'));
    expect(await readCachedDashboard(B, 'e1', COUNTRY)).toBeNull();
    expect(await readCachedDashboard(A, 'e2', COUNTRY)).toBeNull();
    // A new epoch prunes the entries of the old one; another user's entries go too.
    await writeCachedDashboard(B, 'e9', GLOBAL, dashboardFor('viewer'));
    const keys = (await listMeta(DASHBOARD_CACHE_PREFIX)).map((e) => e.key);
    expect(keys).toEqual([`${DASHBOARD_CACHE_PREFIX}${B}|global`]);
  });

  it('keeps only the most recent scopes', async () => {
    for (let i = 0; i < DASHBOARD_CACHE_MAX + 3; i++) {
      await writeCachedDashboard(A, 'e1', { type: 'branch', id: `b${i}` }, {}, 1000 + i);
    }
    const keys = (await listMeta(DASHBOARD_CACHE_PREFIX)).map((e) => e.key);
    expect(keys).toHaveLength(DASHBOARD_CACHE_MAX);
    expect(keys).not.toContain(`${DASHBOARD_CACHE_PREFIX}${A}|branch:b0`);
  });

  it('is removed with the local data (sign-out / revoked device) and by clearDashboardCache', async () => {
    await writeCachedDashboard(
      A,
      'e1',
      { type: 'branch', id: PEMBA },
      dashboardFor('field_collector'),
    );
    await clearDashboardCache();
    expect(await readCachedDashboard(A, 'e1', { type: 'branch', id: PEMBA })).toBeNull();
    await writeCachedDashboard(A, 'e1', GLOBAL, dashboardFor('viewer'));
    await wipeAllLocalData();
    expect(await readCachedDashboard(A, 'e1', GLOBAL)).toBeNull();
  });
});

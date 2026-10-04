/**
 * The migration UI end to end on the real local database with a fake sync: first-run prompt,
 * summary before anything is written, progress, report, keys removed only once the server
 * acknowledged every operation (also later, in the background), the JSON file path.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ role: { value: 'field_collector' as string } }));

vi.mock('../auth', async () => {
  const { computed, signal } = await import('@preact/signals');
  const role = signal(h.role.value);
  const writer = (r: string) => r !== 'viewer';
  return {
    __role: role,
    session: signal({ user: { id: '0a000000-0000-4000-8000-00000000000a' } }),
    me: signal({
      user_id: '0a000000-0000-4000-8000-00000000000a',
      scopes: { write: { countries: [], branches: [] } },
    }),
    can: {
      write: computed(() => writer(role.value)),
      review: computed(() => false),
      seePeople: computed(() => true),
      seeRestricted: computed(() => false),
      admin: computed(() => false),
    },
    supabase: {},
    DIAL_COUNTRIES: [],
    toE164: () => null,
  };
});
vi.mock('../sync', async () => {
  const { signal } = await import('@preact/signals');
  return {
    syncStatus: signal({
      online: true,
      state: 'idle',
      pendingOps: 0,
      pendingPhotos: 0,
      failedOps: 0,
      lastSyncAt: null as number | null,
      lastError: null,
    }),
    syncNow: async () => undefined,
    transport: { rpc: async () => null, push: async () => [], pull: async () => ({}) },
    isSyncError: () => false,
    errorKey: () => 'sync.error_unknown',
  };
});
vi.mock('../photos', () => ({ addPhoto: async () => ({}) }));
vi.mock('../projects/form/geo', () => ({ locatePoint: async () => ({ source: 'none' }) }));

import * as auth from '../auth';
import {
  ackOp,
  db,
  markInflight,
  mutate,
  newRow,
  pendingOps,
  type OutboxOp,
  type PushResult,
} from '../db';
import { freshDb, serverRow } from '../db/testing/factory';
import { setLocale } from '../i18n';
import { clearPrefs } from '../lib/prefs';
import { uuidv7 } from '../lib/uuidv7';
import { navigate } from '../routes';
import * as sync from '../sync';
import { closeMigration, flow, setMigrationDeps } from './controller';
import { finalizePendingRuns } from './finalize';
import type { RunnerDeps } from './runner';
import { PNG_1PX, SAMPLE_PROJECTS } from './testing/fixtures';
import V2MigrationPrompt from './V2MigrationPrompt';
import { V2ImportSection } from './V2ImportSection';
import { V2_PEOPLE_KEY, V2_PROJECTS_KEY, type V2Project } from './v2types';

const TZ = '10000000-0000-4000-8000-0000000000a1';
const PN = '10000000-0000-4000-8000-0000000000b1';
const PEMBA = '10000000-0000-4000-8000-0000000000c1';
const USER = '0a000000-0000-4000-8000-00000000000a';

const roleSignal = (auth as unknown as { __role: { value: string } }).__role;
const status = sync.syncStatus as unknown as {
  value: { lastSyncAt: number | null; pendingOps: number };
};

async function seedReference(): Promise<void> {
  await db.countries.bulkPut([
    serverRow('countries', {
      id: TZ,
      iso2: 'TZ',
      iso3: 'TZA',
      name_ar: 'تنزانيا',
      name_en: 'Tanzania',
      name_sw: 'Tanzania',
      default_currency: 'TZS',
      active: true,
    }),
  ]);
  await db.admin_areas.bulkPut([
    serverRow('admin_areas', {
      id: PN,
      country_id: TZ,
      level: 1,
      code: 'PN',
      name_ar: 'بيمبا الشمالية',
      name_en: 'North Pemba',
    }),
  ]);
  await db.branches.bulkPut([
    serverRow('branches', {
      id: PEMBA,
      country_id: TZ,
      code: 'PEMBA',
      name_ar: 'فرع بيمبا',
      admin_area_ids: [PN],
      active: true,
    }),
  ]);
  await db.option_values.bulkPut([
    serverRow('option_values', {
      list_key: 'livelihoods',
      code: 'fishing',
      name_ar: 'الصيد',
      sort_order: 20,
      active: true,
    }),
    serverRow('option_values', {
      list_key: 'livelihoods',
      code: 'other',
      name_ar: 'أخرى',
      sort_order: 990,
      active: true,
    }),
  ]);
}

const STAFFED: V2Project = {
  ...SAMPLE_PROJECTS[0]!,
  id: 'v2-ui-1',
  staff: [{ name: 'محمد علي', role: 'imam', salary: 120000 }],
  photos: [{ id: 'p1', data: PNG_1PX, category: 'mosque_front', caption: 'الواجهة' }],
};

function fakeDeps(over: Partial<RunnerDeps> = {}) {
  const server = { acks: true, syncs: 0 };
  const deps: RunnerDeps = {
    userId: () => USER,
    online: () => true,
    async syncNow() {
      server.syncs++;
      if (!server.acks) return;
      const ops = await pendingOps();
      await markInflight(ops);
      for (const op of ops) await ackOp(answer(op));
    },
    serverExternalIds: async () => new Set(),
    locate: async () => ({ countryId: TZ, areaPath: [PN, null, null], adminAreaId: PN }),
    async addPhoto(projectId, _file, meta) {
      const row = newRow('project_photos', {
        project_id: projectId,
        storage_path_full: 'f',
        storage_path_thumb: 't',
        category: (meta.category ?? 'unspecified') as 'unspecified',
        caption: meta.caption ?? null,
      });
      await mutate('project_photos', row.id, row, { insert: true });
      return row;
    },
    writeScope: () => ({ countries: [], branches: [PEMBA] }),
    phone: () => null,
    texts: { fallbackName: (id) => `v2 ${id}`, salaryReviewNote: (c) => `salary ${c.join(',')}` },
    readLegacy: (k) => localStorage.getItem(k),
    removeLegacy: (k) => localStorage.removeItem(k),
    newId: () => uuidv7(),
    today: () => '2026-10-04',
    preSyncTimeoutMs: 500,
    ...over,
  };
  return { deps, server };
}

function answer(op: OutboxOp): PushResult {
  return {
    op_id: op.op_id,
    status: 'applied',
    version: op.table === 'staff_compensation' || op.table === 'community_sensitive' ? null : 1,
  };
}

function seedV2(projects: unknown[] = [...SAMPLE_PROJECTS, STAFFED]): void {
  localStorage.setItem(V2_PROJECTS_KEY, JSON.stringify(projects));
  localStorage.setItem(V2_PEOPLE_KEY, JSON.stringify([{ name: 'زينب', roles: ['teacher'] }]));
}

async function drafts(): Promise<Array<{ external_id: string | null; record_state: string }>> {
  return (await db.projects.toArray()).map((p) => ({
    external_id: p.external_id,
    record_state: p.record_state,
  }));
}

vi.setConfig({ testTimeout: 30_000 });

beforeEach(async () => {
  localStorage.clear();
  clearPrefs(); // also the in-memory copy of the preferences (the prompt's "later")
  await freshDb({ canSeeRestricted: false });
  await seedReference();
  await setLocale('en');
  roleSignal.value = 'field_collector';
  status.value = { ...status.value, lastSyncAt: null, pendingOps: 0 };
  navigate('/', { replace: true });
});

afterEach(() => {
  closeMigration();
  flow.value = { step: 'closed' };
  setMigrationDeps(null);
  cleanup();
  document.body.innerHTML = '';
});

describe('first-run prompt', () => {
  it('appears for a writer on a device with v2 data, and nowhere else', async () => {
    const { unmount } = render(<V2MigrationPrompt />);
    expect(screen.queryByTestId('v2-migrate-prompt')).toBeNull();
    unmount();

    seedV2();
    render(<V2MigrationPrompt />);
    const prompt = screen.getByTestId('v2-migrate-prompt');
    expect(prompt.textContent).toContain('6 projects');
    expect(within(prompt).getByTestId('v2-migrate-accept')).toBeTruthy();
  });

  it('is not shown to a viewer, nor on the pages that show the full panel', async () => {
    seedV2();
    roleSignal.value = 'viewer';
    const { rerender } = render(<V2MigrationPrompt />);
    expect(screen.queryByTestId('v2-migrate-prompt')).toBeNull();
    roleSignal.value = 'field_collector';
    navigate('/import');
    rerender(<V2MigrationPrompt />);
    await waitFor(() => expect(screen.queryByTestId('v2-migrate-prompt')).toBeNull());
    navigate('/map');
    await waitFor(() => expect(screen.getByTestId('v2-migrate-prompt')).toBeTruthy());
  });

  it('"later" hides it for this data only (a day); the keys are untouched', async () => {
    seedV2();
    render(<V2MigrationPrompt />);
    fireEvent.click(screen.getByTestId('v2-migrate-later'));
    await waitFor(() => expect(screen.queryByTestId('v2-migrate-prompt')).toBeNull());
    expect(localStorage.getItem(V2_PROJECTS_KEY)).not.toBeNull();
  });
});

describe('the migration dialog', () => {
  it('summary first (nothing written), then drafts, then the keys go once the push is acknowledged', async () => {
    seedV2();
    const { deps, server } = fakeDeps();
    setMigrationDeps(deps);
    render(<V2MigrationPrompt />);
    fireEvent.click(screen.getByTestId('v2-migrate-accept'));

    const summary = await screen.findByTestId('v2-migrate-summary', {}, { timeout: 5000 });
    expect(within(summary).getByTestId('v2-migrate-counts').textContent).toContain('6');
    expect(await db.projects.count()).toBe(0);
    expect(localStorage.getItem(V2_PROJECTS_KEY)).not.toBeNull();

    fireEvent.click(screen.getByTestId('v2-migrate-start'));
    const report = await screen.findByTestId('v2-migrate-report', {}, { timeout: 10000 });
    await waitFor(() => expect(report.getAttribute('data-pushed')).toBe('true'));
    expect(report.getAttribute('data-keys-removed')).toBe('true');
    expect(screen.getByTestId('v2-migrate-saved').textContent).toBe('6');

    const rows = await drafts();
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.record_state === 'draft' && r.external_id?.startsWith('v2:'))).toBe(
      true,
    );
    expect(await db.project_photos.count()).toBe(1);
    // One person per entry, never merged by name (brief §2.4): 5 demo managers + the staffed
    // project's manager and imam (both names also appear in demo projects) + the directory
    // entry "زينب".
    expect(await db.persons.count()).toBe(8);
    expect(localStorage.getItem(V2_PROJECTS_KEY)).toBeNull();
    expect(localStorage.getItem(V2_PEOPLE_KEY)).toBeNull();
    expect(server.syncs).toBeGreaterThan(0);
  });

  it('offline / not acknowledged: saved locally, the keys stay; removed after a later acknowledged sync', async () => {
    seedV2();
    const { deps, server } = fakeDeps();
    server.acks = false;
    setMigrationDeps(deps);
    render(<V2MigrationPrompt />);
    fireEvent.click(screen.getByTestId('v2-migrate-accept'));
    fireEvent.click(await screen.findByTestId('v2-migrate-start', {}, { timeout: 5000 }));
    const report = await screen.findByTestId('v2-migrate-report', {}, { timeout: 10000 });
    expect(report.getAttribute('data-pushed')).toBe('false');
    expect(screen.getByTestId('v2-migrate-push').textContent).toMatch(/waiting/i);
    expect(localStorage.getItem(V2_PROJECTS_KEY)).not.toBeNull();
    expect(await db.projects.count()).toBe(6);

    // The server comes back: the user presses "sync now" in the report.
    server.acks = true;
    fireEvent.click(screen.getByTestId('v2-migrate-sync'));
    await waitFor(() =>
      expect(screen.getByTestId('v2-migrate-report').getAttribute('data-pushed')).toBe('true'),
    );
    expect(localStorage.getItem(V2_PROJECTS_KEY)).toBeNull();
  });

  it('closed before the upload: the background finalizer removes the keys after the push', async () => {
    seedV2();
    const { deps, server } = fakeDeps();
    server.acks = false;
    setMigrationDeps(deps);
    render(<V2MigrationPrompt />);
    fireEvent.click(screen.getByTestId('v2-migrate-accept'));
    fireEvent.click(await screen.findByTestId('v2-migrate-start', {}, { timeout: 5000 }));
    await screen.findByTestId('v2-migrate-report', {}, { timeout: 10000 });
    fireEvent.click(screen.getByTestId('v2-migrate-close'));
    await waitFor(() => expect(screen.queryByTestId('v2-migrate-dialog')).toBeNull());

    // Nothing acknowledged yet → nothing removed.
    expect(await finalizePendingRuns({ ...deps, userId: () => USER })).toBe(0);
    expect(localStorage.getItem(V2_PROJECTS_KEY)).not.toBeNull();

    // The engine pushes later (no UI involved), then the finalizer runs.
    server.acks = true;
    await deps.syncNow();
    expect(await finalizePendingRuns({ ...deps, userId: () => USER })).toBe(1);
    expect(localStorage.getItem(V2_PROJECTS_KEY)).toBeNull();
    expect(localStorage.getItem(V2_PEOPLE_KEY)).toBeNull();
  });

  it('a second run of the same data creates nothing (idempotent) and still completes', async () => {
    const projects = [...SAMPLE_PROJECTS];
    seedV2(projects);
    const { deps } = fakeDeps();
    setMigrationDeps(deps);
    render(<V2MigrationPrompt />);
    fireEvent.click(screen.getByTestId('v2-migrate-accept'));
    fireEvent.click(await screen.findByTestId('v2-migrate-start', {}, { timeout: 5000 }));
    await screen.findByTestId('v2-migrate-report', {}, { timeout: 10000 });
    fireEvent.click(screen.getByTestId('v2-migrate-close'));
    expect(await db.projects.count()).toBe(5);

    // Same data written back (e.g. the user restored the v2 app): nothing new.
    seedV2(projects);
    cleanup();
    render(<V2ImportSection />);
    fireEvent.click(screen.getByTestId('v2-migrate-accept'));
    const summary = await screen.findByTestId('v2-migrate-summary', {}, { timeout: 5000 });
    expect(summary.textContent).toMatch(/migrated before/i);
    fireEvent.click(screen.getByTestId('v2-migrate-start'));
    await screen.findByTestId('v2-migrate-report', {}, { timeout: 10000 });
    expect(await db.projects.count()).toBe(5);
  });

  it('without the synced reference lists it explains the first sync is needed', async () => {
    await db.countries.clear();
    seedV2();
    const { deps } = fakeDeps();
    setMigrationDeps(deps);
    render(<V2MigrationPrompt />);
    fireEvent.click(screen.getByTestId('v2-migrate-accept'));
    const error = await screen.findByTestId('v2-migrate-error', {}, { timeout: 5000 });
    expect(error.getAttribute('data-code')).toBe('reference_missing');
    expect(localStorage.getItem(V2_PROJECTS_KEY)).not.toBeNull();
  });
});

describe('settings section — v2 backup file', () => {
  function pick(input: HTMLElement, file: File): void {
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    fireEvent.change(input);
  }

  it('a malformed file is refused inline; nothing is written', async () => {
    render(<V2ImportSection />);
    expect(screen.getByTestId('settings-v2-import')).toBeTruthy();
    expect(screen.getByTestId('v2-local-none')).toBeTruthy();
    pick(
      screen.getByTestId('v2-import-file'),
      new File(['[{"name": "مسجد'], 'broken.json', { type: 'application/json' }),
    );
    const err = await screen.findByTestId('v2-import-file-error');
    expect(err.textContent).toMatch(/damaged|not a JSON/i);
    pick(screen.getByTestId('v2-import-file'), new File(['{"a":1}'], 'other.json'));
    await waitFor(() =>
      expect(screen.getByTestId('v2-import-file-error').textContent).toMatch(/not a version 2/i),
    );
    expect(await db.projects.count()).toBe(0);
  });

  it('a v2 backup file is migrated as drafts; local keys are not involved', async () => {
    const { deps } = fakeDeps();
    setMigrationDeps(deps);
    render(<V2ImportSection />);
    pick(
      screen.getByTestId('v2-import-file'),
      new File([JSON.stringify([STAFFED], null, 2)], 'istiqama-backup-2025-12-01.json', {
        type: 'application/json',
      }),
    );
    await screen.findByTestId('v2-migrate-summary', {}, { timeout: 5000 });
    fireEvent.click(screen.getByTestId('v2-migrate-start'));
    const report = await screen.findByTestId('v2-migrate-report', {}, { timeout: 10000 });
    await waitFor(() => expect(report.getAttribute('data-pushed')).toBe('true'));
    const rows = await drafts();
    expect(rows).toEqual([{ external_id: 'v2:v2-ui-1', record_state: 'draft' }]);
    const staff = await db.project_staff.toArray();
    expect(staff.map((s) => s.role).sort()).toEqual(['imam', 'manager']);
  });
});

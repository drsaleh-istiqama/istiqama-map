import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SyncError } from './errors';
import type { DbPort, PageToApply } from './ports';
import { META_PULL_STATE, type PullState, pullChanges } from './pull';
import { FakeServer } from './testing/fakeServer';
import { LocalStore } from './testing/localStore';
import { TestClock } from './testing/testClock';

let n = 0;
const uid = (): string => {
  n++;
  return `00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
};

let store: LocalStore;
let server: FakeServer;
let clock: TestClock;

function deps(db: DbPort = store) {
  return { db, transport: server.transportFor('device-a'), clock };
}

function seedProjects(count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = uid();
    ids.push(id);
    server.write('projects', id, { name_ar: `مشروع ${i}`, type: 'mosque', capacity: i });
  }
  return ids;
}

beforeEach(() => {
  store = new LocalStore(`pull-${uid()}`);
  server = new FakeServer();
  clock = new TestClock();
});

afterEach(async () => {
  await store.destroy();
});

describe('pullChanges', () => {
  it('pages through the feed until done and stores the cursor', async () => {
    server.write('countries', uid(), { iso2: 'TZ', name_ar: 'تنزانيا' });
    const ids = seedProjects(1234);
    const outcome = await pullChanges(deps());
    expect(outcome).toEqual({ pages: 3, rows: 1235, done: true, reset: false });
    expect(server.calls.pull.map((c) => c.limit)).toEqual([500, 500, 500]);
    expect(server.calls.pull[0]!.cursor).toBeNull();
    expect(await store.allRows('projects')).toHaveLength(1234);
    expect(await store.getRow('projects', ids[700]!)).toMatchObject({ capacity: 700, version: 1 });
    const state = await store.getMeta<PullState>(META_PULL_STATE);
    expect(state).toMatchObject({ epoch: 'epoch-1', complete: true });
    expect(state?.cursor).toEqual({ e: 'epoch-1', lo: expect.any(Number), hi: null });

    // Nothing changed: the next cycle is one cheap call.
    const idle = await pullChanges(deps());
    expect(idle).toMatchObject({ pages: 1, rows: 0, done: true });
  });

  it('applies increments, tombstones and removes the children of a deleted project', async () => {
    const [a, b, c] = seedProjects(3) as [string, string, string];
    const photo = uid();
    const staff = uid();
    server.write('project_photos', photo, { project_id: b, upload_state: 'uploaded' });
    server.write('project_staff', staff, { project_id: b, role: 'imam' });
    server.write('staff_compensation', uid(), { project_staff_id: staff, monthly_amount: 1 });
    await pullChanges(deps());
    expect(await store.allRows('project_photos')).toHaveLength(1);

    server.write('projects', a, { capacity: 500 }, 'other');
    server.remove('projects', b);
    const outcome = await pullChanges(deps());
    expect(outcome).toMatchObject({ rows: 2, done: true });
    expect(await store.getRow('projects', a)).toMatchObject({ capacity: 500, version: 2 });
    expect(await store.getRow('projects', b)).toBeUndefined();
    expect(await store.getRow('projects', c)).toBeDefined();
    expect(await store.allRows('project_photos')).toHaveLength(0);
    expect(await store.allRows('project_staff')).toHaveLength(0);
  });

  it('resumes from the stored cursor after a crash between pages, without loss or duplicates', async () => {
    seedProjects(1100);
    // First run: page 1 is stored, then the "process dies" while page 2 is requested.
    let calls = 0;
    server.onPull = async () => {
      if (++calls === 2) throw new Error('process killed');
    };
    await expect(pullChanges(deps())).rejects.toThrow();
    expect(await store.allRows('projects')).toHaveLength(500);
    const afterCrash = await store.getMeta<PullState>(META_PULL_STATE);
    expect(afterCrash?.complete).toBe(false);

    server.onPull = null;
    store.close();
    store = new LocalStore(store.name);
    const outcome = await pullChanges(deps());
    // The first request of the new run carries the cursor of the page that was stored.
    expect(server.calls.pull[2]!.cursor).toEqual(afterCrash?.cursor);
    expect(outcome).toMatchObject({ pages: 2, rows: 600, done: true });
    expect(await store.allRows('projects')).toHaveLength(1100);
  });

  it('is idempotent when a page was written but its cursor was not (non-atomic crash)', async () => {
    seedProjects(700);
    let crash = true;
    const flaky: DbPort = Object.assign(Object.create(store) as DbPort, {
      applyPage: async (page: PageToApply) => {
        if (crash) {
          crash = false;
          await store.applyPage({ changes: page.changes, meta: [] }); // rows only…
          throw new Error('killed before the cursor was stored');
        }
        await store.applyPage(page);
      },
    });
    await expect(pullChanges(deps(flaky))).rejects.toThrow();
    expect(await store.allRows('projects')).toHaveLength(500);
    expect(await store.getMeta(META_PULL_STATE)).toBeUndefined();

    const outcome = await pullChanges(deps(flaky));
    expect(server.calls.pull[1]!.cursor).toBeNull(); // the same page again
    expect(outcome).toMatchObject({ pages: 2, done: true });
    expect(await store.allRows('projects')).toHaveLength(700);
  });

  it('does not overwrite a row with pending local edits: pending fields stay on top', async () => {
    const [id] = seedProjects(1) as [string];
    await pullChanges(deps());
    await store.mutate('projects', id, { builder: 'my edit' });
    server.write('projects', id, { capacity: 77, builder: 'their edit' }, 'other');

    await pullChanges(deps());
    expect(await store.getRow('projects', id)).toMatchObject({
      builder: 'my edit',
      capacity: 77,
      version: 2,
      _dirty: 1,
    });
    expect((await store.counts()).pendingOps).toBe(1);
  });

  it('honours reset: discards synced tables, keeps unsent work, applies the fresh first page', async () => {
    const [stale, edited] = seedProjects(2) as [string, string];
    await pullChanges(deps());
    await store.mutate('projects', edited, { builder: 'unsent' });
    const mine = uid();
    await store.mutate('projects', mine, { name_ar: 'جديد', type: 'school' });
    await store.mutate('community_sensitive', uid(), { project_id: mine, ibadi_families: 3 });
    await store.putPhotoBlob('photo-1', 'thumb', new Blob(['t']));
    await store.setMeta('drafts-like-meta', 1);

    // Roles changed on the server: new epoch, and `stale` is no longer in scope.
    server.epoch = 'epoch-2';
    server.visible = (_table, row) => row.id !== stale;
    const outcome = await pullChanges(deps());
    expect(outcome).toMatchObject({ reset: true, done: true });
    expect(server.calls.pull.at(-1)!.cursor).toMatchObject({ e: 'epoch-1' });
    expect(await store.getRow('projects', stale)).toBeUndefined();
    expect(await store.getRow('projects', edited)).toMatchObject({ builder: 'unsent', _dirty: 1 });
    expect(await store.getRow('projects', mine)).toMatchObject({ name_ar: 'جديد', _dirty: 1 });
    expect((await store.counts()).pendingOps).toBe(3);
    expect(await store.restrictedLocal()).toHaveLength(1);
    expect(await store.photoBlob('photo-1', 'thumb')).toBeDefined();
    expect(await store.getMeta<PullState>(META_PULL_STATE)).toMatchObject({ epoch: 'epoch-2', complete: true });
  });

  it('detects a changed scope_epoch even when the server does not say reset', async () => {
    const [a] = seedProjects(1) as [string];
    await pullChanges(deps());
    // Simulate a stored state from another epoch with an incremental cursor the server accepts.
    const state = (await store.getMeta<PullState>(META_PULL_STATE)) as PullState;
    await store.setMeta(META_PULL_STATE, { ...state, epoch: 'epoch-0' });
    const ghost = uid();
    await store.applyPage({ changes: [{ table: 'projects', rows: [{ id: ghost, version: 1, deleted_at: null }] }], meta: [] });

    const outcome = await pullChanges(deps());
    expect(outcome).toMatchObject({ reset: true, done: true });
    expect(server.calls.pull.at(-1)!.cursor).toBeNull(); // restarted from scratch
    expect(await store.getRow('projects', ghost)).toBeUndefined();
    expect(await store.getRow('projects', a)).toBeDefined();
    expect(await store.getMeta<PullState>(META_PULL_STATE)).toMatchObject({ epoch: 'epoch-1' });
  });

  it('removes rows listed as gone, with the children of projects', async () => {
    const [moved, kept] = seedProjects(2) as [string, string];
    server.write('project_land', uid(), { project_id: moved, ownership: 'waqf' });
    server.write('project_land', uid(), { project_id: kept, ownership: 'waqf' });
    await pullChanges(deps());
    expect(await store.allRows('project_land')).toHaveLength(2);

    server.announceGone('projects', [moved]);
    await pullChanges(deps());
    expect(await store.getRow('projects', moved)).toBeUndefined();
    expect(await store.getRow('projects', kept)).toBeDefined();
    expect((await store.allRows('project_land')).map((r) => r.project_id)).toEqual([kept]);
  });

  it('caps the pages per cycle and continues where it stopped', async () => {
    seedProjects(450);
    const first = await pullChanges(deps(), { pageSize: 100, maxPages: 2 });
    expect(first).toEqual({ pages: 2, rows: 200, done: false, reset: false });
    expect(await store.getMeta<PullState>(META_PULL_STATE)).toMatchObject({ complete: false });
    const second = await pullChanges(deps(), { pageSize: 100, maxPages: 10 });
    expect(second).toMatchObject({ pages: 3, rows: 250, done: true });
    expect(await store.allRows('projects')).toHaveLength(450);
  });

  it('yields to the UI and paces the calls between pages', async () => {
    seedProjects(300);
    const started = clock.now();
    await pullChanges(deps(), { pageSize: 100 });
    expect(clock.delays.filter((d) => d === 0).length).toBeGreaterThanOrEqual(2); // one yield per page
    expect(clock.now() - started).toBeGreaterThanOrEqual(240); // 120 ms between calls
  });

  it('halves the page size when a page is slow to store, and recovers', async () => {
    seedProjects(900);
    let slow = 1;
    const slowDb: DbPort = Object.assign(Object.create(store) as DbPort, {
      applyPage: async (page: PageToApply) => {
        if (slow-- > 0) clock.time += 2000;
        await store.applyPage(page);
      },
    });
    await pullChanges(deps(slowDb), { pageSize: 400 });
    expect(server.calls.pull.map((c) => c.limit)).toEqual([400, 200, 400]);
    expect(await store.allRows('projects')).toHaveLength(900);
  });

  it('retries a page on 5xx and 429 inside the cycle, with backoff', async () => {
    seedProjects(10);
    server.failNext('pull', new SyncError('server', 'HTTP 502', { status: 502 }));
    server.failNext('pull', new SyncError('rate_limited', 'slow', { status: 429, retryAfterMs: 2000 }));
    const started = clock.now();
    const outcome = await pullChanges(deps());
    expect(outcome.done).toBe(true);
    expect(clock.now() - started).toBeGreaterThanOrEqual(750 + 2000);
    expect(await store.allRows('projects')).toHaveLength(10);
  });

  it('gives up for this cycle after repeated failures and keeps the cursor', async () => {
    seedProjects(10);
    await pullChanges(deps());
    const before = await store.getMeta(META_PULL_STATE);
    server.offline = true;
    await expect(pullChanges(deps())).rejects.toMatchObject({ kind: 'network' });
    expect(await store.getMeta(META_PULL_STATE)).toEqual(before);
  });

  it('does not retry when the session is revoked', async () => {
    server.failNext('pull', new SyncError('session_revoked', 'sync_pull: session_revoked', { status: 403 }), 3);
    await expect(pullChanges(deps())).rejects.toMatchObject({ kind: 'session_revoked' });
    expect(clock.delays.filter((d) => d >= 500)).toEqual([]);
  });

  it('recovers from a cursor the server cannot read by starting over', async () => {
    const ids = seedProjects(3);
    await store.setMeta(META_PULL_STATE, { cursor: 'garbage', epoch: 'epoch-1', complete: true });
    await store.applyPage({ changes: [{ table: 'projects', rows: [{ id: 'ghost', version: 1, deleted_at: null }] }], meta: [] });
    const outcome = await pullChanges(deps());
    expect(outcome).toMatchObject({ reset: true, done: true });
    expect((await store.allRows('projects')).map((r) => r.id).sort()).toEqual([...ids].sort());
  });

  it('stops between pages when aborted and leaves a consistent cursor', async () => {
    seedProjects(300);
    const controller = new AbortController();
    let calls = 0;
    server.onPull = async () => {
      if (++calls === 2) controller.abort();
    };
    await expect(pullChanges(deps(), { pageSize: 100, signal: controller.signal })).rejects.toMatchObject({
      kind: 'aborted',
    });
    const stored = (await store.allRows('projects')).length;
    expect(stored).toBeGreaterThanOrEqual(100);
    server.onPull = null;
    await pullChanges(deps(), { pageSize: 100 });
    expect(await store.allRows('projects')).toHaveLength(300);
  });
});

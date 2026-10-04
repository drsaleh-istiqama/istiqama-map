import { effect } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type EngineOptions,
  META_LAST_SYNC,
  META_USER,
  type SyncEngine,
  createSyncEngine,
} from './engine';
import { SyncError } from './errors';
import { META_PULL_STATE, type PullState } from './pull';
import { FakeAuth, FakeLock, FakeNetwork, FakePrefs, FakeUploader, fakeApp } from './testing/fakes';
import { FakeServer } from './testing/fakeServer';
import { LocalStore } from './testing/localStore';
import { TestClock } from './testing/testClock';
import type { SyncState } from './types';

let n = 0;
const uid = (): string => {
  n++;
  return `00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
};

let store: LocalStore;
let server: FakeServer;
let clock: TestClock;
let net: FakeNetwork;
let prefs: FakePrefs;
let auth: FakeAuth;
let lock: FakeLock;
let uploader: FakeUploader;
let engine: SyncEngine;
const persistence = vi.fn(async () => 'persisted');

function build(options: EngineOptions = {}): SyncEngine {
  engine = createSyncEngine(
    {
      db: store,
      transport: server.transportFor(auth.device),
      auth,
      net,
      prefs,
      app: fakeApp,
      lock,
      uploader,
      clock,
      requestPersistence: persistence,
    },
    { push: { maxAttempts: 1 }, pull: { maxAttempts: 1 }, ...options },
  );
  return engine;
}

async function started(options: EngineOptions = {}): Promise<SyncEngine> {
  build(options);
  engine.start();
  await engine.whenIdle();
  return engine;
}

const rpcCalls = (fn: string) => server.calls.rpc.filter((c) => c.fn === fn);

/**
 * Resolves as soon as the status signal satisfies `predicate` — event driven (a signal
 * effect), so the test waits exactly as long as the asynchronous IndexedDB reads behind the
 * status take, however busy the machine is; no polling interval, no guessed delay.
 */
function statusReaches(predicate: (s: SyncEngine['status']['value']) => boolean): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    let dispose: (() => void) | null = null;
    dispose = effect(() => {
      if (done || !predicate(engine.status.value)) return;
      done = true;
      resolve();
      // disposing from inside the effect's first run: dispose is not assigned yet
      queueMicrotask(() => dispose?.());
    });
    if (done) dispose();
  });
}

beforeEach(() => {
  store = new LocalStore(`engine-${uid()}`);
  server = new FakeServer();
  // Short waits (pacing, yields, continuation) run by themselves; the two-minute interval,
  // the write kick and the cycle backoff wait for clock.advance().
  clock = new TestClock(1000);
  net = new FakeNetwork();
  prefs = new FakePrefs();
  auth = new FakeAuth();
  lock = new FakeLock();
  uploader = new FakeUploader();
  persistence.mockClear();
});

afterEach(async () => {
  engine?.stop();
  await engine?.whenIdle();
  await store.destroy();
});

describe('sync engine — cycles', () => {
  it('runs register → push → pull → heartbeat on start and reports a clean status', async () => {
    server.write('projects', uid(), { name_ar: 'من الخادم' });
    const mine = uid();
    await store.mutate('projects', mine, { name_ar: 'محلي', type: 'mosque' });
    build();
    const states: SyncState[] = [];
    const dispose = effect(() => {
      const s = engine.status.value.state;
      if (states.at(-1) !== s) states.push(s);
    });
    engine.start();
    await engine.whenIdle();
    dispose();

    expect(states).toEqual(['idle', 'pushing', 'pulling', 'pushing', 'idle']);
    expect(rpcCalls('register_device')).toHaveLength(1);
    expect(rpcCalls('register_device')[0]!.args).toEqual({
      p_device_id: 'device-a',
      p_label: 'test device',
      p_app_version: '3.0.0-test',
    });
    expect(server.row('projects', mine)).toMatchObject({ name_ar: 'محلي' });
    expect(await store.allRows('projects')).toHaveLength(2);
    expect(rpcCalls('report_device_status').at(-1)!.args).toMatchObject({
      p_pending_ops: 0,
      p_pending_photos: 0,
    });
    expect(engine.status.value).toEqual({
      online: true,
      state: 'idle',
      pendingOps: 0,
      pendingPhotos: 0,
      failedOps: 0,
      lastSyncAt: expect.any(Number),
      lastError: null,
    });
    expect(clock.now() - (engine.status.value.lastSyncAt as number)).toBeLessThan(1000);
    expect(await store.getMeta(META_LAST_SYNC)).toBe(engine.status.value.lastSyncAt);
    expect(persistence).toHaveBeenCalledTimes(1);
    // push happened before pull
    expect(server.calls.push).toHaveLength(1);
  });

  it('syncs again every two minutes while online', async () => {
    await started();
    expect(clock.waiting()).toEqual([120_000]);
    const pulls = server.calls.pull.length;
    await clock.advance(119_000);
    await engine.whenIdle();
    expect(server.calls.pull.length).toBe(pulls);
    await clock.advance(1_000);
    await engine.whenIdle();
    expect(server.calls.pull.length).toBe(pulls + 1);
    expect(rpcCalls('register_device')).toHaveLength(1); // only once per engine start
    expect(clock.waiting()).toEqual([120_000]);
  });

  it('does nothing while nobody is signed in', async () => {
    auth.user = null;
    await started();
    expect(server.calls.rpc).toHaveLength(0);
    expect(engine.status.value.state).toBe('idle');
    auth.user = 'user-1';
    engine.sessionChanged();
    await engine.whenIdle();
    expect(server.calls.pull.length).toBe(1);
  });

  it('pauses offline and syncs as soon as the connection is back', async () => {
    net.online = false;
    await started();
    expect(server.calls.rpc).toHaveLength(0);
    expect(engine.status.value).toMatchObject({ online: false, state: 'idle' });
    expect(clock.waiting()).toEqual([]);

    await store.mutate('projects', uid(), { name_ar: 'offline work', type: 'mosque' });
    await clock.advance(100);
    expect(engine.status.value.pendingOps).toBe(1);

    net.setOnline(true);
    await engine.whenIdle();
    expect(engine.status.value).toMatchObject({ online: true, state: 'idle', pendingOps: 0 });
    expect(server.liveRows('projects')).toHaveLength(1);
  });

  it('aborts the running cycle when the connection drops, without losing the batch', async () => {
    build();
    await store.mutate('projects', uid(), { name_ar: 'x', type: 'mosque' });
    server.onPush = async () => {
      net.setOnline(false);
      await new Promise((r) => setTimeout(r, 5));
    };
    engine.start();
    await engine.whenIdle();
    expect(engine.status.value).toMatchObject({ online: false, state: 'idle', lastError: null });
    expect((await store.allOps()).map((o) => o.state)).toEqual(['pending']);
    expect(clock.waiting()).toEqual([]);
  });

  it('syncs when the page becomes visible, but not more often than every 15 s', async () => {
    await started();
    const pulls = server.calls.pull.length;
    net.becomeVisible();
    await engine.whenIdle();
    expect(server.calls.pull.length).toBe(pulls);
    await clock.advance(15_000);
    net.becomeVisible();
    await engine.whenIdle();
    expect(server.calls.pull.length).toBe(pulls + 1);
  });

  it('syncNow() runs a cycle and resolves when it is finished', async () => {
    await started();
    const id = uid();
    await store.mutate('projects', id, { name_ar: 'now', type: 'mosque' });
    await engine.syncNow();
    expect(server.row('projects', id)).toBeDefined();
    expect(engine.status.value.pendingOps).toBe(0);
  });

  it('is single-flight: triggers during a cycle share it, syncNow() adds exactly one more', async () => {
    build();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    server.onPull = async () => {
      if (first) {
        first = false;
        await gate;
      }
    };
    engine.start();
    await new Promise((r) => setTimeout(r, 20));
    net.becomeVisible();
    net.setOnline(true);
    const a = engine.syncNow();
    const b = engine.syncNow();
    release();
    await Promise.all([a, b]);
    await engine.whenIdle();
    expect(server.calls.pull.length).toBe(2);
    expect(rpcCalls('register_device')).toHaveLength(1);
  });

  it('leaves the work to another tab that holds the lock', async () => {
    lock.heldElsewhere = true;
    await store.mutate('projects', uid(), { name_ar: 'x', type: 'mosque' });
    await started();
    expect(server.calls.rpc).toHaveLength(0);
    expect(server.calls.push).toHaveLength(0);
    expect(engine.status.value).toMatchObject({ pendingOps: 1, state: 'idle' });
    lock.heldElsewhere = false;
    await engine.syncNow();
    expect(engine.status.value.pendingOps).toBe(0);
  });

  it('continues right away when a cycle stopped at the page cap, and stamps lastSyncAt only at the end', async () => {
    for (let i = 0; i < 250; i++) server.write('donors', uid(), { name_ar: `d${i}` });
    build({ pull: { pageSize: 100, maxPages: 1, maxAttempts: 1 } });
    const stamps: Array<number | null> = [];
    const dispose = effect(() => {
      stamps.push(engine.status.value.lastSyncAt);
    });
    engine.start();
    for (let i = 0; i < 20 && server.calls.pull.length < 3; i++) {
      await engine.whenIdle();
      await new Promise((r) => setTimeout(r, 5));
    }
    await engine.whenIdle();
    dispose();
    expect(server.calls.pull.length).toBe(3);
    expect(await store.allRows('donors')).toHaveLength(250);
    expect(stamps.filter((s) => s !== null)).toHaveLength(1);
    expect(engine.status.value.state).toBe('idle');
    // heartbeats of continuation cycles are throttled: only the final one was sent
    expect(rpcCalls('report_device_status')).toHaveLength(2);
    expect(clock.waiting()).toEqual([120_000]);
  });
});

describe('sync engine — live counters', () => {
  it('shows pending operations as they are queued and syncs shortly after a local write', async () => {
    await started();
    const id = uid();
    await store.mutate('projects', id, { name_ar: 'x', type: 'mosque' });
    // The change notification refreshes the counters (a debounced timer, then an asynchronous
    // count): wait for that refresh itself rather than a fixed amount of time — under
    // full-suite load the count used to land after `clock.advance(60)` had returned.
    await statusReaches((s) => s.pendingOps === 1);
    expect(server.calls.push).toHaveLength(0);
    // write kick: 4 s after the write instead of waiting for the two-minute timer — scheduled
    // by the same refresh, synchronously after it published the counter
    expect(Math.min(...clock.waiting())).toBeLessThanOrEqual(4_000);
    await clock.advance(4_000);
    await engine.whenIdle();
    expect(server.row('projects', id)).toBeDefined();
    expect(engine.status.value.pendingOps).toBe(0);
  });

  it('counts rejected operations as failedOps', async () => {
    server.rejectIf = () => 'out_of_scope';
    await store.mutate('projects', uid(), { name_ar: 'x', type: 'mosque' });
    await started();
    expect(engine.status.value).toMatchObject({
      pendingOps: 0,
      failedOps: 1,
      state: 'idle',
      lastError: null,
    });
  });

  it('uploads photos after their rows were pushed and pushes the flip in the same cycle', async () => {
    const country = uid();
    server.write('countries', country, { iso2: 'TZ' });
    await started();

    const project = uid();
    const photo = uid();
    await store.mutate('projects', project, { name_ar: 'x', type: 'mosque', country_id: country });
    await store.mutate('project_photos', photo, {
      project_id: project,
      upload_state: 'pending',
      storage_path_full: `projects/TZ/${project}/${photo}_full.webp`,
      storage_path_thumb: `projects/TZ/${project}/${photo}_thumb.webp`,
    });
    await store.putPhotoBlob(photo, 'full', new Blob(['full-size'], { type: 'image/webp' }));
    await store.putPhotoBlob(photo, 'thumb', new Blob(['thumb'], { type: 'image/webp' }));
    await engine.enqueuePhotoUpload(photo);
    expect(engine.status.value).toMatchObject({ pendingPhotos: 1, pendingOps: 2 });

    await engine.syncNow();
    expect(uploader.calls.map((c) => c.objectName)).toEqual([
      `projects/TZ/${project}/${photo}_thumb.webp`,
      `projects/TZ/${project}/${photo}_full.webp`,
    ]);
    expect(server.row('project_photos', photo)).toMatchObject({
      upload_state: 'uploaded',
      version: 2,
    });
    expect(engine.status.value).toMatchObject({ pendingPhotos: 0, pendingOps: 0, state: 'idle' });
    expect(await store.photoBlob(photo, 'full')).toBeUndefined();
    expect(await store.photoBlob(photo, 'thumb')).toBeDefined();
  });

  it('enqueuePhotoUpload brings the next cycle forward', async () => {
    await started();
    await engine.enqueuePhotoUpload(uid());
    expect(Math.min(...clock.waiting())).toBe(1_500);
  });

  it('reports the pending counters with the heartbeat', async () => {
    prefs.wifi = true;
    net.type = 'cellular';
    server.rejectIf = (op) => (op.table === 'donors' ? null : 'out_of_scope');
    await started();
    await engine.enqueuePhotoUpload(uid());
    await engine.enqueuePhotoUpload(uid());
    await engine.syncNow();
    expect(rpcCalls('report_device_status').at(-1)!.args).toEqual({
      p_device_id: 'device-a',
      p_pending_ops: 0,
      p_pending_photos: 2,
      p_app_version: '3.0.0-test',
    });
  });
});

describe('sync engine — failures', () => {
  it('backs off exponentially with jitter and recovers', async () => {
    server.failNext('pull', new SyncError('server', 'HTTP 502', { status: 502 }), 2);
    await started();
    expect(engine.status.value).toMatchObject({
      state: 'error',
      lastError: 'sync.error_server',
      lastSyncAt: null,
    });
    expect(clock.waiting()).toEqual([3_750]); // 5 s base, equal jitter at 0.5

    await clock.advance(3_750);
    await engine.whenIdle();
    expect(engine.status.value.state).toBe('error');
    expect(clock.waiting()).toEqual([7_500]);

    await clock.advance(7_500);
    await engine.whenIdle();
    expect(engine.status.value).toMatchObject({ state: 'idle', lastError: null });
    expect(clock.now() - (engine.status.value.lastSyncAt as number)).toBeLessThan(1000);
    expect(clock.waiting()).toEqual([120_000]);
  });

  it('waits at least as long as the rate limiter asks', async () => {
    await store.mutate('donors', uid(), { name_ar: 'x' });
    server.failNext(
      'push',
      new SyncError('rate_limited', 'slow down', { status: 429, retryAfterMs: 45_000 }),
    );
    await started();
    expect(engine.status.value).toMatchObject({
      state: 'error',
      lastError: 'sync.error_rate_limited',
      pendingOps: 1,
    });
    expect(clock.waiting()[0]).toBeGreaterThanOrEqual(45_000);
  });

  it('reports a network failure with a translatable key; syncNow() skips the backoff', async () => {
    server.offline = true;
    await started();
    expect(engine.status.value).toMatchObject({
      state: 'error',
      lastError: 'sync.error_network',
      online: true,
    });
    server.offline = false;
    await engine.syncNow();
    expect(engine.status.value).toMatchObject({ state: 'idle', lastError: null });
  });

  it('surfaces a full device as an error without advancing the cursor', async () => {
    server.write('donors', uid(), { name_ar: 'x' });
    build();
    const quota = Object.assign(new Error('QuotaExceededError'), { name: 'QuotaExceededError' });
    const original = store.applyPage.bind(store);
    store.applyPage = async () => {
      throw quota;
    };
    engine.start();
    await engine.whenIdle();
    expect(engine.status.value).toMatchObject({
      state: 'error',
      lastError: 'sync.error_storage_full',
    });
    expect(await store.getMeta(META_PULL_STATE)).toBeUndefined();
    store.applyPage = original;
    await engine.syncNow();
    expect(await store.allRows('donors')).toHaveLength(1);
  });

  it('refreshes the token once on 401 and carries on', async () => {
    server.failNext(
      'pull',
      new SyncError('unauthenticated', 'sync_pull: JWT expired', { status: 401 }),
    );
    build();
    engine.start();
    for (let i = 0; i < 20 && engine.status.value.lastSyncAt === null; i++) {
      await engine.whenIdle();
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(engine.status.value).toMatchObject({ state: 'idle', lastError: null });
    expect(auth.problems).toEqual([]);
  });

  it('asks auth for a new sign-in when 401 persists, keeps the data and keeps trying', async () => {
    await store.mutate('donors', uid(), { name_ar: 'unsent' });
    server.failNext(
      'rpc',
      new SyncError('unauthenticated', 'register_device: not_authenticated', { status: 401 }),
      3,
    );
    build();
    engine.start();
    for (let i = 0; i < 20 && auth.problems.length === 0; i++) {
      await engine.whenIdle();
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(auth.problems).toEqual([{ reason: 'not_authenticated', wiped: false }]);
    expect(engine.status.value).toMatchObject({
      state: 'error',
      lastError: 'sync.error_auth',
      pendingOps: 1,
    });
    expect(await store.pendingOps()).toHaveLength(1);
    // still scheduled: syncing resumes by itself once a valid session exists
    expect(clock.waiting().length).toBe(1);
    await clock.advance(clock.waiting()[0]!);
    await engine.whenIdle();
    await clock.advance(clock.waiting()[0]!);
    await engine.whenIdle();
    expect(auth.problems).toHaveLength(1); // told once
    expect(engine.status.value).toMatchObject({ state: 'idle', pendingOps: 0 });
  });
});

describe('sync engine — revocation', () => {
  async function seedLocalData(): Promise<void> {
    await store.mutate('projects', uid(), { name_ar: 'unsent', type: 'mosque' });
    await store.putPhotoBlob('p', 'thumb', new Blob(['x']));
    await store.setMeta('anything', 1);
  }

  async function expectWiped(): Promise<void> {
    expect(await store.allRows('projects')).toHaveLength(0);
    expect(await store.allOps()).toHaveLength(0);
    expect(await store.photoBlob('p', 'thumb')).toBeUndefined();
    expect(await store.getMeta('anything')).toBeUndefined();
    expect(engine.status.value).toMatchObject({
      state: 'error',
      lastError: 'sync.error_revoked',
      pendingOps: 0,
      pendingPhotos: 0,
      lastSyncAt: null,
    });
    expect(clock.waiting()).toEqual([]); // stopped
    expect(net.listenerCount).toBe(0);
  }

  it('wipes and signs out when register_device says the device is revoked', async () => {
    await seedLocalData();
    server.deviceRevoked = true;
    await started();
    expect(auth.problems).toEqual([{ reason: 'device_revoked', wiped: true }]);
    expect(server.calls.push).toHaveLength(0); // nothing was sent from a revoked device
    await expectWiped();
  });

  it('wipes and signs out when the heartbeat answers session_ok = false', async () => {
    await started();
    await seedLocalData();
    server.sessionOk = false;
    server.rejectIf = () => 'out_of_scope';
    await engine.syncNow();
    expect(auth.problems).toEqual([{ reason: 'session_revoked', wiped: true }]);
    await expectWiped();
  });

  it('wipes and signs out on PT403 session_revoked from any call', async () => {
    await seedLocalData();
    server.failNext(
      'push',
      new SyncError('session_revoked', 'sync_push: session_revoked', {
        status: 403,
        code: 'PT403',
      }),
    );
    await started();
    expect(auth.problems).toEqual([{ reason: 'session_revoked', wiped: true }]);
    await expectWiped();
  });

  it('lets auth call back into the engine from the notification, and restarts after a new sign-in', async () => {
    server.deviceRevoked = true;
    auth.onProblem = async () => {
      await engine.resetLocalData('revoked');
      auth.user = null;
    };
    await started();
    expect(auth.problems).toHaveLength(1);

    server.deviceRevoked = false;
    auth.user = 'user-1';
    engine.sessionChanged();
    await engine.whenIdle();
    expect(engine.status.value).toMatchObject({ state: 'idle', lastError: null });
    expect(clock.waiting()).toEqual([120_000]);
  });
});

describe('sync engine — scope changes and reset', () => {
  it('survives a scope_epoch change with unsent work present', async () => {
    const kept = uid();
    const lost = uid();
    server.write('projects', kept, { name_ar: 'باقٍ', capacity: 1 });
    server.write('projects', lost, { name_ar: 'خارج النطاق' });
    await started();
    expect(await store.allRows('projects')).toHaveLength(2);

    // Roles change on the server while the user keeps working offline-style.
    server.epoch = 'epoch-2';
    server.visible = (_t, row) => row.id !== lost;
    const fresh = uid();
    await store.mutate('projects', kept, { capacity: 50 });
    await store.mutate('projects', fresh, { name_ar: 'جديد', type: 'school' });
    // …and one more edit lands while the pull is on the wire.
    let edited = false;
    server.onPull = async () => {
      if (edited) return;
      edited = true;
      await store.mutate('projects', kept, { builder: 'late edit' });
    };

    await engine.syncNow();
    expect(server.row('projects', kept)).toMatchObject({ capacity: 50 });
    expect(server.row('projects', fresh)).toBeDefined();
    expect(await store.getRow('projects', lost)).toBeUndefined();
    expect(await store.getRow('projects', kept)).toMatchObject({
      capacity: 50,
      builder: 'late edit',
      _dirty: 1,
    });
    expect(await store.getRow('projects', fresh)).toMatchObject({ name_ar: 'جديد', version: 1 });
    expect(await store.getMeta<PullState>(META_PULL_STATE)).toMatchObject({
      epoch: 'epoch-2',
      complete: true,
    });
    expect((await store.pendingOps()).map((o) => o.fields)).toEqual([{ builder: 'late edit' }]);

    server.onPull = null;
    await engine.syncNow();
    expect(server.row('projects', kept)).toMatchObject({ capacity: 50, builder: 'late edit' });
    expect(engine.status.value).toMatchObject({ pendingOps: 0, failedOps: 0, state: 'idle' });
    const local = await store.getRow('projects', kept);
    expect(local).not.toHaveProperty('_dirty');
  });

  it("resetLocalData() forgets the server's data and the cursor but keeps unsent work, then pulls again", async () => {
    server.write('projects', uid(), { name_ar: 'a' });
    await started();
    net.online = false; // keep the engine from syncing again right away
    await store.mutate('projects', uid(), { name_ar: 'unsent', type: 'mosque' });

    await engine.resetLocalData('sign_out');
    expect((await store.allRows('projects')).map((r) => r.name_ar)).toEqual(['unsent']);
    expect(await store.getMeta(META_PULL_STATE)).toBeUndefined();
    expect(await store.getMeta(META_LAST_SYNC)).toBeUndefined();
    expect(await store.pendingOps()).toHaveLength(1);
    expect(engine.status.value).toMatchObject({ lastSyncAt: null, pendingOps: 1 });

    net.setOnline(true);
    await engine.whenIdle();
    expect(server.calls.pull.at(-1)!.cursor).toBeNull();
    expect(await store.allRows('projects')).toHaveLength(2);
  });

  it.each(['revoked', 'user_changed'] as const)(
    "resetLocalData('%s') removes everything",
    async (reason) => {
      await started();
      net.online = false;
      await store.mutate('projects', uid(), { name_ar: 'unsent', type: 'mosque' });
      await store.putPhotoBlob('p', 'full', new Blob(['x']));
      await engine.resetLocalData(reason);
      expect(await store.allOps()).toHaveLength(0);
      expect(await store.allRows('projects')).toHaveLength(0);
      expect(await store.photoBlob('p', 'full')).toBeUndefined();
      expect(engine.status.value).toMatchObject({ pendingOps: 0, lastSyncAt: null });
    },
  );

  it("never pushes the previous user's queue under a new user", async () => {
    await started();
    net.online = false;
    await store.mutate('projects', uid(), { name_ar: 'work of user 1', type: 'mosque' });
    expect(await store.getMeta(META_USER)).toBe('user-1');

    auth.user = 'user-2';
    net.setOnline(true);
    await engine.whenIdle();
    expect(server.calls.push).toHaveLength(0);
    expect(server.liveRows('projects')).toHaveLength(0);
    expect(await store.allOps()).toHaveLength(0);
    expect(await store.getMeta(META_USER)).toBe('user-2');
    expect(rpcCalls('register_device')).toHaveLength(2);
  });

  it('stop() aborts the cycle, removes the listeners and cancels the timer', async () => {
    build();
    server.onPull = () => new Promise((r) => setTimeout(r, 30));
    engine.start();
    await new Promise((r) => setTimeout(r, 10));
    engine.stop();
    await engine.whenIdle();
    expect(net.listenerCount).toBe(0);
    expect(clock.waiting()).toEqual([]);
    expect(engine.status.value.state).toBe('idle');
    const pulls = server.calls.pull.length;
    net.setOnline(true);
    net.becomeVisible();
    await clock.advance(300_000);
    expect(server.calls.pull.length).toBe(pulls);
  });
});

/**
 * Regression: the device clock may jump (NTP, the user fixing the time, a wrong clock). A
 * backward step must never stall a cycle (pacing between requests waits at most the pacing
 * interval itself) and a deadline that lies further in the future than any backoff could
 * produce is not trusted. The future-clock photo retry is covered in photos.resilience.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mutate, newRow, setLocalSession, wipeAllLocalData } from '../db';
import { elapsedSince, isDue, paceWait } from './clock';
import { createDbAdapter } from './dbAdapter';
import { type SyncEngine, createSyncEngine } from './engine';
import { META_LEASE, leaseLock } from './locks';
import { pullChanges } from './pull';
import { pushOutbox } from './push';
import { FakeAuth, FakeLock, FakeNetwork, FakePrefs, FakeUploader, fakeApp } from './testing/fakes';
import { FakeServer } from './testing/fakeServer';
import { LocalStore } from './testing/localStore';
import { TestClock } from './testing/testClock';

const USER = '11111111-1111-4111-8111-111111111111';
const COUNTRY = '22222222-2222-4222-8222-222222222222';
const BRANCH = '33333333-3333-4333-8333-333333333333';
const HOUR = 3600_000;

/** Resolves with 'finished' or, if the promise hangs for `ms` of real time, 'still running'. */
function within<T>(p: Promise<T>, ms: number): Promise<'finished' | 'still running'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'still running'>((resolve) => {
    timer = setTimeout(() => resolve('still running'), ms);
  });
  return Promise.race([p.then(() => 'finished' as const), timeout]).finally(() =>
    clearTimeout(timer),
  );
}

let n = 0;
const uid = (): string => {
  n++;
  return `00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
};

describe('backward clock steps', () => {
  let server: FakeServer;
  let clock: TestClock;
  let store: LocalStore;

  beforeEach(() => {
    server = new FakeServer();
    // Only short timers fire by themselves: a stalled wait would hang until advance().
    clock = new TestClock(1000);
    store = new LocalStore(`clock-${uid()}`);
  });

  afterEach(async () => {
    await store.destroy();
  });

  it('pushOutbox: a backward step between two batches does not hold the next batch back', async () => {
    for (let i = 0; i < 60; i++) await store.mutate('donors', uid(), { name_ar: `متبرع ${i}` });
    let calls = 0;
    server.onPush = async () => {
      if (++calls === 1) clock.time -= HOUR;
    };
    const run = pushOutbox(
      {
        db: store,
        transport: server.transportFor('device-a'),
        auth: { deviceId: () => 'device-a' },
        clock,
      },
      { maxAttempts: 1 },
    );
    expect(await within(run, 3000)).toBe('finished');
    expect(server.calls.push.map((c) => c.ops.length)).toEqual([50, 10]);
    // the pacing still holds: never more than the pacing interval between two calls
    expect(Math.max(...clock.delays)).toBeLessThanOrEqual(600);
  });

  it('pullChanges: a backward step between two pages does not hold the next page back', async () => {
    for (let i = 0; i < 30; i++)
      server.write('projects', uid(), { name_ar: `مشروع ${i}`, type: 'mosque' });
    let calls = 0;
    server.onPull = async () => {
      if (++calls === 1) clock.time -= HOUR;
    };
    const run = pullChanges(
      { db: store, transport: server.transportFor('device-a'), clock },
      { pageSize: 10, maxAttempts: 1 },
    );
    expect(await within(run, 3000)).toBe('finished');
    expect(await store.allRows('projects')).toHaveLength(30);
  });
});

describe('future deadlines', () => {
  let clock: TestClock;
  let store: LocalStore;

  beforeEach(() => {
    clock = new TestClock(1000);
    store = new LocalStore(`lease-${uid()}`);
  });

  afterEach(async () => {
    await store.destroy();
  });

  it('leaseLock: a lease written under a wrong (future) clock by a dead tab does not lock the others out', async () => {
    await store.setMeta(META_LEASE, { owner: 'tab-a', expiresAt: clock.now() + 365 * 24 * HOUR });
    const b = leaseLock(store, clock, { ownerId: 'tab-b', ttlMs: 30_000 });
    expect(await b.run(async () => 'ran', { wait: false })).toEqual({
      acquired: true,
      value: 'ran',
    });
  });

  it('leaseLock: a live lease of another tab is still respected', async () => {
    await store.setMeta(META_LEASE, { owner: 'tab-a', expiresAt: clock.now() + 20_000 });
    const b = leaseLock(store, clock, { ownerId: 'tab-b', ttlMs: 30_000 });
    expect(await b.run(async () => 'ran', { wait: false })).toEqual({ acquired: false });
  });

  it('isDue / paceWait / elapsedSince never trust a jump of the clock', () => {
    const now = clock.now();
    expect(isDue(clock, now + 10_000, 60_000)).toBe(false);
    expect(isDue(clock, now - 1, 60_000)).toBe(true);
    expect(isDue(clock, now + 365 * 24 * HOUR, 60_000)).toBe(true);
    expect(paceWait(clock, now - 100, 600)).toBe(500);
    expect(paceWait(clock, now + HOUR, 600)).toBe(600);
    expect(elapsedSince(clock, now - 5_000)).toBe(5_000);
    expect(elapsedSince(clock, now + HOUR)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('engine', () => {
  let server: FakeServer;
  let clock: TestClock;
  let engine: SyncEngine;

  beforeEach(async () => {
    await wipeAllLocalData();
    await setLocalSession({ userId: USER, canSeeRestricted: false });
    server = new FakeServer();
    server.write('countries', COUNTRY, {
      iso2: 'TZ',
      name_ar: 'تنزانيا',
      name_en: 'Tanzania',
      active: true,
    });
    const auth = new FakeAuth();
    auth.user = USER;
    clock = new TestClock(1000);
    engine = createSyncEngine(
      {
        db: createDbAdapter({ userId: () => auth.user }),
        transport: server.transportFor(auth.device),
        auth,
        net: new FakeNetwork(),
        prefs: new FakePrefs(),
        app: fakeApp,
        lock: new FakeLock(),
        uploader: new FakeUploader(),
        clock,
      },
      { push: { maxAttempts: 1 }, pull: { maxAttempts: 1 } },
    );
  });

  afterEach(async () => {
    engine.stop();
    await engine.whenIdle();
    await wipeAllLocalData();
  });

  it('a backward clock step between two push batches does not stall the cycle', async () => {
    for (let i = 0; i < 60; i++) {
      const row = newRow('projects', {
        name_ar: 'م',
        type: 'mosque',
        country_id: COUNTRY,
        branch_id: BRANCH,
        lon: 39.7,
        lat: -5,
      });
      await mutate('projects', row.id, row, { insert: true });
    }
    let calls = 0;
    server.onPush = async () => {
      calls++;
      if (calls === 1) clock.time -= HOUR; // NTP / the user corrects the phone clock by one hour
    };
    expect(await within(engine.syncNow(), 3000)).toBe('finished');
    expect(calls).toBe(2);
    expect(server.liveRows('projects')).toHaveLength(60);
  }, 10_000);
});

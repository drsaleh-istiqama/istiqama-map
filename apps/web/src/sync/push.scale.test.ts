/**
 * Regression at scale, through the real local database: a queue of several batches is pushed
 * exactly once and drains completely. The default size keeps the unit suite fast (row
 * writes in fake-indexeddb get slower as the stores grow); `U2N=10000` runs the full size.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, mutate, newRow, setLocalSession, wipeAllLocalData } from '../db';
import { createDbAdapter } from './dbAdapter';
import { type SyncEngine, createSyncEngine } from './engine';
import { FakeAuth, FakeLock, FakeNetwork, FakePrefs, FakeUploader, fakeApp } from './testing/fakes';
import { FakeServer } from './testing/fakeServer';
import { TestClock } from './testing/testClock';

const USER = '11111111-1111-4111-8111-111111111111';
const COUNTRY = '22222222-2222-4222-8222-222222222222';
const BRANCH = '33333333-3333-4333-8333-333333333333';
const MAX_CHUNK = 500;

let server: FakeServer;
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
      clock: new TestClock(1000),
    },
    { push: { maxAttempts: 1 }, pull: { maxAttempts: 1 } },
  );
});

afterEach(async () => {
  engine.stop();
  await engine.whenIdle();
  await wipeAllLocalData();
});

describe('a large outbox', () => {
  it('is pushed exactly once and drains completely', async () => {
    const total = Math.max(1, Number(process.env.U2N ?? 260)); // 6 batches of ≤ 50
    // seed through mutate() in chunks inside one transaction each (faster than single calls)
    for (let done = 0; done < total; done += MAX_CHUNK) {
      await db.transaction('rw', db.tables, async () => {
        for (let i = 0; i < Math.min(MAX_CHUNK, total - done); i++) {
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
      });
    }
    expect(await db.outbox.count()).toBe(total);

    for (let i = 0; i < 6 && (await db.outbox.count()) > 0; i++) await engine.syncNow();
    const sent = server.calls.push.flatMap((c) => c.ops.map((o) => o.op_id));
    expect(server.liveRows('projects')).toHaveLength(total);
    expect(sent).toHaveLength(total);
    expect(new Set(sent).size).toBe(total);
    expect(await db.outbox.count()).toBe(0);
    expect(await db.failed_ops.count()).toBe(0);
  }, 120_000);
});

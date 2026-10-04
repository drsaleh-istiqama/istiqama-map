/**
 * SCRATCH (u2rev_data_loss) — adversarial tests; delete after the review.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, mutate, newRow, setLocalSession, wipeAllLocalData } from '../../src/db';
import { createDbAdapter } from '../../src/sync/dbAdapter';
import { type SyncEngine, createSyncEngine } from '../../src/sync/engine';
import type { DbPort } from '../../src/sync/ports';
import { FakeAuth, FakeLock, FakeNetwork, FakePrefs, FakeUploader, fakeApp } from '../../src/sync/testing/fakes';
import { FakeServer } from '../../src/sync/testing/fakeServer';
import { TestClock } from '../../src/sync/testing/testClock';

const USER = '11111111-1111-4111-8111-111111111111';
const COUNTRY = '22222222-2222-4222-8222-222222222222';
const BRANCH = '33333333-3333-4333-8333-333333333333';

let server: FakeServer;
let auth: FakeAuth;
let net: FakeNetwork;
let port: DbPort;
let engine: SyncEngine;
let clock: TestClock;

beforeEach(async () => {
  await wipeAllLocalData();
  await setLocalSession({ userId: USER, canSeeRestricted: false });
  server = new FakeServer();
  server.write('countries', COUNTRY, { iso2: 'TZ', name_ar: 'تنزانيا', name_en: 'Tanzania', active: true });
  auth = new FakeAuth();
  auth.user = USER;
  net = new FakeNetwork();
  clock = new TestClock(1000);
  port = createDbAdapter({ userId: () => auth.user });
  engine = createSyncEngine(
    {
      db: port,
      transport: server.transportFor(auth.device),
      auth,
      net,
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

describe('u2rev scale / clock', () => {
  it('a backward clock step between two push batches does not stall the cycle', async () => {
    for (let i = 0; i < 60; i++) {
      const row = newRow('projects', { name_ar: 'م', type: 'mosque', country_id: COUNTRY, branch_id: BRANCH, lon: 39.7, lat: -5 });
      await mutate('projects', row.id, row, { insert: true });
    }
    let calls = 0;
    server.onPush = async () => {
      calls++;
      if (calls === 1) clock.time -= 3600_000; // NTP / the user corrects the phone clock by one hour
    };
    const done = engine.syncNow().then(() => 'finished');
    const timeout = new Promise<string>((r) => setTimeout(() => r('still running'), 3000));
    const outcome = await Promise.race([done, timeout]);
    // eslint-disable-next-line no-console
    console.info('outcome', outcome, '| push calls', calls, '| waiting timers (ms)', JSON.stringify(clock.waiting()),
      '| server rows', server.liveRows('projects').length);
    expect(outcome).toBe('finished');
  }, 10_000);

  it('10,000 queued operations are pushed exactly once', async () => {
    const t0 = Date.now();
    const N = Number(process.env.U2N ?? 1000);
    // seed through mutate() in chunks inside one transaction per chunk (faster than 10k single calls)
    for (let c = 0; c < N / 500; c++) {
      await db.transaction('rw', db.tables, async () => {
        for (let i = 0; i < 500; i++) {
          const row = newRow('projects', { name_ar: 'م', type: 'mosque', country_id: COUNTRY, branch_id: BRANCH, lon: 39.7, lat: -5 });
          await mutate('projects', row.id, row, { insert: true });
        }
      });
    }
    const seeded = Date.now() - t0;
    expect(await db.outbox.count()).toBe(N);
    // measure time spent inside the fake server vs in the client
    let serverMs = 0;
    let pullMs = 0;
    const inner = server.transportFor(auth.device);
    const timed = {
      push: async (...a: Parameters<typeof inner.push>) => { const s = Date.now(); try { return await inner.push(...a); } finally { serverMs += Date.now() - s; } },
      pull: async (...a: Parameters<typeof inner.pull>) => { const s = Date.now(); try { return await inner.pull(...a); } finally { pullMs += Date.now() - s; } },
      rpc: inner.rpc.bind(inner),
    };
    engine.stop();
    const prof: Record<string, number> = {};
    for (const k of ['ackOp', 'markInflight', 'pendingOps', 'applyPage', 'requeueInflight', 'counts', 'listMeta'] as const) {
      const orig = (port as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[k]!;
      (port as unknown as Record<string, unknown>)[k] = async (...a: unknown[]) => {
        const s = Date.now();
        try { return await orig(...a); } finally { prof[k] = (prof[k] ?? 0) + Date.now() - s; }
      };
    }
    (globalThis as Record<string, unknown>).__prof = prof;
    engine = createSyncEngine(
      { db: port, transport: timed as typeof inner, auth, net, prefs: new FakePrefs(), app: fakeApp, lock: new FakeLock(), uploader: new FakeUploader(), clock },
      { push: { maxAttempts: 1 }, pull: { maxAttempts: 1 } },
    );
    const t1 = Date.now();
    for (let i = 0; i < 6 && (await db.outbox.count()) > 0; i++) await engine.syncNow();
    const pushed = Date.now() - t1;
    const ids = server.calls.push.flatMap((c) => c.ops.map((o) => o.op_id));
    // eslint-disable-next-line no-console
    console.info('seed ms', seeded, 'sync ms', pushed, 'push calls', server.calls.push.length,
      'ops sent', ids.length, 'unique', new Set(ids).size, 'server rows', server.liveRows('projects').length,
      'outbox', await db.outbox.count(), 'failed', await db.failed_ops.count(), 'status', JSON.stringify(engine.status.value));
    const { appendFileSync } = await import('node:fs');
    appendFileSync('C:/istiqama-map/.local/scratch-u2rev_data_loss/scale.log',
      `N=${N} seed_ms=${seeded} sync_ms=${pushed} in_fake_server_push_ms=${serverMs} in_fake_server_pull_ms=${pullMs} prof=${JSON.stringify((globalThis as Record<string, unknown>).__prof)} push_calls=${server.calls.push.length} sent=${ids.length} unique=${new Set(ids).size} server=${server.liveRows('projects').length} outbox=${await db.outbox.count()}\n`);
    expect(server.liveRows('projects')).toHaveLength(N);
    expect(new Set(ids).size).toBe(ids.length);
    expect(await db.outbox.count()).toBe(0);
  }, 600_000);
});

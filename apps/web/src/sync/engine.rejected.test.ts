/**
 * Regression, end to end through the engine: an older edit that the server rejects must not
 * override a newer value of the same field typed while it was on the wire — neither after the
 * cycle nor after the user fixed the rejected field (sync.md §4.1, §7.3).
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
const BAD = '99999999-9999-4999-8999-999999999999';

let server: FakeServer;
let engine: SyncEngine;

beforeEach(async () => {
  await wipeAllLocalData();
  await setLocalSession({ userId: USER, canSeeRestricted: false });
  server = new FakeServer();
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

describe('a rejected older edit vs a newer edit of the same field', () => {
  it('the newer value wins on the server and on the device', async () => {
    const row = newRow('projects', {
      name_ar: 'مسجد',
      type: 'mosque',
      country_id: COUNTRY,
      branch_id: BRANCH,
      lon: 39.75,
      lat: -5.05,
    });
    await mutate('projects', row.id, row, { insert: true });
    const id = row.id;
    await engine.syncNow();

    server.rejectIf = (op) => (op.fields?.locality_id === BAD ? 'locality_country_mismatch' : null);
    await mutate('projects', id, { builder: 'A', locality_id: BAD });
    let typed = false;
    server.onPush = async () => {
      if (typed) return;
      typed = true;
      await mutate('projects', id, { builder: 'B' }); // typed while edit 1 is on the wire
    };
    await engine.syncNow();
    expect(server.row('projects', id)?.builder).toBe('B');
    expect((await db.projects.get(id))?.builder).toBe('B');
    expect(await db.failed_ops.count()).toBe(1);

    // the user fixes the locality from the needs-attention list
    await mutate('projects', id, { locality_id: null });
    await engine.syncNow();
    expect(server.row('projects', id)?.builder).toBe('B');
    expect((await db.projects.get(id))?.builder).toBe('B');
    expect(await db.failed_ops.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });
});

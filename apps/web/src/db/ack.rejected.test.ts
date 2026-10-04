/**
 * Regression: a rejected operation must never resurrect a stale value over a newer edit of
 * the same row (docs/contracts/sync.md §4.1, §7.3, §7.8). Once a later operation of the row
 * changes a field, the rejected operation no longer owns that field: retry, discard, a later
 * fix of the rejected field and the pull all keep the user's newest value.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ackOp, discardFailedOp, markInflight, pendingOps, retryFailedOps } from './ack';
import { applyServerRows } from './apply';
import { db } from './dexie';
import { freshDb, outbox, serverProject, stored } from './testing/factory';
import { mutate } from './write';

const COUNTRY = '22222222-2222-4222-8222-222222222222';
const BRANCH = '33333333-3333-4333-8333-333333333333';
const BAD_LOCALITY = '99999999-9999-4999-8999-999999999999';

beforeEach(async () => {
  await freshDb();
});

describe('a rejected op vs a later edit of the same field', () => {
  it("the user's newest value survives when an older op of the row is rejected", async () => {
    const p = serverProject({
      version: 3,
      builder: 'X',
      country_id: COUNTRY,
      branch_id: BRANCH,
      lon: 39.7,
      lat: -5.1,
    });
    await applyServerRows('projects', [p]);

    // edit 1 (builder A + a locality of another country) goes out ...
    await mutate('projects', p.id, { builder: 'A', locality_id: BAD_LOCALITY });
    await markInflight(await pendingOps());
    // ... while it is on the wire the user corrects the builder: edit 2 (builder B)
    await mutate('projects', p.id, { builder: 'B' });
    const [op1, op2] = await outbox();
    // the server refuses edit 1 (locality of another country); edit 2 goes through
    await ackOp({
      op_id: op1!.op_id,
      status: 'rejected',
      error: { code: 'locality_country_mismatch' },
    });
    await markInflight([op2!.seq!]);
    await ackOp({ op_id: op2!.op_id, status: 'applied', version: 4 });
    expect((await stored('projects', p.id))?.builder).toBe('B');

    // the pull of the same cycle brings the server row (builder B, version 4)
    await applyServerRows('projects', [{ ...p, version: 4, builder: 'B' }]);
    const shown = (await stored('projects', p.id))?.builder;

    // "retry" in the needs-attention list re-sends edit 1
    await retryFailedOps();
    const resent = (await outbox()).map((o) => o.fields);
    expect(shown).toBe('B');
    expect(resent.every((f) => !('builder' in f) || f.builder === 'B')).toBe(true);
  });

  it('discarding the rejected older edit keeps the newer value the server already has', async () => {
    const p = serverProject({
      version: 3,
      builder: 'X',
      country_id: COUNTRY,
      branch_id: BRANCH,
      lon: 39.7,
      lat: -5.1,
    });
    await applyServerRows('projects', [p]);
    await mutate('projects', p.id, { builder: 'A', locality_id: BAD_LOCALITY });
    await markInflight(await pendingOps());
    await mutate('projects', p.id, { builder: 'B' });
    const [op1, op2] = await outbox();
    await ackOp({
      op_id: op1!.op_id,
      status: 'rejected',
      error: { code: 'locality_country_mismatch' },
    });
    await markInflight([op2!.seq!]);
    await ackOp({ op_id: op2!.op_id, status: 'applied', version: 4 }); // server: builder B, v4
    const failed = await db.failed_ops.toArray();
    await discardFailedOp(failed[0]!.id!);
    const row = await stored('projects', p.id);
    expect(row?.builder).toBe('B');
  });

  it('fixing the rejected field does not resend the stale value of another field', async () => {
    const p = serverProject({
      version: 3,
      builder: 'X',
      country_id: COUNTRY,
      branch_id: BRANCH,
      lon: 39.7,
      lat: -5.1,
    });
    await applyServerRows('projects', [p]);
    await mutate('projects', p.id, { builder: 'A', locality_id: BAD_LOCALITY });
    await markInflight(await pendingOps());
    await mutate('projects', p.id, { builder: 'B' });
    const [op1] = await outbox();
    await ackOp({
      op_id: op1!.op_id,
      status: 'rejected',
      error: { code: 'locality_country_mismatch' },
    });
    // before edit 2 is pushed (e.g. connection lost) the user fixes the locality
    await mutate('projects', p.id, { locality_id: null });
    const ops = await outbox();
    // what the server ends with: the last op that carries builder wins
    const lastBuilder = ops.filter((o) => 'builder' in o.fields).at(-1)?.fields.builder;
    expect((await stored('projects', p.id))?.builder).toBe('B');
    expect(lastBuilder).toBe('B');
    expect(await db.failed_ops.count()).toBe(0);
  });
});

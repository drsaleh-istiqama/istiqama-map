/**
 * `DbPort` on top of the real local database. `src/db` already exposes the engine-facing
 * operations as `syncPort` (outbox bookkeeping, acknowledgement rules, pull apply, meta,
 * photo blobs); the only thing added here is the user filter of the outbox.
 */
import { pendingOps, syncPort } from '../db';
import type { DbPort, OutboxOp } from './ports';

export interface DbAdapterOptions {
  /** Signed-in user: operations queued by somebody else on this device are never pushed. */
  userId(): string | null;
}

export function createDbAdapter(options: DbAdapterOptions): DbPort {
  return {
    ...syncPort,
    async pendingOps(): Promise<OutboxOp[]> {
      const ops = await pendingOps(undefined, options.userId());
      return ops.map((op) => ({
        seq: op.seq as number,
        op_id: op.op_id,
        table: op.table,
        id: op.row_id,
        kind: op.kind,
        base_version: op.base_version,
        fields: op.kind === 'delete' ? {} : op.fields,
        client_ts: op.created_at,
        attempts: op.attempts,
      }));
    },
  };
}

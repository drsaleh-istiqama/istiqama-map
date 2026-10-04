/**
 * The v2 entry time of a migrated project (`createdAt`) as its `created_at`.
 *
 * `mutate()` stamps every insert with "now" (the offline entry time of a NEW row) and has no
 * option for an older time, while `sync_push` stores the `created_at` an insert carries
 * (sync.md §4.2 rule 4: no lower bound). Until src/db offers it (requested from the db
 * owner: `mutate(table, id, row, { insert: true, createdAt })`), this helper replaces the
 * value in the queued insert — only while that insert is still untouched on the device
 * (`pending`, never handed to the transport) — and in the local row. It must run inside the
 * transaction that created the row.
 */
import { db, opsForRow } from '../db';

export async function stampInsertCreatedAt(id: string, createdAt: string): Promise<boolean> {
  const ops = await opsForRow('projects', id);
  const insert = ops.find(
    (o) =>
      o.kind === 'upsert' &&
      o.base_version === 0 &&
      o.state === 'pending' &&
      o.attempts === 0 &&
      'created_at' in o.fields,
  );
  if (!insert || insert.seq === undefined) return false;
  await db.outbox.update(insert.seq, { fields: { ...insert.fields, created_at: createdAt } });
  await db.projects.update(id, { created_at: createdAt });
  return true;
}

/**
 * Test helpers for the local database: deterministic ids, rows as the server would send
 * them, and a clean store per test. Not imported by application code.
 */
import { wipeAllLocalData } from '../apply';
import { db } from '../dexie';
import { setLocalSession } from '../meta';
import type { Row, TableName } from '../types';
import { newRow } from '../write';

/** Seeded staging user (any UUID works; only equality matters locally). */
export const USER_A = '0a000000-0000-4000-8000-00000000000a';
export const USER_B = '0b000000-0000-4000-8000-00000000000b';

let counter = 0;

/** Deterministic, increasing UUID-shaped id; `kind` keeps ids of different tables apart. */
export function tid(kind = 0): string {
  counter++;
  return `00000000-${kind.toString(16).padStart(4, '0')}-7000-8000-${counter.toString(16).padStart(12, '0')}`;
}

/** Empties every store, forgets the caches and signs `userId` in locally. */
export async function freshDb(
  session: { userId?: string | null; canSeeRestricted?: boolean } = {},
): Promise<void> {
  if (!db.isOpen()) await db.open();
  await wipeAllLocalData();
  await setLocalSession({
    userId: session.userId === undefined ? USER_A : session.userId,
    canSeeRestricted: session.canSeeRestricted ?? false,
  });
}

/** A complete row as `sync_pull` delivers it (version >= 1, no local fields). */
export function serverRow<T extends TableName>(table: T, values: Partial<Row<T>> = {}): Row<T> {
  const base = newRow(table, values);
  const row = { ...base, created_by: USER_B, updated_by: USER_B } as Record<string, unknown>;
  for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
    if (v !== undefined) row[k] = v;
  }
  if (typeof row.version !== 'number' || row.version < 1) row.version = 1;
  return row as unknown as Row<T>;
}

export function serverProject(values: Partial<Row<'projects'>> = {}): Row<'projects'> {
  return serverRow('projects', {
    id: tid(0x80),
    name_ar: 'مسجد',
    type: 'mosque',
    status: 'active',
    record_state: 'approved',
    ...values,
  });
}

/** The outbox, oldest first. */
export function outbox() {
  return db.outbox.orderBy('seq').toArray();
}

/** The stored copy of a row with every local field (`_dirty`, `_tokens`, …). */
export async function stored<T extends TableName>(
  table: T,
  id: string,
): Promise<(Row<T> & Record<string, unknown>) | undefined> {
  return (await db.table(table).get(id)) as (Row<T> & Record<string, unknown>) | undefined;
}

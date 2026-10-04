/**
 * Record-state actions (sync.md §4.3) and conflict resolution (sync.md §6). Every write goes
 * through `mutate()` (local first, queued for the server); a sync cycle is started right away
 * when the device is online so the decision reaches the server without waiting two minutes.
 */
import { clearConflictFlag, mutate, softDelete, type TableName } from '../db';
import { syncNow, transport } from '../sync';
import { openConflictsOfRow, projectsOfLocality } from './queries';
import { isOnline } from './search';

/** Starts a sync cycle when online; never throws (the engine retries by itself). */
export function kickSync(): void {
  if (!isOnline()) return;
  void syncNow().catch(() => undefined);
}

export async function approveProject(id: string): Promise<void> {
  await mutate('projects', id, { record_state: 'approved', review_note: null });
  kickSync();
}

/** Return to the collector; the note says what to fix (required). */
export async function returnProject(id: string, note: string): Promise<void> {
  const text = note.trim();
  if (!text) throw new Error('review_note_required');
  await mutate('projects', id, { record_state: 'returned', review_note: text });
  kickSync();
}

export async function submitProject(id: string): Promise<void> {
  await mutate('projects', id, { record_state: 'submitted' });
  kickSync();
}

export async function deleteProject(id: string): Promise<void> {
  await softDelete('projects', id);
  kickSync();
}

export type ConflictChoice = 'server' | 'client';

export interface ResolveConflictResult {
  id: string;
  state: 'resolved_server' | 'resolved_client';
  table: string;
  row_id: string;
  field: string;
  version: number | null;
  server_time: string;
}

/**
 * Keeps the server value or writes the client value (`resolve_conflict` RPC), then syncs so
 * the decision — and the new row version — reach this device. Online only.
 */
export async function resolveConflict(
  conflict: { id: string; table_name: string; row_id: string },
  choice: ConflictChoice,
): Promise<ResolveConflictResult> {
  const result = await transport.rpc<ResolveConflictResult>('resolve_conflict', {
    p_conflict_id: conflict.id,
    p_choice: choice,
  });
  // The flag on the row (set on the device that pushed) goes once nothing is open any more.
  try {
    if ((await openConflictsOfRow(conflict.table_name, conflict.row_id)) <= 1)
      await clearConflictFlag(conflict.table_name as TableName, conflict.row_id);
  } catch {
    // a missing local row is fine
  }
  await syncNow().catch(() => undefined);
  return result;
}

/** Approves a proposed locality (reviewers; the server stamps `approved_by` / `approved_at`). */
export async function approveLocality(id: string): Promise<void> {
  await mutate('localities', id, { status: 'approved' });
  kickSync();
}

export async function renameLocality(
  id: string,
  names: { name_ar: string | null; name_latin: string | null },
): Promise<void> {
  await mutate('localities', id, names);
  kickSync();
}

/**
 * Merges a proposed locality into an existing one: every project on the device that points
 * to it is moved to the target, then the proposed row is deleted. Returns how many projects
 * were moved.
 */
export async function mergeLocality(sourceId: string, targetId: string): Promise<number> {
  if (sourceId === targetId) return 0;
  const ids = await projectsOfLocality(sourceId);
  for (const id of ids) await mutate('projects', id, { locality_id: targetId });
  await softDelete('localities', sourceId);
  kickSync();
  return ids.length;
}

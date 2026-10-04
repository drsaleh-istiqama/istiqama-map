/** The permanent sync indicator's state (web.md §3.5). */
import { type Signal, signal } from '@preact/signals';
import type { SyncStatus } from './types';

export const INITIAL_STATUS: SyncStatus = {
  online: true,
  state: 'idle',
  pendingOps: 0,
  pendingPhotos: 0,
  failedOps: 0,
  lastSyncAt: null,
  lastError: null,
};

export function createStatusSignal(): Signal<SyncStatus> {
  return signal<SyncStatus>({ ...INITIAL_STATUS });
}

/** Assign only when something changed, so subscribers do not re-render for nothing. */
export function patchStatus(status: Signal<SyncStatus>, patch: Partial<SyncStatus>): void {
  const current = status.peek();
  let changed = false;
  for (const key of Object.keys(patch) as Array<keyof SyncStatus>) {
    if (current[key] !== patch[key]) {
      changed = true;
      break;
    }
  }
  if (changed) status.value = { ...current, ...patch };
}

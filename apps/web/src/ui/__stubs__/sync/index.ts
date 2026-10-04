// TEMPORARY STUB of src/sync (docs/contracts/web.md §3.5) — see ../README.md.
import { signal, type Signal } from '@preact/signals';

export interface SyncStatus {
  online: boolean;
  state: 'idle' | 'pushing' | 'pulling' | 'error';
  pendingOps: number;
  pendingPhotos: number;
  failedOps: number;
  lastSyncAt: number | null;
  lastError: string | null;
}

export const syncStatus: Signal<SyncStatus> = signal({
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  state: 'idle',
  pendingOps: 0,
  pendingPhotos: 0,
  failedOps: 0,
  lastSyncAt: null,
  lastError: null,
});

const setOnline = (online: boolean) => (): void => {
  syncStatus.value = { ...syncStatus.value, online };
};
const goOnline = setOnline(true);
const goOffline = setOnline(false);

export function startSync(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('online', goOnline);
  window.addEventListener('offline', goOffline);
}

export function stopSync(): void {
  if (typeof window === 'undefined') return;
  window.removeEventListener('online', goOnline);
  window.removeEventListener('offline', goOffline);
}

export async function syncNow(): Promise<void> {
  syncStatus.value = {
    ...syncStatus.value,
    state: 'idle',
    lastSyncAt: Date.now(),
    lastError: null,
  };
}

export async function resetLocalData(): Promise<void> {}
export async function enqueuePhotoUpload(_photoId: string): Promise<void> {}

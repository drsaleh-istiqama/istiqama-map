/**
 * Public API of the sync module (docs/contracts/web.md §3.5). This is the only file that
 * touches `src/db`, `src/auth` and the browser globals; everything else in this folder
 * works through the interfaces of `ports.ts`.
 */
import { type Signal, effect } from '@preact/signals';
import { accessToken, deviceId, handleSessionProblem, me, session, supabase } from '../auth';
import { env } from '../env';
import { getPref } from '../lib/prefs';
import { APP_VERSION } from '../version';
import { systemClock } from './clock';
import { createDbAdapter } from './dbAdapter';
import { defaultDeviceLabel } from './device';
import { type ResetReason, type SyncEngine, createSyncEngine } from './engine';
import { createSyncLock } from './locks';
import { WIFI_ONLY_PREF_KEY, createBrowserNetwork } from './network';
import type { PhotoUploadEntry } from './photoQueue';
import type { AuthPort } from './ports';
import { createStatusSignal } from './status';
import { requestPersistentStorage } from './storage';
import { createTransport, supabaseRpcClient } from './transport';
import { createTusUploader } from './tusUploader';
import type { SyncStatus, Transport } from './types';

export type {
  PullChange,
  PullPage,
  PushErrorInfo,
  PushOp,
  PushResult,
  SyncState,
  SyncStatus,
  Transport,
  TransportCallOptions,
} from './types';
export type { ResetReason } from './engine';
export type { SessionProblem } from './ports';
export type { PhotoUploadEntry } from './photoQueue';
export { SyncError, type SyncErrorKind, errorKey, isSyncError, toSyncError } from './errors';
export { WIFI_ONLY_PREF_KEY } from './network';
export {
  type PersistenceState,
  type StorageInfo,
  ensureStorageSpace,
  isQuotaError,
  storageEstimate,
  withQuotaGuard,
} from './storage';

/** Permanent sync indicator: connectivity, activity, live pending counters, last success. */
export const syncStatus: Signal<SyncStatus> = createStatusSignal();

// -- transport -----------------------------------------------------------------------------

const supabaseTransport = createTransport(supabaseRpcClient(supabase));
let transportOverride: Transport | null = null;

/** supabase-js implementation; `setTransport()` swaps it (tests, demos). */
export const transport: Transport = {
  push: (ops, device, options) =>
    (transportOverride ?? supabaseTransport).push(ops, device, options),
  pull: (cursor, limit, options) =>
    (transportOverride ?? supabaseTransport).pull(cursor, limit, options),
  rpc: <T>(fn: string, args?: Record<string, unknown>, options?: Parameters<Transport['rpc']>[2]) =>
    (transportOverride ?? supabaseTransport).rpc<T>(fn, args, options),
};

/** Replace the network layer (null restores the supabase-js implementation). */
export function setTransport(replacement: Transport | null): void {
  transportOverride = replacement;
}

// -- wiring --------------------------------------------------------------------------------

const userId = (): string | null => session.peek()?.user.id ?? null;

const auth: AuthPort = {
  deviceId,
  userId,
  accessToken,
  onSessionProblem: (problem) => handleSessionProblem(problem),
};

const dbPort = createDbAdapter({ userId });

const engine: SyncEngine = createSyncEngine({
  db: dbPort,
  transport,
  auth,
  net: createBrowserNetwork(),
  prefs: { wifiOnly: () => getPref<boolean>(WIFI_ONLY_PREF_KEY, false) === true },
  app: {
    supabaseUrl: env.supabaseUrl,
    anonKey: env.supabaseAnonKey,
    appVersion: APP_VERSION,
    deviceLabel: defaultDeviceLabel,
  },
  lock: createSyncLock(dbPort, systemClock),
  uploader: createTusUploader({
    supabaseUrl: env.supabaseUrl,
    anonKey: env.supabaseAnonKey,
    accessToken,
    deviceId,
  }),
  status: syncStatus,
  requestPersistence: () => requestPersistentStorage(dbPort),
});

// A sign-in, an unlock or a change of roles: do not wait for the two-minute timer.
let lastSeen = '';
effect(() => {
  const key = `${session.value?.user.id ?? ''}|${me.value?.scope_epoch ?? ''}`;
  if (key === lastSeen) return;
  lastSeen = key;
  engine.sessionChanged();
});

// -- contract §3.5 -------------------------------------------------------------------------

/** Start syncing: now, when the browser comes online, every 2 minutes, on visibilitychange. */
export function startSync(): void {
  engine.start();
}

export function stopSync(): void {
  engine.stop();
}

/** The "sync now" button: runs a full cycle and resolves when it is finished. */
export function syncNow(): Promise<void> {
  return engine.syncNow();
}

/**
 * Drop local data. Without a reason (scope change) and for `sign_out`: everything pulled
 * from the server and the cursor — unsent work stays. `user_changed` and `revoked` remove
 * every local store.
 */
export function resetLocalData(reason?: ResetReason): Promise<void> {
  return engine.resetLocalData(reason);
}

/** Queue the two objects of a photo for upload (called by `addPhoto` after `mutate()`). */
export function enqueuePhotoUpload(photoId: string): Promise<void> {
  return engine.enqueuePhotoUpload(photoId);
}

// -- extensions (additive) -----------------------------------------------------------------

/** Photos waiting for upload, oldest first (settings / sync details screen). */
export function listPhotoUploads(): Promise<PhotoUploadEntry[]> {
  return engine.photos.list();
}

/** Re-read the pending counters into `syncStatus` (they also update by themselves). */
export function refreshSyncStatus(): Promise<void> {
  return engine.refreshStatus();
}

/** Resolves when no sync cycle is running. */
export function whenSyncIdle(): Promise<void> {
  return engine.whenIdle();
}

void engine.refreshStatus();

/**
 * Device storage (brief §4.6): ask once for persistent storage, report usage for the
 * settings screen, and turn "quota exceeded" into a clear, typed error instead of silently
 * losing data.
 */
import { SyncError, isQuotaError } from './errors';
import type { DbPort } from './ports';

export { isQuotaError } from './errors';

/** The subset of `navigator.storage` used here (injectable for tests). */
export interface StorageManagerLike {
  persist?: () => Promise<boolean>;
  persisted?: () => Promise<boolean>;
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
}

export type PersistenceState = 'persisted' | 'denied' | 'unsupported';

export interface StorageInfo {
  /** Bytes used by this origin (IndexedDB, caches, service worker). */
  usage: number;
  /** Bytes the browser is willing to give this origin. */
  quota: number;
  free: number;
  /** 0..100 */
  percentUsed: number;
  /** True when the browser promised not to evict our data under storage pressure. */
  persisted: boolean;
}

const META_PERSIST = 'sync.persist';
/** Ask again after a week: browsers grant persistence later (e.g. once the PWA is installed). */
const RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** Keep this much free so that the outbox can always record the user's work. */
export const STORAGE_RESERVE_BYTES = 5 * 1024 * 1024;

function manager(explicit?: StorageManagerLike | null): StorageManagerLike | null {
  if (explicit !== undefined) return explicit;
  if (typeof navigator === 'undefined' || !navigator.storage) return null;
  return navigator.storage;
}

let askedThisSession: Promise<PersistenceState> | null = null;

/**
 * Calls `navigator.storage.persist()` at most once per page load, and not again for a week
 * after a refusal (Firefox shows a prompt). Never throws.
 */
export function requestPersistentStorage(
  db: Pick<DbPort, 'getMeta' | 'setMeta'>,
  opts: { storage?: StorageManagerLike | null; now?: () => number } = {},
): Promise<PersistenceState> {
  if (!askedThisSession) askedThisSession = ask(db, manager(opts.storage), opts.now ?? Date.now);
  return askedThisSession;
}

/** Test hook: forget that this page load already asked. */
export function resetPersistenceRequest(): void {
  askedThisSession = null;
}

async function ask(
  db: Pick<DbPort, 'getMeta' | 'setMeta'>,
  storage: StorageManagerLike | null,
  now: () => number,
): Promise<PersistenceState> {
  if (!storage?.persist) return 'unsupported';
  try {
    if (storage.persisted && (await storage.persisted())) return 'persisted';
    const last = await db.getMeta<{ at: number; granted: boolean }>(META_PERSIST);
    if (last && !last.granted && now() - last.at < RETRY_AFTER_MS) return 'denied';
    const granted = await storage.persist();
    await db.setMeta(META_PERSIST, { at: now(), granted });
    return granted ? 'persisted' : 'denied';
  } catch {
    return 'denied';
  }
}

/** Usage figures for the settings screen; null when the browser cannot tell. */
export async function storageEstimate(
  storage?: StorageManagerLike | null,
): Promise<StorageInfo | null> {
  const m = manager(storage);
  if (!m?.estimate) return null;
  try {
    const { usage = 0, quota = 0 } = await m.estimate();
    const persisted = m.persisted ? await m.persisted().catch(() => false) : false;
    return {
      usage,
      quota,
      free: Math.max(0, quota - usage),
      percentUsed: quota > 0 ? Math.min(100, Math.round((usage / quota) * 1000) / 10) : 0,
      persisted,
    };
  } catch {
    return null;
  }
}

/**
 * Throws `SyncError('storage_full')` when storing `bytes` more would eat into the reserve.
 * Call it before saving something large (a photo) so the user gets a clear message while
 * the form is still open. Does nothing when the browser gives no estimate.
 */
export async function ensureStorageSpace(
  bytes: number,
  storage?: StorageManagerLike | null,
): Promise<void> {
  const info = await storageEstimate(storage);
  if (!info || info.quota === 0) return;
  if (info.free < bytes + STORAGE_RESERVE_BYTES) {
    throw new SyncError(
      'storage_full',
      `not enough device storage: ${info.free} bytes free, ${bytes} needed`,
    );
  }
}

/**
 * Runs a local write and converts the browser's QuotaExceededError (also when wrapped by
 * Dexie) into `SyncError('storage_full')`. The failed transaction is rolled back by
 * IndexedDB, so nothing is half-written; the caller keeps the user's input and shows
 * `t('sync.error_storage_full')`.
 */
export async function withQuotaGuard<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (e) {
    if (isQuotaError(e))
      throw new SyncError('storage_full', 'local storage quota exceeded', { cause: e });
    throw e;
  }
}

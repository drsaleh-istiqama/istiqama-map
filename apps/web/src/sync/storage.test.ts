import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncError, errorKey, isQuotaError, toSyncError } from './errors';
import {
  STORAGE_RESERVE_BYTES,
  type StorageManagerLike,
  ensureStorageSpace,
  requestPersistentStorage,
  resetPersistenceRequest,
  storageEstimate,
  withQuotaGuard,
} from './storage';

function metaStore() {
  const values = new Map<string, unknown>();
  return {
    values,
    getMeta: async <T>(key: string) => values.get(key) as T | undefined,
    setMeta: async (key: string, value: unknown) => {
      values.set(key, value);
    },
  };
}

function quotaError(): Error {
  return Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
}

beforeEach(() => resetPersistenceRequest());
afterEach(() => vi.restoreAllMocks());

describe('requestPersistentStorage', () => {
  it('asks the browser once and remembers the grant', async () => {
    const storage: StorageManagerLike = {
      persisted: vi.fn().mockResolvedValue(false),
      persist: vi.fn().mockResolvedValue(true),
    };
    const db = metaStore();
    expect(await requestPersistentStorage(db, { storage, now: () => 1000 })).toBe('persisted');
    expect(await requestPersistentStorage(db, { storage, now: () => 2000 })).toBe('persisted');
    expect(storage.persist).toHaveBeenCalledTimes(1);
    expect(db.values.get('sync.persist')).toEqual({ at: 1000, granted: true });
  });

  it('does not ask when storage is already persistent', async () => {
    const storage: StorageManagerLike = {
      persisted: vi.fn().mockResolvedValue(true),
      persist: vi.fn(),
    };
    expect(await requestPersistentStorage(metaStore(), { storage })).toBe('persisted');
    expect(storage.persist).not.toHaveBeenCalled();
  });

  it('does not nag after a refusal, and asks again after a week', async () => {
    const storage: StorageManagerLike = {
      persisted: vi.fn().mockResolvedValue(false),
      persist: vi.fn().mockResolvedValue(false),
    };
    const db = metaStore();
    const day = 24 * 60 * 60 * 1000;
    expect(await requestPersistentStorage(db, { storage, now: () => 0 })).toBe('denied');
    resetPersistenceRequest(); // next page load
    expect(await requestPersistentStorage(db, { storage, now: () => 3 * day })).toBe('denied');
    expect(storage.persist).toHaveBeenCalledTimes(1);
    resetPersistenceRequest();
    await requestPersistentStorage(db, { storage, now: () => 8 * day });
    expect(storage.persist).toHaveBeenCalledTimes(2);
  });

  it('copes with browsers that have no StorageManager or throw', async () => {
    expect(await requestPersistentStorage(metaStore(), { storage: null })).toBe('unsupported');
    resetPersistenceRequest();
    const storage: StorageManagerLike = {
      persist: vi.fn().mockRejectedValue(new Error('SecurityError')),
    };
    expect(await requestPersistentStorage(metaStore(), { storage })).toBe('denied');
  });
});

describe('storageEstimate', () => {
  it('reports usage, quota, free space and persistence', async () => {
    const storage: StorageManagerLike = {
      estimate: async () => ({ usage: 250_000_000, quota: 1_000_000_000 }),
      persisted: async () => true,
    };
    expect(await storageEstimate(storage)).toEqual({
      usage: 250_000_000,
      quota: 1_000_000_000,
      free: 750_000_000,
      percentUsed: 25,
      persisted: true,
    });
  });

  it('returns null when the browser cannot tell', async () => {
    expect(await storageEstimate(null)).toBeNull();
    expect(await storageEstimate({})).toBeNull();
    expect(await storageEstimate({ estimate: () => Promise.reject(new Error('x')) })).toBeNull();
  });
});

describe('quota handling', () => {
  it('refuses a large write that would eat into the reserve, with a typed error', async () => {
    const storage: StorageManagerLike = {
      estimate: async () => ({ usage: 995_000_000, quota: 1_000_000_000 }),
    };
    await expect(ensureStorageSpace(600_000, storage)).rejects.toMatchObject({
      kind: 'storage_full',
    });
    const roomy: StorageManagerLike = {
      estimate: async () => ({ usage: 0, quota: STORAGE_RESERVE_BYTES * 10 }),
    };
    await expect(ensureStorageSpace(600_000, roomy)).resolves.toBeUndefined();
    await expect(ensureStorageSpace(600_000, null)).resolves.toBeUndefined();
  });

  it('turns QuotaExceededError into storage_full, also when Dexie wraps it', async () => {
    await expect(withQuotaGuard(() => Promise.reject(quotaError()))).rejects.toMatchObject({
      kind: 'storage_full',
    });
    const wrapped = Object.assign(new Error('Transaction aborted'), {
      name: 'AbortError',
      inner: quotaError(),
    });
    expect(isQuotaError(wrapped)).toBe(true);
    await expect(withQuotaGuard(() => Promise.reject(wrapped))).rejects.toBeInstanceOf(SyncError);
    expect(errorKey(wrapped)).toBe('sync.error_storage_full');
  });

  it('leaves other errors alone and passes results through', async () => {
    const other = new Error('boom');
    await expect(withQuotaGuard(() => Promise.reject(other))).rejects.toBe(other);
    expect(await withQuotaGuard(async () => 7)).toBe(7);
  });
});

describe('error classification', () => {
  it('maps thrown values to kinds and locale keys', () => {
    expect(toSyncError(new TypeError('Failed to fetch')).kind).toBe('network');
    expect(toSyncError(Object.assign(new Error('x'), { name: 'AbortError' })).kind).toBe('aborted');
    expect(toSyncError(Object.assign(new Error('x'), { name: 'TimeoutError' })).kind).toBe(
      'timeout',
    );
    expect(toSyncError('weird').kind).toBe('unknown');
    const same = new SyncError('server', 'x');
    expect(toSyncError(same)).toBe(same);

    const keys: Array<[SyncError['kind'], string]> = [
      ['network', 'sync.error_network'],
      ['timeout', 'sync.error_timeout'],
      ['unauthenticated', 'sync.error_auth'],
      ['session_revoked', 'sync.error_revoked'],
      ['forbidden', 'sync.error_forbidden'],
      ['rate_limited', 'sync.error_rate_limited'],
      ['server', 'sync.error_server'],
      ['bad_response', 'sync.error_server'],
      ['storage_full', 'sync.error_storage_full'],
      ['invalid', 'sync.error_invalid'],
      ['unknown', 'sync.error_unknown'],
    ];
    for (const [kind, key] of keys) expect(errorKey(new SyncError(kind, 'x'))).toBe(key);
  });

  it('knows which failures may be retried and which end the session', () => {
    const retryable = (
      ['network', 'timeout', 'rate_limited', 'server', 'bad_response'] as const
    ).map((k) => new SyncError(k, 'x').retryable);
    expect(retryable).toEqual([true, true, true, true, true]);
    expect(new SyncError('invalid', 'x').retryable).toBe(false);
    expect(new SyncError('session_revoked', 'x').fatalForSession).toBe(true);
    expect(new SyncError('unauthenticated', 'x').fatalForSession).toBe(true);
    expect(new SyncError('forbidden', 'x').fatalForSession).toBe(false);
  });
});

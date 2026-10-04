/**
 * Minimal promise wrapper around one IndexedDB object store (key → structured-clone value).
 *
 * The auth vault deliberately does NOT live in the Dexie database "istiqama-map": wiping the
 * synced data must not remove the PIN vault, and wiping the vault (forgotten PIN, too many wrong
 * attempts) must never touch unsent field work.
 */
const STORE = 'kv';

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexeddb_request_failed'));
  });
}

export class KvStore {
  private opening: Promise<IDBDatabase> | null = null;

  constructor(private readonly name: string) {}

  private open(): Promise<IDBDatabase> {
    if (this.opening) return this.opening;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('indexeddb_unavailable'));
        return;
      }
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE);
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        // Another tab upgrading or deleting the database must not be blocked by this one.
        db.onversionchange = () => {
          db.close();
          if (this.opening === opening) this.opening = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error('indexeddb_open_failed'));
      request.onblocked = () => reject(new Error('indexeddb_blocked'));
    });
    this.opening = opening;
    opening.catch(() => {
      if (this.opening === opening) this.opening = null;
    });
    return opening;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const db = await this.open();
    const tx = db.transaction(STORE, 'readonly');
    return requestToPromise(tx.objectStore(STORE).get(key) as IDBRequest<T | undefined>);
  }

  /** Applies all puts/deletes in one transaction; resolves when it has committed. */
  async write(
    changes: ReadonlyArray<{ key: string; value?: unknown; delete?: boolean }>,
  ): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite', { durability: 'strict' });
      const store = tx.objectStore(STORE);
      for (const change of changes) {
        if (change.delete) store.delete(change.key);
        else store.put(change.value, change.key);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('indexeddb_write_failed'));
      tx.onabort = () => reject(tx.error ?? new Error('indexeddb_write_aborted'));
    });
  }

  put(key: string, value: unknown): Promise<void> {
    return this.write([{ key, value }]);
  }

  /**
   * Reads `key` and — only when `guard(current)` says so — writes `value`, both in ONE
   * transaction, so another tab cannot slip a write in between. Resolves whether it wrote.
   */
  async putIf<T>(
    key: string,
    value: T,
    guard: (current: T | undefined) => boolean,
  ): Promise<boolean> {
    const db = await this.open();
    return new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite', { durability: 'strict' });
      const store = tx.objectStore(STORE);
      let written = false;
      const read = store.get(key) as IDBRequest<T | undefined>;
      read.onsuccess = () => {
        if (!guard(read.result)) return;
        store.put(value, key);
        written = true;
      };
      tx.oncomplete = () => resolve(written);
      tx.onerror = () => reject(tx.error ?? new Error('indexeddb_write_failed'));
      tx.onabort = () => reject(tx.error ?? new Error('indexeddb_write_aborted'));
    });
  }

  delete(key: string): Promise<void> {
    return this.write([{ key, delete: true }]);
  }

  /** Every stored value (tests scan this for plaintext). */
  async dump(): Promise<Array<{ key: string; value: unknown }>> {
    const db = await this.open();
    const store = db.transaction(STORE, 'readonly').objectStore(STORE);
    const [keys, values] = await Promise.all([
      requestToPromise(store.getAllKeys()),
      requestToPromise(store.getAll() as IDBRequest<unknown[]>),
    ]);
    return keys.map((key, index) => ({ key: String(key), value: values[index] }));
  }

  async close(): Promise<void> {
    const opening = this.opening;
    this.opening = null;
    if (!opening) return;
    try {
      (await opening).close();
    } catch {
      // never opened: nothing to close
    }
  }
}

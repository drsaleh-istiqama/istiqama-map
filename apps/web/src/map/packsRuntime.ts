/**
 * The browser wiring of the pack manager: real fetch, OPFS / IndexedDB, the `packs` store of
 * the app database, `navigator.onLine` and `navigator.storage`. One instance per page.
 */
import { db, type PackRecord } from '../db';
import { packUrl } from './config';
import { packStore } from './packStore';
import {
  createPackManager,
  type LocalPackRecord,
  type PackManager,
  type RecordStore,
} from './packs';

const records: RecordStore = {
  get: async (code) => (await db.packs.get(code)) as LocalPackRecord | undefined,
  put: async (record) => {
    await db.packs.put(record as PackRecord);
  },
  delete: async (code) => {
    await db.packs.delete(code);
  },
  list: async () => (await db.packs.toArray()) as LocalPackRecord[],
};

let instance: PackManager | null = null;

export function packManager(): PackManager {
  instance ??= createPackManager({
    fetch: (input, init) => fetch(input, init),
    store: packStore,
    records,
    online: () => typeof navigator === 'undefined' || navigator.onLine !== false,
    estimate: async () => {
      if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      return { usage, quota };
    },
    persist: async () =>
      typeof navigator !== 'undefined' && navigator.storage?.persist
        ? navigator.storage.persist()
        : false,
    url: (storagePath) => packUrl(storagePath),
  });
  return instance;
}

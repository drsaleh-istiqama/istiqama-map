/**
 * Where offline map packs live on the device (brief §4.7):
 *
 *  - **OPFS** (Origin Private File System) when the browser supports writable file handles:
 *    one file per pack, `map-packs/<code>.pmtiles`, read back with `File.slice()` (no copy of
 *    the whole pack in memory);
 *  - **IndexedDB** otherwise: the pack as fixed-size chunks in a database of this module
 *    (`istiqama-map-packs`), so a pack never has to fit in memory either.
 *
 * Both are written chunk by chunk at increasing offsets and can be truncated back to the last
 * durable offset, which is what resumable downloads need. Browser APIs are reached through
 * tiny structural interfaces so that the unit tests can pass in-memory fakes.
 */
import Dexie, { type Table } from 'dexie';

/** Download / storage granularity. Resume points are always multiples of it. */
export const PACK_CHUNK_BYTES = 2 * 1024 * 1024;

export interface PackFile {
  size(): Promise<number>;
  /** Bytes `[offset, offset + length)`, clamped to the end of the file. */
  read(offset: number, length: number): Promise<ArrayBuffer>;
}

export interface PackWriter {
  write(offset: number, data: Uint8Array): Promise<void>;
  /** Makes everything written so far durable (survives a closed tab). */
  commit(): Promise<void>;
  close(): Promise<void>;
  /** Drops what was not committed (used when a download fails hard). */
  abort(): Promise<void>;
}

export interface PackStore {
  readonly kind: 'opfs' | 'idb';
  open(code: string): Promise<PackFile | null>;
  /** Writer positioned after `keepBytes`; anything beyond is truncated. */
  writer(code: string, keepBytes: number): Promise<PackWriter>;
  remove(code: string): Promise<void>;
  /** Codes that have data on the device. */
  list(): Promise<string[]>;
}

/** File-name-safe version of a pack code (codes are like `TZ-PN` or `ke-mombasa`). */
export function packFileName(code: string): string {
  return `${code.replace(/[^A-Za-z0-9_-]/g, '_')}.pmtiles`;
}

function codeFromFileName(name: string): string | null {
  return name.endsWith('.pmtiles') ? name.slice(0, -'.pmtiles'.length) : null;
}

// ---------------------------------------------------------------------------------------------
// OPFS
// ---------------------------------------------------------------------------------------------

export interface WritableLike {
  write(
    params:
      { type: 'write'; position: number; data: Uint8Array } | { type: 'truncate'; size: number },
  ): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

export interface FileHandleLike {
  getFile(): Promise<Blob>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<WritableLike>;
}

export interface DirectoryHandleLike {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandleLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  removeEntry(name: string): Promise<void>;
  keys(): AsyncIterableIterator<string>;
}

const OPFS_DIR = 'map-packs';

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === 'NotFoundError' || /not ?found/i.test(error.message))
  );
}

export function createOpfsStore(getRoot: () => Promise<DirectoryHandleLike>): PackStore {
  const dir = async (): Promise<DirectoryHandleLike> =>
    (await getRoot()).getDirectoryHandle(OPFS_DIR, { create: true });

  return {
    kind: 'opfs',
    async open(code) {
      let handle: FileHandleLike;
      try {
        handle = await (await dir()).getFileHandle(packFileName(code));
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
      // A File is a snapshot: take it once per open(); installed packs never change.
      const file = await handle.getFile();
      return {
        size: async () => file.size,
        read: async (offset, length) => file.slice(offset, offset + length).arrayBuffer(),
      };
    },
    async writer(code, keepBytes) {
      const handle = await (await dir()).getFileHandle(packFileName(code), { create: true });
      let writable: WritableLike | null = await handle.createWritable({ keepExistingData: true });
      await writable.write({ type: 'truncate', size: keepBytes });
      const ensure = async (): Promise<WritableLike> => {
        writable ??= await handle.createWritable({ keepExistingData: true });
        return writable;
      };
      return {
        async write(offset, data) {
          await (await ensure()).write({ type: 'write', position: offset, data });
        },
        // createWritable() works on a swap copy that only replaces the file on close().
        async commit() {
          if (writable) await writable.close();
          writable = null;
        },
        async close() {
          if (writable) await writable.close();
          writable = null;
        },
        async abort() {
          if (writable) await (writable.abort?.() ?? writable.close());
          writable = null;
        },
      };
    },
    async remove(code) {
      try {
        await (await dir()).removeEntry(packFileName(code));
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
    async list() {
      const codes: string[] = [];
      for await (const name of (await dir()).keys()) {
        const code = codeFromFileName(name);
        if (code) codes.push(code);
      }
      return codes;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// IndexedDB fallback
// ---------------------------------------------------------------------------------------------

interface ChunkRow {
  code: string;
  index: number;
  data: ArrayBuffer;
}
interface FileRow {
  code: string;
  size: number;
}

class PackChunksDb extends Dexie {
  chunks!: Table<ChunkRow, [string, number]>;
  files!: Table<FileRow, string>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({ chunks: '[code+index]', files: 'code' });
  }
}

export const IDB_PACKS_DB = 'istiqama-map-packs';

export function createIdbStore(
  name: string = IDB_PACKS_DB,
  chunkBytes: number = PACK_CHUNK_BYTES,
): PackStore {
  const db = new PackChunksDb(name);
  const range = (code: string, from: number) =>
    db.chunks.where('[code+index]').between([code, from], [code, Dexie.maxKey], true, true);

  return {
    kind: 'idb',
    async open(code) {
      const row = await db.files.get(code);
      if (!row) return null;
      const size = row.size;
      return {
        size: async () => size,
        async read(offset, length) {
          const start = Math.max(0, Math.min(offset, size));
          const end = Math.max(start, Math.min(offset + length, size));
          const out = new Uint8Array(end - start);
          if (end === start) return out.buffer;
          const first = Math.floor(start / chunkBytes);
          const last = Math.floor((end - 1) / chunkBytes);
          const rows = await db.chunks
            .where('[code+index]')
            .between([code, first], [code, last], true, true)
            .toArray();
          for (const r of rows) {
            const chunkStart = r.index * chunkBytes;
            const bytes = new Uint8Array(r.data);
            const from = Math.max(start, chunkStart);
            const to = Math.min(end, chunkStart + bytes.length);
            if (to > from)
              out.set(bytes.subarray(from - chunkStart, to - chunkStart), from - start);
          }
          return out.buffer;
        },
      };
    },
    async writer(code, keepBytes) {
      if (keepBytes % chunkBytes !== 0) throw new Error('resume point must be chunk-aligned');
      await db.transaction('rw', db.chunks, db.files, async () => {
        await range(code, keepBytes / chunkBytes).delete();
        await db.files.put({ code, size: keepBytes });
      });
      return {
        async write(offset, data) {
          if (offset % chunkBytes !== 0 || data.length > chunkBytes)
            throw new Error('IndexedDB pack writes must be whole, aligned chunks');
          // Copy: the caller may reuse its buffer; IndexedDB clones ArrayBuffers on put.
          const copy = data.slice().buffer;
          await db.transaction('rw', db.chunks, db.files, async () => {
            await db.chunks.put({ code, index: offset / chunkBytes, data: copy });
            const current = (await db.files.get(code))?.size ?? 0;
            await db.files.put({ code, size: Math.max(current, offset + data.length) });
          });
        },
        // Every chunk is its own transaction: already durable.
        commit: async () => undefined,
        close: async () => undefined,
        abort: async () => undefined,
      };
    },
    async remove(code) {
      await db.transaction('rw', db.chunks, db.files, async () => {
        await range(code, 0).delete();
        await db.files.delete(code);
      });
    },
    async list() {
      return (await db.files.toCollection().primaryKeys()) as string[];
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Choice
// ---------------------------------------------------------------------------------------------

interface StorageWithDirectory {
  getDirectory?: () => Promise<unknown>;
}

/** OPFS with writable handles is available (Chrome / Edge / Android WebView, Firefox, Safari 17+). */
export async function opfsSupported(): Promise<boolean> {
  try {
    const storage = (typeof navigator !== 'undefined' ? navigator.storage : undefined) as
      StorageWithDirectory | undefined;
    if (!storage?.getDirectory) return false;
    const root = (await storage.getDirectory()) as DirectoryHandleLike;
    const dir = await root.getDirectoryHandle(OPFS_DIR, { create: true });
    const probe = await dir.getFileHandle('.probe', { create: true });
    if (typeof probe.createWritable !== 'function') return false;
    await dir.removeEntry('.probe').catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

let defaultStore: Promise<PackStore> | null = null;

/** The store of this browser (decided once per page load). */
export function packStore(): Promise<PackStore> {
  defaultStore ??= opfsSupported().then((ok) =>
    ok
      ? createOpfsStore(
          async () =>
            (await (
              navigator.storage as unknown as Required<StorageWithDirectory>
            ).getDirectory()) as DirectoryHandleLike,
        )
      : createIdbStore(),
  );
  return defaultStore;
}

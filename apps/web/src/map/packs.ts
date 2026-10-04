/**
 * Offline map packs (brief §4.7, docs/V2_PARITY.md 1.7).
 *
 * `map_packs` (a synced reference table) lists the packs built by `scripts/build-pmtiles`.
 * The user sees the size BEFORE downloading; a download runs in HTTP Range chunks, is
 * resumable after a closed tab or a dropped connection, is checked (size, PMTiles header,
 * SHA-256) before it is used, and can be deleted. The map reads installed packs first
 * (basemapProtocol.ts) and falls back to the online basemap.
 *
 * Local bookkeeping lives in the `packs` store of the app database (owned by this module);
 * the bytes live in OPFS or IndexedDB (packStore.ts). Every dependency is injectable: the unit
 * tests run the whole flow against a fake fetch and an in-memory OPFS.
 */
import { signal, type Signal } from '@preact/signals';
import type { MapPackRow, PackRecord } from '../db';
import { isPmtilesV3 } from './localSource';
import { PACK_CHUNK_BYTES, type PackFile, type PackStore, type PackWriter } from './packStore';
import { Sha256 } from './sha256';

/** What this device knows about one pack (stored in `db.packs`, key `code`). */
export interface LocalPackRecord extends PackRecord {
  code: string;
  /** `map_packs.id` at download time. */
  packId: string;
  storage: 'opfs' | 'idb';
  storagePath: string;
  bytesTotal: number;
  /** Durable bytes on the device (a multiple of the chunk size until complete). */
  bytesDone: number;
  sha256: string | null;
  tilesVersion: string | null;
  state: 'partial' | 'installed';
  minZoom: number | null;
  maxZoom: number | null;
  bbox: [number, number, number, number] | null;
  updatedAt: number;
  installedAt: number | null;
}

export type PackErrorCode =
  | 'offline'
  | 'storage_full'
  | 'http'
  | 'range_unsupported'
  | 'changed'
  | 'short_read'
  | 'integrity'
  | 'network'
  | 'aborted';

export class PackError extends Error {
  constructor(
    readonly code: PackErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'PackError';
  }
}

export type PackPhase = 'downloading' | 'verifying' | 'paused' | 'failed';

export interface PackProgress {
  phase: PackPhase;
  done: number;
  total: number;
  error?: PackErrorCode;
}

/** UI view of a pack: the catalogue row joined with the device state. */
export type PackStatus = 'available' | 'partial' | 'installed' | 'update';

export interface RecordStore {
  get(code: string): Promise<LocalPackRecord | undefined>;
  put(record: LocalPackRecord): Promise<void>;
  delete(code: string): Promise<void>;
  list(): Promise<LocalPackRecord[]>;
}

export interface StorageEstimateLike {
  usage: number;
  quota: number;
}

export interface PackDeps {
  fetch: typeof fetch;
  store: () => Promise<PackStore>;
  records: RecordStore;
  online: () => boolean;
  /** `navigator.storage.estimate()`; null when unknown (the space check is then skipped). */
  estimate: () => Promise<StorageEstimateLike | null>;
  /** `navigator.storage.persist()` (best effort). */
  persist: () => Promise<boolean>;
  /** Download URL of `map_packs.storage_path`. */
  url: (storagePath: string) => string;
  chunkBytes?: number;
  /** Make the written bytes durable every N bytes (OPFS commits copy the file). */
  commitEveryBytes?: number;
  /** Space kept free for the app's own data. */
  reserveBytes?: number;
  now?: () => number;
}

export interface InstalledPack {
  record: LocalPackRecord;
  file: PackFile;
}

export interface PackManager {
  /** Progress of running / paused / failed downloads, by pack code (for the UI). */
  readonly progress: Signal<Record<string, PackProgress>>;
  /** Changes whenever the set of installed packs changes (the map reloads its basemap). */
  readonly revision: Signal<number>;
  status(row: MapPackRow, record: LocalPackRecord | undefined): PackStatus;
  download(row: MapPackRow): Promise<void>;
  pause(code: string): void;
  isRunning(code: string): boolean;
  remove(code: string): Promise<void>;
  installed(): Promise<InstalledPack[]>;
  /** Bytes used by pack files on this device. */
  usedBytes(): Promise<number>;
  /** Drops files without a record and records without a file (e.g. after a data wipe). */
  reconcile(): Promise<void>;
}

const DEFAULT_RESERVE = 50 * 1024 * 1024;
const VERIFY_SLICE = 4 * 1024 * 1024;

function bboxOf(row: MapPackRow): [number, number, number, number] | null {
  return row.min_lon !== null &&
    row.min_lat !== null &&
    row.max_lon !== null &&
    row.max_lat !== null
    ? [row.min_lon, row.min_lat, row.max_lon, row.max_lat]
    : null;
}

function isAbort(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError') ||
    (error instanceof PackError && error.code === 'aborted')
  );
}

/** Start offset of a `Content-Range: bytes a-b/total` header (null when absent / unreadable). */
export function contentRangeStart(header: string | null): number | null {
  const m = header ? /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(header.trim()) : null;
  return m ? Number(m[1]) : null;
}

export function createPackManager(deps: PackDeps): PackManager {
  const chunk = deps.chunkBytes ?? PACK_CHUNK_BYTES;
  const commitEvery = Math.max(chunk, deps.commitEveryBytes ?? 8 * chunk);
  const reserve = deps.reserveBytes ?? DEFAULT_RESERVE;
  const now = deps.now ?? Date.now;
  const progress = signal<Record<string, PackProgress>>({});
  const revision = signal(0);
  const running = new Map<string, AbortController>();

  const setProgress = (code: string, value: PackProgress | null): void => {
    const next = { ...progress.peek() };
    if (value) next[code] = value;
    else delete next[code];
    progress.value = next;
  };

  const sameBuild = (row: MapPackRow, record: LocalPackRecord): boolean =>
    record.storagePath === row.storage_path &&
    record.bytesTotal === Number(row.bytes) &&
    (record.sha256 ?? null) === (row.sha256 ?? null) &&
    (record.tilesVersion ?? null) === (row.tiles_version ?? null);

  async function verify(file: PackFile, total: number, sha256: string | null): Promise<boolean> {
    if ((await file.size()) !== total) return false;
    if (!isPmtilesV3(await file.read(0, 8))) return false;
    if (!sha256) return true;
    const hash = new Sha256();
    for (let offset = 0; offset < total; offset += VERIFY_SLICE) {
      hash.update(new Uint8Array(await file.read(offset, Math.min(VERIFY_SLICE, total - offset))));
    }
    return hash.hex() === sha256.toLowerCase();
  }

  async function fetchChunk(
    url: string,
    start: number,
    end: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    let response: Response;
    try {
      response = await deps.fetch(url, {
        headers: { Range: `bytes=${start}-${end}` },
        signal,
        cache: 'no-store',
      });
    } catch (error) {
      if (isAbort(error)) throw new PackError('aborted');
      throw new PackError('network', error instanceof Error ? error.message : String(error));
    }
    if (response.status === 416) throw new PackError('changed', 'range not satisfiable');
    if (response.status === 200) {
      // The whole file instead of a range: only acceptable when the file IS this one chunk.
      const length = Number(response.headers.get('content-length') ?? Number.NaN);
      if (!(start === 0 && length === end + 1)) {
        await response.body?.cancel().catch(() => undefined);
        throw new PackError('range_unsupported', 'the server ignored the Range header');
      }
    } else if (response.status !== 206) {
      await response.body?.cancel().catch(() => undefined);
      throw new PackError('http', `HTTP ${response.status}`);
    }
    const rangeStart = contentRangeStart(response.headers.get('content-range'));
    if (response.status === 206 && rangeStart !== null && rangeStart !== start)
      throw new PackError('changed', 'unexpected Content-Range');
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (isAbort(error)) throw new PackError('aborted');
      throw new PackError('network', error instanceof Error ? error.message : String(error));
    }
    if (bytes.length !== end - start + 1) throw new PackError('short_read');
    return bytes;
  }

  async function run(row: MapPackRow, signal: AbortSignal): Promise<void> {
    const code = row.code;
    const total = Number(row.bytes);
    const store = await deps.store();
    let record = await deps.records.get(code);
    if (record && (!sameBuild(row, record) || record.storage !== store.kind)) {
      // A newer build of the pack (or another store): start from scratch.
      await store.remove(code);
      await deps.records.delete(code);
      record = undefined;
    }
    if (record?.state === 'installed') return;

    let done = record ? Math.floor(record.bytesDone / chunk) * chunk : 0;
    const existing = await store.open(code);
    const onDisk = existing ? await existing.size() : 0;
    if (onDisk < done) done = Math.floor(onDisk / chunk) * chunk;

    const estimate = await deps.estimate().catch(() => null);
    if (estimate && estimate.quota > 0 && estimate.quota - estimate.usage < total - done + reserve)
      throw new PackError('storage_full');
    await deps.persist().catch(() => false);

    const rec: LocalPackRecord = {
      code,
      packId: row.id,
      storage: store.kind,
      storagePath: row.storage_path,
      bytesTotal: total,
      bytesDone: done,
      sha256: row.sha256 ?? null,
      tilesVersion: row.tiles_version ?? null,
      state: 'partial',
      minZoom: row.min_zoom,
      maxZoom: row.max_zoom,
      bbox: bboxOf(row),
      updatedAt: now(),
      installedAt: null,
    };
    await deps.records.put(rec);
    setProgress(code, { phase: 'downloading', done, total });

    const url = deps.url(row.storage_path);
    let writer: PackWriter | null = await store.writer(code, done);
    let durable = done;
    const saveDurable = async (): Promise<void> => {
      rec.bytesDone = durable;
      rec.updatedAt = now();
      await deps.records.put(rec);
    };
    try {
      let sinceCommit = 0;
      while (done < total) {
        if (signal.aborted) throw new PackError('aborted');
        const end = Math.min(done + chunk, total) - 1;
        const bytes = await fetchChunk(url, done, end, signal);
        await writer.write(done, bytes);
        done += bytes.length;
        sinceCommit += bytes.length;
        if (sinceCommit >= commitEvery) {
          await writer.commit();
          durable = done;
          sinceCommit = 0;
          await saveDurable();
        }
        setProgress(code, { phase: 'downloading', done, total });
      }
      await writer.close();
      writer = null;
      durable = done;
      await saveDurable();
    } catch (error) {
      // Keep what arrived: everything written so far becomes durable, the next start resumes.
      if (writer) {
        await writer.close().catch(() => undefined);
        durable = done;
        await saveDurable().catch(() => undefined);
      }
      throw error;
    }

    setProgress(code, { phase: 'verifying', done: total, total });
    const file = await store.open(code);
    if (!file || !(await verify(file, total, rec.sha256))) {
      await store.remove(code);
      await deps.records.delete(code);
      throw new PackError('integrity');
    }
    rec.state = 'installed';
    rec.installedAt = now();
    rec.updatedAt = now();
    await deps.records.put(rec);
  }

  return {
    progress,
    revision,

    status(row, record) {
      if (!record) return 'available';
      if (!sameBuild(row, record)) return record.state === 'installed' ? 'update' : 'available';
      return record.state === 'installed' ? 'installed' : 'partial';
    },

    async download(row) {
      const code = row.code;
      if (running.has(code)) return;
      if (!deps.online()) {
        setProgress(code, {
          phase: 'failed',
          done: (await deps.records.get(code))?.bytesDone ?? 0,
          total: Number(row.bytes),
          error: 'offline',
        });
        throw new PackError('offline');
      }
      const controller = new AbortController();
      running.set(code, controller);
      try {
        await run(row, controller.signal);
        setProgress(code, null);
        revision.value++;
      } catch (error) {
        const record = await deps.records.get(code).catch(() => undefined);
        const done = record?.bytesDone ?? 0;
        const total = Number(row.bytes);
        if (isAbort(error)) {
          setProgress(code, { phase: 'paused', done, total });
          return;
        }
        const codeOf: PackErrorCode = error instanceof PackError ? error.code : 'network';
        setProgress(code, { phase: 'failed', done, total, error: codeOf });
        throw error instanceof PackError ? error : new PackError('network', String(error));
      } finally {
        running.delete(code);
      }
    },

    pause(code) {
      running.get(code)?.abort();
    },

    isRunning: (code) => running.has(code),

    async remove(code) {
      running.get(code)?.abort();
      const store = await deps.store();
      await store.remove(code);
      await deps.records.delete(code);
      setProgress(code, null);
      revision.value++;
    },

    async installed() {
      const store = await deps.store();
      const out: InstalledPack[] = [];
      for (const record of await deps.records.list()) {
        if (record.state !== 'installed' || record.storage !== store.kind) continue;
        const file = await store.open(record.code);
        if (file) out.push({ record, file });
      }
      return out;
    },

    async usedBytes() {
      return (await deps.records.list()).reduce((sum, r) => sum + (r.bytesDone || 0), 0);
    },

    async reconcile() {
      const store = await deps.store();
      const records = await deps.records.list();
      const known = new Set(records.map((r) => r.code));
      for (const code of await store.list()) {
        if (!known.has(code) && !running.has(code)) await store.remove(code);
      }
      for (const record of records) {
        if (running.has(record.code)) continue;
        const file = await store.open(record.code);
        if (!file || record.storage !== store.kind) {
          await deps.records.delete(record.code);
          continue;
        }
        if (record.state === 'installed' && (await file.size()) !== record.bytesTotal) {
          await store.remove(record.code);
          await deps.records.delete(record.code);
        }
      }
    },
  };
}

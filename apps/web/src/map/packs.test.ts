import { PMTiles } from 'pmtiles';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MapPackRow } from '../db';
import { LocalPackSource } from './localSource';
import { createOpfsStore, createIdbStore, packFileName, type PackStore } from './packStore';
import {
  contentRangeStart,
  createPackManager,
  PackError,
  type LocalPackRecord,
  type PackDeps,
  type RecordStore,
} from './packs';
import { sha256Hex } from './sha256';
import { FakeDirectory } from './testing/fakeOpfs';
import { FakeServer } from './testing/fakeServer';
import { buildPmtiles, bytesOf } from './testing/pmtilesFixture';

const CHUNK = 4096;
const BASE = 'http://127.0.0.1:54321/storage/v1/object/public/tiles';

/** A valid archive of ~37 KB: 9+ chunks of 4 KiB, the last one partial. */
function archive(seed = 7): Uint8Array {
  const tiles = [];
  for (let x = 0; x < 6; x++)
    tiles.push({ z: 10, x: 620 + x, y: 520, data: bytesOf(6000, seed + x) });
  tiles.push({ z: 0, x: 0, y: 0, data: bytesOf(500, seed) });
  return buildPmtiles(tiles, { bounds: [39, -6, 40, -5] });
}

function packRow(file: Uint8Array, overrides: Partial<MapPackRow> = {}): MapPackRow {
  return {
    id: '0190aaaa-0000-7000-8000-000000000001',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    created_by: null,
    updated_by: null,
    version: 1,
    deleted_at: null,
    code: 'TZ-PN',
    name_ar: 'شمال بيمبا',
    name_en: 'North Pemba',
    name_sw: 'Pemba Kaskazini',
    country_id: null,
    admin_area_id: null,
    storage_path: 'packs/tz/TZ-PN.pmtiles',
    bytes: file.length,
    min_zoom: 0,
    max_zoom: 10,
    min_lon: 39,
    min_lat: -6,
    max_lon: 40,
    max_lat: -5,
    tiles_version: '20261003',
    sha256: sha256Hex(file),
    active: true,
    ...overrides,
  } as MapPackRow;
}

function memoryRecords(): RecordStore & { map: Map<string, LocalPackRecord> } {
  const map = new Map<string, LocalPackRecord>();
  return {
    map,
    get: async (code) => (map.has(code) ? structuredClone(map.get(code)!) : undefined),
    put: async (r) => void map.set(r.code, structuredClone(r)),
    delete: async (code) => void map.delete(code),
    list: async () => [...map.values()].map((r) => structuredClone(r)),
  };
}

interface Harness {
  server: FakeServer;
  root: FakeDirectory;
  store: PackStore;
  records: ReturnType<typeof memoryRecords>;
  deps: PackDeps;
  online: { value: boolean };
}

function harness(overrides: Partial<PackDeps> = {}, server = new FakeServer()): Harness {
  const root = new FakeDirectory();
  const store = createOpfsStore(async () => root);
  const records = memoryRecords();
  const online = { value: true };
  const deps: PackDeps = {
    fetch: server.fetch,
    store: async () => store,
    records,
    online: () => online.value,
    estimate: async () => ({ usage: 1_000_000, quota: 10_000_000_000 }),
    persist: async () => true,
    url: (path) => `${BASE}/${path}`,
    chunkBytes: CHUNK,
    commitEveryBytes: 2 * CHUNK,
    reserveBytes: 0,
    ...overrides,
  };
  return { server, root, store, records, deps, online };
}

async function storedBytes(h: Harness, code: string): Promise<Uint8Array | null> {
  const file = await h.store.open(code);
  if (!file) return null;
  return new Uint8Array(await file.read(0, await file.size()));
}

const rangeStarts = (server: FakeServer): number[] =>
  server.requests.map((r) => Number(/bytes=(\d+)-/.exec(r.range ?? '')?.[1] ?? -1));

let file: Uint8Array;
let row: MapPackRow;
beforeEach(() => {
  file = archive();
  row = packRow(file);
});

describe('pack download', () => {
  it('downloads in aligned Range chunks, verifies and installs', async () => {
    const h = harness();
    h.server.files.set(`${BASE}/${row.storage_path}`, file);
    const manager = createPackManager(h.deps);
    expect(manager.status(row, await h.records.get(row.code))).toBe('available');

    await manager.download(row);

    expect(await storedBytes(h, row.code)).toEqual(file);
    const record = await h.records.get(row.code);
    expect(record).toMatchObject({ state: 'installed', bytesDone: file.length, storage: 'opfs' });
    expect(manager.status(row, record)).toBe('installed');
    expect(manager.revision.value).toBe(1);
    expect(manager.progress.value[row.code]).toBeUndefined();
    const expected = Math.ceil(file.length / CHUNK);
    expect(h.server.requests).toHaveLength(expected);
    expect(rangeStarts(h.server)).toEqual(Array.from({ length: expected }, (_, i) => i * CHUNK));
    const last = h.server.requests.at(-1)!.range;
    expect(last).toBe(`bytes=${(expected - 1) * CHUNK}-${file.length - 1}`);
    expect(h.root.dirs.get('map-packs')?.files.has(packFileName(row.code))).toBe(true);
  });

  it('a dropped connection keeps what arrived; the next start resumes with a Range request', async () => {
    const h = harness();
    h.server.files.set(`${BASE}/${row.storage_path}`, file);
    h.server.beforeAnswer = (n) => {
      if (n === 4) throw new TypeError('Failed to fetch');
    };
    const manager = createPackManager(h.deps);
    await expect(manager.download(row)).rejects.toMatchObject({ code: 'network' });
    expect(manager.progress.value[row.code]).toMatchObject({ phase: 'failed', error: 'network' });
    // Chunks 1–3 arrived: closing the writer made them durable.
    expect((await h.records.get(row.code))?.bytesDone).toBe(3 * CHUNK);

    h.server.beforeAnswer = null;
    h.server.requests.length = 0;
    await manager.download(row);
    expect(rangeStarts(h.server)[0]).toBe(3 * CHUNK);
    expect(await storedBytes(h, row.code)).toEqual(file);
    expect((await h.records.get(row.code))?.state).toBe('installed');
  });

  it('after a closed tab (writer never closed) it resumes from the last commit', async () => {
    const h = harness();
    h.server.files.set(`${BASE}/${row.storage_path}`, file);
    let hang!: () => void;
    h.server.beforeAnswer = (n) =>
      n === 6
        ? new Promise<void>((resolve) => {
            hang = resolve;
          })
        : undefined;
    const first = createPackManager(h.deps);
    const running = first.download(row).catch(() => undefined);
    await expect.poll(() => h.server.requests.length).toBe(6);
    // Commits happen every 2 chunks: 4 chunks are durable, the 5th sits in the swap file.
    expect((await h.records.get(row.code))?.bytesDone).toBe(4 * CHUNK);

    // "Reload": a new manager over the same storage; the old writer is simply gone.
    const opfsFile = h.root.dirs.get('map-packs')!.files.get(packFileName(row.code))!;
    expect(opfsFile.data.length).toBe(4 * CHUNK);
    h.server.beforeAnswer = null;
    h.server.requests.length = 0;
    const second = createPackManager(h.deps);
    await second.download(row);
    expect(rangeStarts(h.server)[0]).toBe(4 * CHUNK);
    expect(await storedBytes(h, row.code)).toEqual(file);
    hang();
    await running;
  });

  it('pause stops at a chunk boundary and keeps the bytes; download resumes', async () => {
    const h = harness();
    h.server.files.set(`${BASE}/${row.storage_path}`, file);
    const manager = createPackManager(h.deps);
    h.server.beforeAnswer = (n) => {
      if (n === 3) manager.pause(row.code);
    };
    await manager.download(row);
    expect(manager.progress.value[row.code]?.phase).toBe('paused');
    const done = (await h.records.get(row.code))?.bytesDone ?? 0;
    expect(done).toBeGreaterThanOrEqual(2 * CHUNK);
    expect(manager.status(row, await h.records.get(row.code))).toBe('partial');

    h.server.beforeAnswer = null;
    h.server.requests.length = 0;
    await manager.download(row);
    expect(rangeStarts(h.server)[0]).toBe(done);
    expect(await storedBytes(h, row.code)).toEqual(file);
  });

  it('rejects a pack whose checksum does not match and removes it', async () => {
    const h = harness();
    const corrupted = file.slice();
    corrupted[corrupted.length - 10]! ^= 0xff;
    h.server.files.set(`${BASE}/${row.storage_path}`, corrupted);
    const manager = createPackManager(h.deps);
    await expect(manager.download(row)).rejects.toMatchObject({ code: 'integrity' });
    expect(await h.records.get(row.code)).toBeUndefined();
    expect(await h.store.open(row.code)).toBeNull();
    expect(manager.progress.value[row.code]).toMatchObject({ phase: 'failed', error: 'integrity' });
  });

  it('rejects a file that is not a PMTiles archive even without a checksum', async () => {
    const h = harness();
    const junk = new Uint8Array(file.length); // zeros — like an interrupted extract
    h.server.files.set(`${BASE}/${row.storage_path}`, junk);
    const manager = createPackManager(h.deps);
    await expect(manager.download({ ...row, sha256: null })).rejects.toMatchObject({
      code: 'integrity',
    });
  });

  it('refuses a server that ignores the Range header', async () => {
    const server = new FakeServer({ ignoreRange: true });
    const h = harness({}, server);
    server.files.set(`${BASE}/${row.storage_path}`, file);
    const manager = createPackManager(h.deps);
    await expect(manager.download(row)).rejects.toMatchObject({ code: 'range_unsupported' });
  });

  it('starts no request while offline', async () => {
    const h = harness();
    h.online.value = false;
    const manager = createPackManager(h.deps);
    await expect(manager.download(row)).rejects.toBeInstanceOf(PackError);
    expect(h.server.requests).toHaveLength(0);
    expect(manager.progress.value[row.code]).toMatchObject({ phase: 'failed', error: 'offline' });
  });

  it('checks the free space before downloading', async () => {
    const h = harness({ estimate: async () => ({ usage: 990, quota: 1000 }) });
    h.server.files.set(`${BASE}/${row.storage_path}`, file);
    const manager = createPackManager(h.deps);
    await expect(manager.download(row)).rejects.toMatchObject({ code: 'storage_full' });
    expect(h.server.requests).toHaveLength(0);
  });

  it('a new build of the pack shows as an update and replaces the old file', async () => {
    const h = harness();
    h.server.files.set(`${BASE}/${row.storage_path}`, file);
    const manager = createPackManager(h.deps);
    await manager.download(row);
    const newer = archive(99);
    const newRow = packRow(newer, { tiles_version: '20261101' });
    expect(manager.status(newRow, await h.records.get(row.code))).toBe('update');
    h.server.files.set(`${BASE}/${row.storage_path}`, newer);
    await manager.download(newRow);
    expect(await storedBytes(h, row.code)).toEqual(newer);
    expect(manager.status(newRow, await h.records.get(row.code))).toBe('installed');
  });

  it('delete removes the file and the record', async () => {
    const h = harness();
    h.server.files.set(`${BASE}/${row.storage_path}`, file);
    const manager = createPackManager(h.deps);
    await manager.download(row);
    await manager.remove(row.code);
    expect(await h.store.open(row.code)).toBeNull();
    expect(await h.records.get(row.code)).toBeUndefined();
    expect(await manager.usedBytes()).toBe(0);
    expect(manager.revision.value).toBe(2);
  });

  it('reconcile drops files without a record and records without a file', async () => {
    const h = harness();
    h.server.files.set(`${BASE}/${row.storage_path}`, file);
    const manager = createPackManager(h.deps);
    await manager.download(row);
    const orphan = await h.store.writer('ORPHAN', 0);
    await orphan.write(0, new Uint8Array([1, 2, 3]));
    await orphan.close();
    await h.records.put({ ...(await h.records.get(row.code))!, code: 'GHOST' });
    await manager.reconcile();
    expect(await h.store.list()).toEqual([row.code]);
    expect((await h.records.list()).map((r) => r.code)).toEqual([row.code]);
  });

  it('installed packs are readable by the PMTiles decoder (OPFS)', async () => {
    const h = harness();
    h.server.files.set(`${BASE}/${row.storage_path}`, file);
    const manager = createPackManager(h.deps);
    await manager.download(row);
    const [installed] = await manager.installed();
    const archiveReader = new PMTiles(new LocalPackSource('pack:TZ-PN', installed!.file));
    const header = await archiveReader.getHeader();
    expect([header.minZoom, header.maxZoom]).toEqual([0, 10]);
    const tile = await archiveReader.getZxy(10, 622, 520);
    expect(new Uint8Array(tile!.data)).toEqual(bytesOf(6000, 9));
    expect(await archiveReader.getZxy(10, 0, 0)).toBeUndefined();
  });
});

describe('IndexedDB fallback store', () => {
  it('downloads, resumes and serves byte ranges across chunk boundaries', async () => {
    const store = createIdbStore(`packs-test-${Math.random()}`, CHUNK);
    const h = harness({ store: async () => store });
    h.server.files.set(`${BASE}/${row.storage_path}`, file);
    h.server.beforeAnswer = (n) => {
      if (n === 5) throw new TypeError('Failed to fetch');
    };
    const manager = createPackManager(h.deps);
    await expect(manager.download(row)).rejects.toBeInstanceOf(PackError);
    h.server.beforeAnswer = null;
    h.server.requests.length = 0;
    await manager.download(row);
    expect(rangeStarts(h.server)[0]).toBe(4 * CHUNK);
    const stored = await store.open(row.code);
    expect(await stored!.size()).toBe(file.length);
    // A read spanning three chunks, and one past the end.
    const slice = new Uint8Array(await stored!.read(CHUNK - 10, 2 * CHUNK + 20));
    expect(slice).toEqual(file.slice(CHUNK - 10, 3 * CHUNK + 10));
    const tail = new Uint8Array(await stored!.read(file.length - 5, 100));
    expect(tail).toEqual(file.slice(file.length - 5));
    expect((await h.records.get(row.code))?.storage).toBe('idb');
    const reader = new PMTiles(new LocalPackSource('pack:idb', stored!));
    expect(new Uint8Array((await reader.getZxy(0, 0, 0))!.data)).toEqual(bytesOf(500, 7));
  });
});

describe('contentRangeStart', () => {
  it('parses the start offset', () => {
    expect(contentRangeStart('bytes 4096-8191/37000')).toBe(4096);
    expect(contentRangeStart('bytes 0-0/*')).toBe(0);
    expect(contentRangeStart(null)).toBeNull();
    expect(contentRangeStart('items 1-2/3')).toBeNull();
  });
});

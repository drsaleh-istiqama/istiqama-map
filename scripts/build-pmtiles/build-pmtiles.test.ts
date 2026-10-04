import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { PMTiles, type RangeResponse, type Source } from 'pmtiles';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_ZOOM, DEFAULT_SOURCE, parseOptions, UsageError } from './cli.ts';
import { tilesInBbox } from './dev-basemap.ts';
import { checkLayout, InvalidArchiveError, parseHeader, serializeHeader } from './header.ts';
import { extractArgs, readArchiveHeader, sha256File } from './pmtiles.ts';
import {
  mapPackRow,
  packCode,
  packStoragePath,
  upsertMapPack,
  type AreaRow,
  type Queryable,
} from './region.ts';
import { encodePath } from './storage.ts';
import { buildArchive, COMPRESSION, serializeDirectory } from './writer.ts';

class BufferSource implements Source {
  constructor(private readonly bytes: Uint8Array) {}
  getKey(): string {
    return 'memory';
  }
  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    return { data: this.bytes.slice(offset, offset + length).buffer };
  }
}

const nodeDecompress = async (buf: ArrayBuffer, compression: number): Promise<ArrayBuffer> => {
  if (compression === 1) return buf;
  const { gunzipSync } = await import('node:zlib');
  return new Uint8Array(gunzipSync(new Uint8Array(buf))).buffer;
};

const tile = (seed: number, size = 50): Uint8Array =>
  Uint8Array.from({ length: size }, (_, i) => (seed * 31 + i * 7) & 0xff);

describe('PMTiles writer', () => {
  it('round-trips through the pmtiles decoder (gzip tiles, gzip directories, de-duplication)', async () => {
    const tiles = [
      { z: 0, x: 0, y: 0, data: gzipSync(tile(1)) },
      { z: 5, x: 19, y: 16, data: gzipSync(tile(2)) },
      { z: 5, x: 20, y: 16, data: gzipSync(tile(2)) }, // same content → one copy
      { z: 9, x: 312, y: 263, data: gzipSync(tile(3, 4000)) },
    ];
    const archive = buildArchive(
      tiles.map((t) => ({ ...t, data: new Uint8Array(t.data) })),
      { tileCompression: COMPRESSION.gzip, bounds: [39, -6, 40, -4], metadata: { name: 'test' } },
    );
    const reader = new PMTiles(new BufferSource(archive), undefined, nodeDecompress);
    const header = await reader.getHeader();
    expect(header).toMatchObject({ minZoom: 0, maxZoom: 9, numAddressedTiles: 4, numTileContents: 3 });
    expect(header.minLon).toBeCloseTo(39);
    expect(new Uint8Array((await reader.getZxy(5, 20, 16))!.data)).toEqual(tile(2));
    expect(new Uint8Array((await reader.getZxy(9, 312, 263))!.data)).toEqual(tile(3, 4000));
    expect(await reader.getZxy(5, 21, 16)).toBeUndefined();
    expect(await reader.getMetadata()).toEqual({ name: 'test' });
  });

  it('moves entries into leaf directories when the root would not fit in 16 KiB', async () => {
    // Scattered tiles of varying size: directories that do not compress away.
    const tiles = new Map<string, { z: number; x: number; y: number; data: Uint8Array }>();
    let s = 12345;
    const rnd = (n: number): number => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return (s >>> 0) % n;
    };
    for (let guard = 0; tiles.size < 30000 && guard < 100000; guard++) {
      const x = rnd(16384);
      const y = rnd(16384);
      const n = tiles.size;
      const data = Uint8Array.from({ length: 4 + (n % 97) }, (_, i) => (n >> (i % 3) * 8) & 0xff);
      tiles.set(`${x}/${y}`, { z: 14, x, y, data });
    }
    const list = [...tiles.values()];
    const archive = buildArchive(list, { tileCompression: COMPRESSION.none, bounds: [-180, -85, 180, 85] });
    const header = parseHeader(archive.subarray(0, 127));
    expect(header.leafDirectoryLength).toBeGreaterThan(0);
    expect(header.rootDirectoryOffset + header.rootDirectoryLength).toBeLessThanOrEqual(16384);
    const reader = new PMTiles(new BufferSource(archive), undefined, nodeDecompress);
    for (const probe of [list[0]!, list[12345]!, list[29999]!]) {
      expect(new Uint8Array((await reader.getZxy(14, probe.x, probe.y))!.data)).toEqual(probe.data);
    }
  });

  it('serialises directories as in the spec (delta ids, run lengths, lengths, offsets)', () => {
    const bytes = serializeDirectory([
      { tileId: 0, offset: 0, length: 10, runLength: 1 },
      { tileId: 1, offset: 10, length: 5, runLength: 2 },
      { tileId: 5, offset: 0, length: 10, runLength: 1 },
    ]);
    expect([...bytes]).toEqual([3, 0, 1, 4, 1, 2, 1, 10, 5, 10, 1, 0, 1]);
  });
});

describe('header', () => {
  it('rejects a zero-filled file (interrupted extract) and a truncated archive', () => {
    expect(() => parseHeader(new Uint8Array(127))).toThrow(InvalidArchiveError);
    const archive = buildArchive([{ z: 0, x: 0, y: 0, data: tile(1) }], {
      tileCompression: COMPRESSION.none,
      bounds: [0, 0, 1, 1],
    });
    const header = parseHeader(archive);
    expect(() => checkLayout(header, archive.length)).not.toThrow();
    expect(() => checkLayout(header, archive.length - 1)).toThrow(/truncated/);
  });

  it('serialise ∘ parse is the identity', () => {
    const archive = buildArchive([{ z: 3, x: 4, y: 4, data: tile(9) }], {
      tileCompression: COMPRESSION.gzip,
      bounds: [28, -27, 60, 26.5],
    });
    const header = parseHeader(archive);
    expect(parseHeader(serializeHeader(header))).toEqual(header);
  });

  it('reads and validates a file on disk; computes its SHA-256', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pmtiles-'));
    const good = path.join(dir, 'good.pmtiles');
    const bad = path.join(dir, 'bad.pmtiles');
    const archive = buildArchive([{ z: 0, x: 0, y: 0, data: tile(1) }], {
      tileCompression: COMPRESSION.none,
      bounds: [0, 0, 1, 1],
    });
    writeFileSync(good, archive);
    writeFileSync(bad, new Uint8Array(archive.length));
    expect((await readArchiveHeader(good)).bytes).toBe(archive.length);
    await expect(readArchiveHeader(bad)).rejects.toBeInstanceOf(InvalidArchiveError);
    expect(await sha256File(good)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('command line', () => {
  it('builds by default from the local development archive (no download)', () => {
    const opts = parseOptions(['--country', 'tz', '--area', 'North Pemba']);
    expect(opts).toMatchObject({
      command: 'build',
      country: 'TZ',
      area: 'North Pemba',
      source: DEFAULT_SOURCE,
      maxZoom: DEFAULT_MAX_ZOOM,
      upload: true,
      register: true,
    });
  });

  it('refuses a remote source unless explicitly allowed', () => {
    expect(() =>
      parseOptions(['--country', 'TZ', '--area', 'PN', '--source', 'https://build.protomaps.com/20261003.pmtiles']),
    ).toThrow(/--allow-remote/);
    expect(
      parseOptions([
        '--country=TZ',
        '--area=PN',
        '--source=https://build.protomaps.com/20261003.pmtiles',
        '--allow-remote',
      ]).allowRemote,
    ).toBe(true);
  });

  it('validates values and required options', () => {
    expect(() => parseOptions(['--area', 'PN'])).toThrow(UsageError);
    expect(() => parseOptions(['--country', 'TZ', '--area', 'PN', '--maxzoom', '20'])).toThrow(/maxzoom/);
    expect(() => parseOptions(['--country', 'TZ', '--area', 'PN', '--code', 'a b'])).toThrow(/code/);
    expect(() => parseOptions(['--country', 'TZ', '--area', 'PN', '--bogus'])).toThrow(/unknown/);
    expect(parseOptions(['list', '--country', 'KE', '--level', '2'])).toMatchObject({
      command: 'list',
      level: 2,
    });
    expect(parseOptions(['--country', 'TZ', '--area', 'PN', '--no-upload'])).toMatchObject({
      upload: false,
      register: false,
    });
  });

  it('passes the region file and zoom range to pmtiles extract', () => {
    expect(
      extractArgs({ tool: 'pmtiles', source: 's.pmtiles', out: 'o.pmtiles', regionFile: 'r.geojson', minZoom: 0, maxZoom: 13 }),
    ).toEqual(['extract', 's.pmtiles', 'o.pmtiles', '--region=r.geojson', '--maxzoom=13']);
    expect(
      extractArgs({ tool: 'p', source: 's', out: 'o', bbox: [1, 2, 3, 4], minZoom: 2, maxZoom: 9, dryRun: true }),
    ).toEqual(['extract', 's', 'o', '--bbox=1,2,3,4', '--maxzoom=9', '--minzoom=2', '--dry-run']);
  });
});

const AREA: AreaRow = {
  id: 'a-1',
  country_id: 'c-tz',
  iso2: 'TZ',
  level: 1,
  code: '36957248B13188202009922',
  short_code: 'PN',
  parent_short_code: null,
  name_ar: 'بيمبا الشمالية',
  name_en: 'North Pemba',
  name_sw: null,
  min_lon: 39.6612345,
  min_lat: -5.2412345,
  max_lon: 39.8512345,
  max_lat: -4.8712345,
};

describe('pack rows', () => {
  it('names packs after the area and stores them under packs/<ISO2>/', () => {
    expect(packCode(AREA)).toBe('TZ-PN');
    expect(packCode({ ...AREA, level: 2, short_code: null, parent_short_code: 'PN', name_en: 'Wete District' })).toBe(
      'TZ-PN-WETE-DISTRICT',
    );
    expect(packCode({ ...AREA, short_code: null, name_en: 'São Tomé' })).toBe('TZ-SAO-TOME');
    expect(packStoragePath('tz', 'TZ-PN')).toBe('packs/TZ/TZ-PN.pmtiles');
    expect(encodePath('packs/TZ/a b.pmtiles')).toBe('packs/TZ/a%20b.pmtiles');
  });

  it('builds the map_packs row: three names, bytes, bbox, zoom range, sha256', () => {
    const header = parseHeader(
      buildArchive([{ z: 4, x: 9, y: 8, data: tile(1) }, { z: 13, x: 4996, y: 4210, data: tile(2) }], {
        tileCompression: COMPRESSION.none,
        bounds: [39, -6, 40, -4],
      }),
    );
    const row = mapPackRow({
      area: AREA,
      code: 'TZ-PN',
      storagePath: 'packs/TZ/TZ-PN.pmtiles',
      bytes: 12345,
      sha256: 'ab'.repeat(32),
      header,
      tilesVersion: '20261003',
    });
    expect(row).toEqual({
      code: 'TZ-PN',
      name_ar: 'بيمبا الشمالية',
      name_en: 'North Pemba',
      name_sw: 'North Pemba',
      country_id: 'c-tz',
      admin_area_id: 'a-1',
      storage_path: 'packs/TZ/TZ-PN.pmtiles',
      bytes: 12345,
      min_zoom: 4,
      max_zoom: 13,
      min_lon: 39.66123,
      min_lat: -5.24123,
      max_lon: 39.85123,
      max_lat: -4.87123,
      tiles_version: '20261003',
      sha256: 'ab'.repeat(32),
      active: true,
    });
    expect(mapPackRow({ area: { ...AREA, name_ar: null }, code: 'X', storagePath: 'p', bytes: 1, sha256: 's', header, tilesVersion: null }).name_ar).toBe(
      'North Pemba',
    );
  });

  it('upserts by code and revives a soft-deleted pack', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db: Queryable = {
      query: async <T,>(sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return { rows: [{ id: 'pack-1' }] as T[] };
      },
    };
    const header = parseHeader(
      buildArchive([{ z: 0, x: 0, y: 0, data: tile(1) }], { tileCompression: 1, bounds: [0, 0, 1, 1] }),
    );
    const row = mapPackRow({ area: AREA, code: 'TZ-PN', storagePath: 'p', bytes: 1, sha256: 's', header, tilesVersion: null });
    expect(await upsertMapPack(db, row)).toBe('pack-1');
    expect(calls[0]!.sql).toMatch(/on conflict \(code\) do update set .*deleted_at = null/s);
    expect(calls[0]!.sql).not.toMatch(/code = excluded\.code/);
    expect(calls[0]!.params).toContain('TZ-PN');
  });
});

describe('development basemap tiling', () => {
  it('covers the bbox at each zoom', () => {
    expect(tilesInBbox(0, [28, -27, 60, 26.5])).toEqual([[0, 0]]);
    const z5 = tilesInBbox(5, [39, -6, 40, -4]);
    expect(z5).toEqual([[19, 16]]);
    expect(tilesInBbox(8, [28, -27, 60, 26.5]).length).toBeGreaterThan(500);
  });
});

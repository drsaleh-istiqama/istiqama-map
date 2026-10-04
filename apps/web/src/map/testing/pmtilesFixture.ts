/**
 * Test helper: builds a small but valid PMTiles v3 archive in memory (single root directory,
 * no compression), so the pmtiles decoder can be exercised against the local pack sources.
 * Mirrors the writer of scripts/build-pmtiles (that one runs under Node and gzips tiles).
 */
import { zxyToTileId } from 'pmtiles';

export interface FixtureTile {
  z: number;
  x: number;
  y: number;
  data: Uint8Array;
}

function varint(out: number[], value: number): void {
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

function setU64(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
  view.setUint32(offset + 4, Math.floor(value / 0x100000000), true);
}

export function buildPmtiles(
  tiles: FixtureTile[],
  options: {
    bounds?: [number, number, number, number];
    metadata?: Record<string, unknown>;
    tileType?: number;
  } = {},
): Uint8Array {
  const entries = tiles
    .map((t) => ({ tileId: zxyToTileId(t.z, t.x, t.y), data: t.data }))
    .sort((a, b) => a.tileId - b.tileId);
  const dataParts: Uint8Array[] = [];
  const dirEntries: Array<{ tileId: number; offset: number; length: number }> = [];
  let offset = 0;
  for (const e of entries) {
    dirEntries.push({ tileId: e.tileId, offset, length: e.data.length });
    dataParts.push(e.data);
    offset += e.data.length;
  }
  const dir: number[] = [];
  varint(dir, dirEntries.length);
  let last = 0;
  for (const e of dirEntries) {
    varint(dir, e.tileId - last);
    last = e.tileId;
  }
  for (const _ of dirEntries) varint(dir, 1); // run lengths
  for (const e of dirEntries) varint(dir, e.length);
  dirEntries.forEach((e, i) => {
    const prev = dirEntries[i - 1];
    if (i > 0 && prev && e.offset === prev.offset + prev.length) varint(dir, 0);
    else varint(dir, e.offset + 1);
  });
  const rootDir = Uint8Array.from(dir);
  const metadata = new TextEncoder().encode(JSON.stringify(options.metadata ?? {}));
  const tileData = new Uint8Array(offset);
  let p = 0;
  for (const part of dataParts) {
    tileData.set(part, p);
    p += part.length;
  }
  const zooms = tiles.map((t) => t.z);
  const minZoom = zooms.length ? Math.min(...zooms) : 0;
  const maxZoom = zooms.length ? Math.max(...zooms) : 0;
  const [minLon, minLat, maxLon, maxLat] = options.bounds ?? [-180, -85, 180, 85];

  const HEADER = 127;
  const rootOffset = HEADER;
  const metaOffset = rootOffset + rootDir.length;
  const dataOffset = metaOffset + metadata.length;
  const total = dataOffset + tileData.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode('PMTiles'), 0);
  out[7] = 3;
  setU64(view, 8, rootOffset);
  setU64(view, 16, rootDir.length);
  setU64(view, 24, metaOffset);
  setU64(view, 32, metadata.length);
  setU64(view, 40, dataOffset); // no leaf directories
  setU64(view, 48, 0);
  setU64(view, 56, dataOffset);
  setU64(view, 64, tileData.length);
  setU64(view, 72, dirEntries.length);
  setU64(view, 80, dirEntries.length);
  setU64(view, 88, dirEntries.length);
  out[96] = 1; // clustered
  out[97] = 1; // internal compression: none
  out[98] = 1; // tile compression: none
  out[99] = options.tileType ?? 1; // MVT
  out[100] = minZoom;
  out[101] = maxZoom;
  view.setInt32(102, Math.round(minLon * 1e7), true);
  view.setInt32(106, Math.round(minLat * 1e7), true);
  view.setInt32(110, Math.round(maxLon * 1e7), true);
  view.setInt32(114, Math.round(maxLat * 1e7), true);
  out[118] = minZoom;
  view.setInt32(119, Math.round(((minLon + maxLon) / 2) * 1e7), true);
  view.setInt32(123, Math.round(((minLat + maxLat) / 2) * 1e7), true);
  out.set(rootDir, rootOffset);
  out.set(metadata, metaOffset);
  out.set(tileData, dataOffset);
  return out;
}

/** Deterministic pseudo-random bytes (for "tile" payloads and large test files). */
export function bytesOf(length: number, seed = 1): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    out[i] = s & 0xff;
  }
  return out;
}

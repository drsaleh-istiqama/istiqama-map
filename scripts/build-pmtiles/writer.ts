/**
 * Minimal PMTiles v3 writer (Node): root directory + leaf directories when the root would not
 * fit in the first 16 KiB, gzip-compressed directories, de-duplicated tile contents and run
 * lengths for repeated tiles. Used by `dev-basemap.ts` (a development basemap made from the
 * boundaries in the local database) and by the tests. Real basemaps and packs come from the
 * Protomaps build through `pmtiles extract`.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { zxyToTileId } from 'pmtiles';
import { HEADER_BYTES, serializeHeader, type PmtilesHeader } from './header.ts';

export const COMPRESSION = { none: 1, gzip: 2 } as const;
export const TILE_TYPE_MVT = 1;
const ROOT_BUDGET = 16384 - HEADER_BYTES;

export interface WriterTile {
  z: number;
  x: number;
  y: number;
  /** Tile bytes, already compressed as declared by `tileCompression`. */
  data: Uint8Array;
}

export interface ArchiveOptions {
  tileCompression: number;
  tileType?: number;
  bounds: [number, number, number, number];
  center?: [number, number, number];
  metadata?: Record<string, unknown>;
}

interface Entry {
  tileId: number;
  offset: number;
  length: number;
  runLength: number;
}

function varint(out: number[], value: number): void {
  let v = value;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
}

/** Directory bytes as in the spec (before compression). */
export function serializeDirectory(entries: readonly Entry[]): Uint8Array {
  const out: number[] = [];
  varint(out, entries.length);
  let last = 0;
  for (const e of entries) {
    varint(out, e.tileId - last);
    last = e.tileId;
  }
  for (const e of entries) varint(out, e.runLength);
  for (const e of entries) varint(out, e.length);
  entries.forEach((e, i) => {
    const prev = entries[i - 1];
    if (i > 0 && prev && e.offset === prev.offset + prev.length) varint(out, 0);
    else varint(out, e.offset + 1);
  });
  return Uint8Array.from(out);
}

function compress(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(gzipSync(bytes, { level: 9 }));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function buildArchive(tiles: readonly WriterTile[], opts: ArchiveOptions): Uint8Array {
  if (tiles.length === 0) throw new Error('an archive needs at least one tile');
  const sorted = tiles
    .map((t) => ({ id: zxyToTileId(t.z, t.x, t.y), z: t.z, data: t.data }))
    .sort((a, b) => a.id - b.id);

  // Tile data, de-duplicated by content.
  const byHash = new Map<string, { offset: number; length: number }>();
  const dataParts: Uint8Array[] = [];
  let dataLength = 0;
  const entries: Entry[] = [];
  for (const t of sorted) {
    const hash = createHash('sha1').update(t.data).digest('hex');
    let place = byHash.get(hash);
    if (!place) {
      place = { offset: dataLength, length: t.data.length };
      byHash.set(hash, place);
      dataParts.push(t.data);
      dataLength += t.data.length;
    }
    const last = entries[entries.length - 1];
    if (last && last.offset === place.offset && last.tileId + last.runLength === t.id) {
      last.runLength++;
    } else {
      entries.push({ tileId: t.id, offset: place.offset, length: place.length, runLength: 1 });
    }
  }

  // Root directory, with leaves when it does not fit next to the header.
  let root = compress(serializeDirectory(entries));
  let leaves: Uint8Array = new Uint8Array(0);
  for (let leafSize = 4096; root.length > ROOT_BUDGET; leafSize *= 2) {
    const leafParts: Uint8Array[] = [];
    const rootEntries: Entry[] = [];
    let offset = 0;
    for (let i = 0; i < entries.length; i += leafSize) {
      const chunk = entries.slice(i, i + leafSize);
      const leaf = compress(serializeDirectory(chunk));
      rootEntries.push({ tileId: chunk[0]!.tileId, offset, length: leaf.length, runLength: 0 });
      leafParts.push(leaf);
      offset += leaf.length;
    }
    root = compress(serializeDirectory(rootEntries));
    leaves = concat(leafParts);
  }

  const metadata = compress(new TextEncoder().encode(JSON.stringify(opts.metadata ?? {})));
  const zooms = sorted.map((t) => t.z);
  const [minLon, minLat, maxLon, maxLat] = opts.bounds;
  const center = opts.center ?? [(minLon + maxLon) / 2, (minLat + maxLat) / 2, Math.min(...zooms)];
  const rootOffset = HEADER_BYTES;
  const metadataOffset = rootOffset + root.length;
  const leafOffset = metadataOffset + metadata.length;
  const dataOffset = leafOffset + leaves.length;
  const header: PmtilesHeader = {
    specVersion: 3,
    rootDirectoryOffset: rootOffset,
    rootDirectoryLength: root.length,
    jsonMetadataOffset: metadataOffset,
    jsonMetadataLength: metadata.length,
    leafDirectoryOffset: leafOffset,
    leafDirectoryLength: leaves.length,
    tileDataOffset: dataOffset,
    tileDataLength: dataLength,
    numAddressedTiles: sorted.length,
    numTileEntries: entries.length,
    numTileContents: byHash.size,
    clustered: true,
    internalCompression: COMPRESSION.gzip,
    tileCompression: opts.tileCompression,
    tileType: opts.tileType ?? TILE_TYPE_MVT,
    minZoom: Math.min(...zooms),
    maxZoom: Math.max(...zooms),
    minLon,
    minLat,
    maxLon,
    maxLat,
    centerZoom: center[2],
    centerLon: center[0],
    centerLat: center[1],
  };
  return concat([serializeHeader(header), root, metadata, leaves, ...dataParts]);
}

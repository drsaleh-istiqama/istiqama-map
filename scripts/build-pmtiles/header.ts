/**
 * PMTiles v3 header (127 bytes) — parse and serialise. Used to validate an archive before it
 * is uploaded (an interrupted `pmtiles extract` leaves a file of the right size full of zeros)
 * and to read the bounds and zoom range that go into `map_packs`.
 * Spec: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
 */

export const HEADER_BYTES = 127;
const MAGIC = 'PMTiles';

export interface PmtilesHeader {
  specVersion: number;
  rootDirectoryOffset: number;
  rootDirectoryLength: number;
  jsonMetadataOffset: number;
  jsonMetadataLength: number;
  leafDirectoryOffset: number;
  leafDirectoryLength: number;
  tileDataOffset: number;
  tileDataLength: number;
  numAddressedTiles: number;
  numTileEntries: number;
  numTileContents: number;
  clustered: boolean;
  internalCompression: number;
  tileCompression: number;
  tileType: number;
  minZoom: number;
  maxZoom: number;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  centerZoom: number;
  centerLon: number;
  centerLat: number;
}

export class InvalidArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidArchiveError';
  }
}

const u64 = (v: DataView, o: number): number =>
  v.getUint32(o, true) + v.getUint32(o + 4, true) * 0x100000000;

/** Parses the first 127 bytes; throws `InvalidArchiveError` when they are not a v3 header. */
export function parseHeader(bytes: Uint8Array): PmtilesHeader {
  if (bytes.length < HEADER_BYTES)
    throw new InvalidArchiveError('file shorter than a PMTiles header');
  const magic = new TextDecoder().decode(bytes.subarray(0, 7));
  if (magic !== MAGIC)
    throw new InvalidArchiveError(
      'not a PMTiles archive (magic number missing — an interrupted extract leaves zeros here)',
    );
  if (bytes[7] !== 3) throw new InvalidArchiveError(`unsupported PMTiles version ${bytes[7]}`);
  const v = new DataView(bytes.buffer, bytes.byteOffset, HEADER_BYTES);
  return {
    specVersion: 3,
    rootDirectoryOffset: u64(v, 8),
    rootDirectoryLength: u64(v, 16),
    jsonMetadataOffset: u64(v, 24),
    jsonMetadataLength: u64(v, 32),
    leafDirectoryOffset: u64(v, 40),
    leafDirectoryLength: u64(v, 48),
    tileDataOffset: u64(v, 56),
    tileDataLength: u64(v, 64),
    numAddressedTiles: u64(v, 72),
    numTileEntries: u64(v, 80),
    numTileContents: u64(v, 88),
    clustered: v.getUint8(96) === 1,
    internalCompression: v.getUint8(97),
    tileCompression: v.getUint8(98),
    tileType: v.getUint8(99),
    minZoom: v.getUint8(100),
    maxZoom: v.getUint8(101),
    minLon: v.getInt32(102, true) / 1e7,
    minLat: v.getInt32(106, true) / 1e7,
    maxLon: v.getInt32(110, true) / 1e7,
    maxLat: v.getInt32(114, true) / 1e7,
    centerZoom: v.getUint8(118),
    centerLon: v.getInt32(119, true) / 1e7,
    centerLat: v.getInt32(123, true) / 1e7,
  };
}

/** Checks that the sections described by the header lie inside a file of `fileBytes`. */
export function checkLayout(h: PmtilesHeader, fileBytes: number): void {
  const sections: Array<[string, number, number]> = [
    ['root directory', h.rootDirectoryOffset, h.rootDirectoryLength],
    ['metadata', h.jsonMetadataOffset, h.jsonMetadataLength],
    ['leaf directories', h.leafDirectoryOffset, h.leafDirectoryLength],
    ['tile data', h.tileDataOffset, h.tileDataLength],
  ];
  for (const [name, offset, length] of sections) {
    if (offset + length > fileBytes)
      throw new InvalidArchiveError(`${name} ends after the end of the file (truncated archive)`);
  }
  if (h.rootDirectoryLength === 0) throw new InvalidArchiveError('empty root directory');
  if (h.minZoom > h.maxZoom) throw new InvalidArchiveError('min zoom above max zoom');
}

function setU64(v: DataView, o: number, value: number): void {
  v.setUint32(o, value >>> 0, true);
  v.setUint32(o + 4, Math.floor(value / 0x100000000), true);
}

export function serializeHeader(h: PmtilesHeader): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES);
  const v = new DataView(out.buffer);
  out.set(new TextEncoder().encode(MAGIC), 0);
  out[7] = 3;
  setU64(v, 8, h.rootDirectoryOffset);
  setU64(v, 16, h.rootDirectoryLength);
  setU64(v, 24, h.jsonMetadataOffset);
  setU64(v, 32, h.jsonMetadataLength);
  setU64(v, 40, h.leafDirectoryOffset);
  setU64(v, 48, h.leafDirectoryLength);
  setU64(v, 56, h.tileDataOffset);
  setU64(v, 64, h.tileDataLength);
  setU64(v, 72, h.numAddressedTiles);
  setU64(v, 80, h.numTileEntries);
  setU64(v, 88, h.numTileContents);
  v.setUint8(96, h.clustered ? 1 : 0);
  v.setUint8(97, h.internalCompression);
  v.setUint8(98, h.tileCompression);
  v.setUint8(99, h.tileType);
  v.setUint8(100, h.minZoom);
  v.setUint8(101, h.maxZoom);
  v.setInt32(102, Math.round(h.minLon * 1e7), true);
  v.setInt32(106, Math.round(h.minLat * 1e7), true);
  v.setInt32(110, Math.round(h.maxLon * 1e7), true);
  v.setInt32(114, Math.round(h.maxLat * 1e7), true);
  v.setUint8(118, h.centerZoom);
  v.setInt32(119, Math.round(h.centerLon * 1e7), true);
  v.setInt32(123, Math.round(h.centerLat * 1e7), true);
  return out;
}

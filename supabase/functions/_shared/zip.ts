/**
 * Minimal ZIP reader / writer on Web-standard APIs only (`CompressionStream` /
 * `DecompressionStream` with "deflate-raw"; Deno, Edge Runtime and Node >= 21).
 *
 * Writer: deflate, no data descriptors (sizes and CRC are in the local headers, which is the
 * most widely accepted layout), no ZIP64 (entries and archive < 4 GiB).
 * Reader: central directory only, with explicit limits against decompression bombs — the
 * inflated size is counted while inflating, the sizes declared in the archive are not trusted.
 */

const CRC_TABLE = /* @__PURE__ */ (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE). Pass the previous result as `seed` to continue over several chunks. */
export function crc32(data: Uint8Array, seed = 0): number {
  let c = ~seed >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

export class ZipError extends Error {
  constructor(
    readonly code:
      | 'not_a_zip'
      | 'unsupported_zip'
      | 'encrypted'
      | 'too_large'
      | 'corrupt'
      | 'entry_not_found',
    message: string,
  ) {
    super(message);
    this.name = 'ZipError';
  }
}

// ------------------------------------------------------------------------------------------
// Writer
// ------------------------------------------------------------------------------------------

interface WrittenEntry {
  name: Uint8Array;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
}

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // fixed date: reproducible archives

/** A deflate entry that is fed in pieces (for content that is produced page by page). */
export class ZipEntryStream {
  private readonly stream = new CompressionStream('deflate-raw');
  private readonly writer = this.stream.writable.getWriter();
  private readonly chunks: Uint8Array[] = [];
  private readonly pump: Promise<void>;
  private crc = 0;
  private size = 0;
  private compressedSize = 0;

  constructor(readonly name: string) {
    const reader = this.stream.readable.getReader();
    this.pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.chunks.push(value);
        this.compressedSize += value.byteLength;
      }
    })();
  }

  get bytesWritten(): number {
    return this.size;
  }

  async write(data: Uint8Array): Promise<void> {
    if (data.byteLength === 0) return;
    this.crc = crc32(data, this.crc);
    this.size += data.byteLength;
    await this.writer.write(data as BufferSource);
  }

  async close(): Promise<{ chunks: Uint8Array[]; crc: number; size: number; compressedSize: number }> {
    await this.writer.close();
    await this.pump;
    return { chunks: this.chunks, crc: this.crc, size: this.size, compressedSize: this.compressedSize };
  }
}

export class ZipWriter {
  private readonly parts: Uint8Array[] = [];
  private readonly entries: WrittenEntry[] = [];
  private offset = 0;
  private finished = false;

  private push(part: Uint8Array): void {
    this.parts.push(part);
    this.offset += part.byteLength;
  }

  /** Add a complete (small) file. */
  async add(name: string, data: Uint8Array | string): Promise<void> {
    const entry = new ZipEntryStream(name);
    await entry.write(typeof data === 'string' ? new TextEncoder().encode(data) : data);
    await this.addStream(entry);
  }

  /** Add an entry that was fed through a `ZipEntryStream` (closes it). */
  async addStream(entry: ZipEntryStream): Promise<void> {
    if (this.finished) throw new Error('zip already finished');
    const done = await entry.close();
    if (done.size > 0xfffffffe || done.compressedSize > 0xfffffffe || this.offset > 0xfffffffe)
      throw new ZipError('too_large', 'ZIP64 archives are not supported');
    const name = new TextEncoder().encode(entry.name);
    const header = new Uint8Array(30 + name.length);
    const v = new DataView(header.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true); // version needed
    v.setUint16(6, 0x0800, true); // UTF-8 names
    v.setUint16(8, 8, true); // deflate
    v.setUint16(10, DOS_TIME, true);
    v.setUint16(12, DOS_DATE, true);
    v.setUint32(14, done.crc, true);
    v.setUint32(18, done.compressedSize, true);
    v.setUint32(22, done.size, true);
    v.setUint16(26, name.length, true);
    v.setUint16(28, 0, true);
    header.set(name, 30);
    const offset = this.offset;
    this.push(header);
    for (const chunk of done.chunks) this.push(chunk);
    this.entries.push({
      name,
      crc: done.crc,
      compressedSize: done.compressedSize,
      size: done.size,
      offset,
    });
  }

  /** Write the central directory. Returns the archive as a list of chunks and its size. */
  finish(): { chunks: Uint8Array[]; size: number } {
    if (this.finished) throw new Error('zip already finished');
    this.finished = true;
    const start = this.offset;
    for (const e of this.entries) {
      const rec = new Uint8Array(46 + e.name.length);
      const v = new DataView(rec.buffer);
      v.setUint32(0, 0x02014b50, true);
      v.setUint16(4, 20, true); // version made by
      v.setUint16(6, 20, true); // version needed
      v.setUint16(8, 0x0800, true);
      v.setUint16(10, 8, true);
      v.setUint16(12, DOS_TIME, true);
      v.setUint16(14, DOS_DATE, true);
      v.setUint32(16, e.crc, true);
      v.setUint32(20, e.compressedSize, true);
      v.setUint32(24, e.size, true);
      v.setUint16(28, e.name.length, true);
      v.setUint32(42, e.offset, true);
      rec.set(e.name, 46);
      this.push(rec);
    }
    const size = this.offset - start;
    const end = new Uint8Array(22);
    const v = new DataView(end.buffer);
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(8, this.entries.length, true);
    v.setUint16(10, this.entries.length, true);
    v.setUint32(12, size, true);
    v.setUint32(16, start, true);
    this.push(end);
    return { chunks: this.parts, size: this.offset };
  }
}

// ------------------------------------------------------------------------------------------
// Reader
// ------------------------------------------------------------------------------------------

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  /** Size DECLARED by the archive. Do not trust it for limits. */
  size: number;
  offset: number;
}

export function isZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05) &&
    (bytes[3] === 0x04 || bytes[3] === 0x06)
  );
}

/** Entries of the central directory. Refuses ZIP64, multi-disk and absurd entry counts. */
export function readZipDirectory(bytes: Uint8Array, maxEntries = 2000): ZipEntry[] {
  if (!isZip(bytes)) throw new ZipError('not_a_zip', 'not a ZIP archive');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End-of-central-directory record: search backwards (the comment is at most 65535 bytes).
  let eocd = -1;
  const lowest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= lowest; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('corrupt', 'end of central directory not found');
  const disk = view.getUint16(eocd + 4, true);
  const count = view.getUint16(eocd + 10, true);
  const dirSize = view.getUint32(eocd + 12, true);
  const dirOffset = view.getUint32(eocd + 16, true);
  if (disk !== 0) throw new ZipError('unsupported_zip', 'multi-disk archives are not supported');
  if (count === 0xffff || dirOffset === 0xffffffff || dirSize === 0xffffffff)
    throw new ZipError('unsupported_zip', 'ZIP64 archives are not supported');
  if (count > maxEntries) throw new ZipError('too_large', `too many entries (${count})`);
  if (dirOffset + dirSize > eocd) throw new ZipError('corrupt', 'central directory out of range');

  const decoder = new TextDecoder('utf-8');
  const entries: ZipEntry[] = [];
  let p = dirOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50)
      throw new ZipError('corrupt', 'bad central directory entry');
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const compressedSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    if (p + 46 + nameLen > bytes.length) throw new ZipError('corrupt', 'bad entry name');
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, flags, crc, compressedSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function entryData(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  if (entry.flags & 0x1) throw new ZipError('encrypted', 'encrypted entries are not supported');
  if (entry.compressedSize === 0xffffffff || entry.offset === 0xffffffff)
    throw new ZipError('unsupported_zip', 'ZIP64 entries are not supported');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const p = entry.offset;
  if (p + 30 > bytes.length || view.getUint32(p, true) !== 0x04034b50)
    throw new ZipError('corrupt', 'bad local file header');
  const start = p + 30 + view.getUint16(p + 26, true) + view.getUint16(p + 28, true);
  const end = start + entry.compressedSize;
  if (end > bytes.length) throw new ZipError('corrupt', 'entry data out of range');
  return bytes.subarray(start, end);
}

/**
 * The inflated content of an entry as a stream. The stream errors with `ZipError('too_large')`
 * as soon as more than `maxBytes` have been produced.
 */
export function openZipEntry(
  bytes: Uint8Array,
  entry: ZipEntry,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  const data = entryData(bytes, entry);
  let source: ReadableStream<Uint8Array>;
  if (entry.method === 0) {
    source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });
  } else if (entry.method === 8) {
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });
    source = input.pipeThrough(
      new DecompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
    );
  } else {
    throw new ZipError('unsupported_zip', `compression method ${entry.method} is not supported`);
  }
  let total = 0;
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > maxBytes) {
          controller.error(new ZipError('too_large', `entry ${entry.name} inflates beyond the limit`));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

/** Inflate a whole entry into memory (bounded by `maxBytes`). */
export async function readZipEntry(
  bytes: Uint8Array,
  entry: ZipEntry,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = openZipEntry(bytes, entry, maxBytes).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch (e) {
    if (e instanceof ZipError) throw e;
    throw new ZipError('corrupt', `entry ${entry.name} cannot be inflated`);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

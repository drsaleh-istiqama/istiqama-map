import { describe, expect, it } from 'vitest';
import * as XLSXNS from 'xlsx';
import { ZipEntryStream, ZipError, ZipWriter, crc32, isZip, readZipDirectory, readZipEntry } from './zip.ts';

const XLSX: typeof XLSXNS = (XLSXNS as unknown as { default?: typeof XLSXNS }).default ?? XLSXNS;

function join(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('crc32', () => {
  it('matches the reference value', () => {
    expect(crc32(text('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('can be continued over chunks', () => {
    expect(crc32(text('56789'), crc32(text('1234')))).toBe(0xcbf43926);
  });
});

describe('ZipWriter / reader round trip', () => {
  it('writes entries that the reader inflates again (UTF-8 names and content)', async () => {
    const zip = new ZipWriter();
    await zip.add('hello.txt', 'hello world');
    await zip.add('عربي/ملف.txt', 'مسجد ومدرسة '.repeat(500));
    const stream = new ZipEntryStream('big.bin');
    for (let i = 0; i < 20; i++) await stream.write(new Uint8Array(10_000).fill(i));
    await zip.addStream(stream);
    const { chunks, size } = zip.finish();
    const bytes = join(chunks);
    expect(bytes.byteLength).toBe(size);
    expect(isZip(bytes)).toBe(true);

    const entries = readZipDirectory(bytes);
    expect(entries.map((e) => e.name)).toEqual(['hello.txt', 'عربي/ملف.txt', 'big.bin']);
    expect(new TextDecoder().decode(await readZipEntry(bytes, entries[0]!, 1000))).toBe('hello world');
    expect(new TextDecoder().decode(await readZipEntry(bytes, entries[1]!, 1_000_000))).toBe(
      'مسجد ومدرسة '.repeat(500),
    );
    const big = await readZipEntry(bytes, entries[2]!, 1_000_000);
    expect(big.byteLength).toBe(200_000);
    expect(entries[2]!.size).toBe(200_000);
    expect(entries[2]!.compressedSize).toBeLessThan(5_000);
    expect(crc32(big)).toBe(entries[2]!.crc);
  });

  it('is readable by an independent implementation (SheetJS CFB)', async () => {
    const zip = new ZipWriter();
    await zip.add('a.txt', 'first');
    await zip.add('dir/b.txt', 'second');
    const bytes = join(zip.finish().chunks);
    const cfb = XLSX.CFB.read(bytes, { type: 'array' });
    const contentOf = (suffix: string): string => {
      const index = cfb.FullPaths.findIndex((p: string) => p.endsWith(suffix));
      expect(index, suffix).toBeGreaterThanOrEqual(0);
      return new TextDecoder().decode(
        new Uint8Array(cfb.FileIndex[index]!.content as unknown as ArrayLike<number>),
      );
    };
    expect(contentOf('a.txt')).toBe('first');
    expect(contentOf('dir/b.txt')).toBe('second');
  });
});

describe('reader limits', () => {
  it('rejects data that is not a ZIP archive', () => {
    expect(() => readZipDirectory(text('name,type\nx,y'))).toThrowError(ZipError);
    expect(isZip(text('PK'))).toBe(false);
  });

  it('stops inflating at the byte limit (decompression bomb)', async () => {
    const zip = new ZipWriter();
    const bomb = new ZipEntryStream('bomb.xml');
    const block = new Uint8Array(1_000_000); // zeros compress ~1000:1
    for (let i = 0; i < 20; i++) await bomb.write(block);
    await zip.addStream(bomb);
    const bytes = join(zip.finish().chunks);
    expect(bytes.byteLength).toBeLessThan(100_000);
    const [entry] = readZipDirectory(bytes);
    await expect(readZipEntry(bytes, entry!, 5_000_000)).rejects.toMatchObject({ code: 'too_large' });
    expect((await readZipEntry(bytes, entry!, 25_000_000)).byteLength).toBe(20_000_000);
  });

  it('refuses archives with too many entries', async () => {
    const zip = new ZipWriter();
    for (let i = 0; i < 12; i++) await zip.add(`f${i}.txt`, 'x');
    const bytes = join(zip.finish().chunks);
    expect(() => readZipDirectory(bytes, 10)).toThrowError(/too many entries/);
  });

  it('reports a truncated archive as corrupt', async () => {
    const zip = new ZipWriter();
    await zip.add('a.txt', 'content');
    const bytes = join(zip.finish().chunks);
    expect(() => readZipDirectory(bytes.subarray(0, bytes.byteLength - 10))).toThrowError(ZipError);
  });
});

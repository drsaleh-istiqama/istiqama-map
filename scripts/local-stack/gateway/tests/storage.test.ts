import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { fileEtag, streamToFile } from '../storage/files.ts';
import { multipartBoundary, parseMultipart } from '../storage/multipart.ts';
import {
  UnsafePathError,
  encodeSegment,
  isValidBucketId,
  isValidObjectName,
  objectFsPath,
} from '../storage/paths.ts';
import { parseRange } from '../storage/range.ts';
import {
  TUS_EXPIRY_MS,
  TusStore,
  checkPatch,
  isExpired,
  parseUploadMetadata,
} from '../storage/tus.ts';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-test-'));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

/** A request body as the handlers see it (a Readable with `complete`). */
function fakeRequest(chunks: Buffer[], opts: { abortAfter?: number } = {}): IncomingMessage {
  const stream = new Readable({ read() {} }) as Readable & { complete: boolean };
  stream.complete = false;
  setImmediate(() => {
    chunks.forEach((c, i) => {
      if (opts.abortAfter !== undefined && i >= opts.abortAfter) return;
      stream.push(c);
    });
    if (opts.abortAfter !== undefined) stream.emit('aborted');
    else {
      stream.complete = true;
      stream.push(null);
    }
  });
  return stream as unknown as IncomingMessage;
}

describe('path-traversal protection', () => {
  const root = path.join(tmpRoot, 'storage');

  it('accepts the photo layout of the brief', () => {
    const name =
      'projects/TZ/0199a5c8-7b1e-7c3a-9f10-2f6d3e8b1a11/0199a5c8-7b1e-7c3a-9f10-2f6d3e8b1a12_full.webp';
    expect(isValidObjectName(name)).toBe(true);
    expect(objectFsPath(root, 'photos', name)).toBe(path.join(root, 'photos', ...name.split('/')));
  });

  it.each([
    '../secret',
    'a/../../secret',
    'a/./b',
    'a//b',
    '/absolute',
    'trailing/',
    '..',
    'a\\..\\b',
    'nul\0byte',
    'tab\tname',
    'اسم-عربي.webp',
    '',
    'x'.repeat(1025),
  ])('rejects %j', (name) => {
    expect(isValidObjectName(name)).toBe(false);
    expect(() => objectFsPath(root, 'photos', name)).toThrow(UnsafePathError);
  });

  it('keeps every resolved path inside the storage root', () => {
    for (const name of [
      'a..b/c',
      '..a/b',
      'a/..b',
      'C:/Windows/system32',
      'con',
      'aux.txt',
      'name.',
      'what?*:x',
    ]) {
      expect(isValidObjectName(name)).toBe(true);
      const full = objectFsPath(root, 'imports', name);
      const rel = path.relative(root, full);
      expect(rel.startsWith('..')).toBe(false);
      expect(path.isAbsolute(rel)).toBe(false);
      expect(rel.split(path.sep)[0]).toBe('imports');
    }
  });

  it('encodes characters and names that Windows cannot store', () => {
    expect(encodeSegment('a:b?c*')).toBe('a%3Ab%3Fc%2A');
    expect(encodeSegment('name.')).toBe('name%2E');
    expect(encodeSegment('con')).toBe('%63on');
    expect(encodeSegment('plain-name_1.webp')).toBe('plain-name_1.webp');
  });

  it('validates bucket ids', () => {
    expect(isValidBucketId('photos')).toBe(true);
    for (const bad of ['', '..', '.tus', 'a/b', '../x']) expect(isValidBucketId(bad)).toBe(false);
    expect(() => objectFsPath(root, '..', 'x')).toThrow(UnsafePathError);
  });
});

describe('Range header', () => {
  it('no header or foreign unit → whole file', () => {
    expect(parseRange(undefined, 100)).toEqual({ kind: 'none' });
    expect(parseRange('items=0-5', 100)).toEqual({ kind: 'none' });
    expect(parseRange('bytes=abc', 100)).toEqual({ kind: 'none' });
    expect(parseRange('bytes=-', 100)).toEqual({ kind: 'none' });
  });
  it('closed, open-ended and suffix ranges', () => {
    expect(parseRange('bytes=0-0', 100)).toEqual({ kind: 'range', start: 0, end: 0 });
    expect(parseRange('bytes=10-19', 100)).toEqual({ kind: 'range', start: 10, end: 19 });
    expect(parseRange('bytes=90-', 100)).toEqual({ kind: 'range', start: 90, end: 99 });
    expect(parseRange('bytes=-16', 100)).toEqual({ kind: 'range', start: 84, end: 99 });
    expect(parseRange('Bytes = 5 - 9', 100)).toEqual({ kind: 'range', start: 5, end: 9 });
  });
  it('clamps the end and a too-long suffix', () => {
    expect(parseRange('bytes=50-500', 100)).toEqual({ kind: 'range', start: 50, end: 99 });
    expect(parseRange('bytes=-500', 100)).toEqual({ kind: 'range', start: 0, end: 99 });
  });
  it('unsatisfiable ranges', () => {
    expect(parseRange('bytes=100-', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=150-160', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=-0', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
  });
  it('ignores multi-range and inverted ranges', () => {
    expect(parseRange('bytes=0-1,5-6', 100)).toEqual({ kind: 'none' });
    expect(parseRange('bytes=9-5', 100)).toEqual({ kind: 'none' });
  });
});

describe('multipart/form-data', () => {
  it('reads the boundary parameter', () => {
    expect(multipartBoundary('multipart/form-data; boundary=----abc')).toBe('----abc');
    expect(multipartBoundary('multipart/form-data; boundary="x y"; charset=utf-8')).toBe('x y');
    expect(multipartBoundary('application/json')).toBeNull();
    expect(multipartBoundary(undefined)).toBeNull();
  });

  it('parses fields and a binary file part (what storage-js sends for a Blob)', () => {
    // binary content with CR LF, dashes and even "--B" in the middle of a line
    const file = Buffer.from([
      0x00, 0xff, 0x0d, 0x0a, 0x2d, 0x2d, 0x43, 0x0d, 0x0a, 0x01, 0x2d, 0x2d, 0x42, 0x0d, 0x0a,
    ]);
    const body = Buffer.concat([
      Buffer.from('--B\r\nContent-Disposition: form-data; name="cacheControl"\r\n\r\n3600\r\n'),
      Buffer.from('--B\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n{"a":1}\r\n'),
      Buffer.from(
        '--B\r\nContent-Disposition: form-data; name=""; filename="blob"\r\nContent-Type: image/webp\r\n\r\n',
      ),
      file,
      Buffer.from('\r\n--B--\r\n'),
    ]);
    const parts = parseMultipart(body, 'B');
    expect(parts.map((p) => p.name)).toEqual(['cacheControl', 'metadata', '']);
    expect(parts[0]!.data.toString()).toBe('3600');
    expect(parts[2]!.filename).toBe('blob');
    expect(parts[2]!.contentType).toBe('image/webp');
    expect(parts[2]!.data.equals(file)).toBe(true);
  });

  it('returns nothing for a body without the boundary', () => {
    expect(parseMultipart(Buffer.from('garbage'), 'B')).toEqual([]);
  });
});

describe('TUS protocol helpers', () => {
  const b64 = (s: string): string => Buffer.from(s).toString('base64');

  it('parses Upload-Metadata', () => {
    const md = parseUploadMetadata(
      `bucketName ${b64('photos')},objectName ${b64('projects/TZ/a/b_full.webp')}, contentType ${b64('image/webp')},cacheControl ${b64('3600')},flag`,
    );
    expect(md).toEqual({
      bucketName: 'photos',
      objectName: 'projects/TZ/a/b_full.webp',
      contentType: 'image/webp',
      cacheControl: '3600',
      flag: '',
    });
    expect(parseUploadMetadata(undefined)).toEqual({});
    expect(parseUploadMetadata('bucketName ***')).toEqual({});
  });

  it('PATCH offset rules', () => {
    const upload = { length: 1000, completed: false };
    const ok = {
      contentType: 'application/offset+octet-stream',
      uploadOffset: '400',
      contentLength: '600',
    };
    expect(checkPatch(upload, 400, ok)).toEqual({ ok: true });
    expect(
      checkPatch(upload, 400, { ...ok, contentType: 'application/octet-stream' }),
    ).toMatchObject({ ok: false, status: 415 });
    expect(checkPatch(upload, 400, { ...ok, contentType: undefined })).toMatchObject({
      ok: false,
      status: 415,
    });
    expect(checkPatch(upload, 400, { ...ok, uploadOffset: undefined })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(checkPatch(upload, 400, { ...ok, uploadOffset: '-1' })).toMatchObject({
      ok: false,
      status: 400,
    });
    // the client is behind (lost response) or ahead of the server
    expect(checkPatch(upload, 400, { ...ok, uploadOffset: '0' })).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(checkPatch(upload, 400, { ...ok, uploadOffset: '500' })).toMatchObject({
      ok: false,
      status: 409,
    });
    // more bytes than declared
    expect(checkPatch(upload, 400, { ...ok, contentLength: '601' })).toMatchObject({
      ok: false,
      status: 413,
    });
    // chunked transfer without Content-Length is fine
    expect(checkPatch(upload, 400, { ...ok, contentLength: undefined })).toEqual({ ok: true });
    // content type parameters are tolerated
    expect(
      checkPatch(upload, 0, {
        contentType: 'application/offset+octet-stream; charset=binary',
        uploadOffset: '0',
      }),
    ).toEqual({ ok: true });
  });

  it('expiry', () => {
    expect(isExpired({ expiresAt: 1000 }, 999)).toBe(false);
    expect(isExpired({ expiresAt: 1000 }, 1000)).toBe(true);
  });
});

describe('TusStore (state on disk)', () => {
  const dir = path.join(tmpRoot, 'tus-store');
  const base = {
    bucket: 'photos',
    name: 'projects/TZ/a/b_full.webp',
    length: 10,
    contentType: 'image/webp',
    cacheControl: 'max-age=3600',
    userMetadata: null,
    upsert: false,
    ownerId: 'user-1',
    ownerRole: 'authenticated',
  };

  it('the offset is the number of bytes on disk and survives a new store instance (restart)', async () => {
    const store = new TusStore(dir);
    const upload = await store.create(base, 1_000_000);
    expect(TusStore.isValidId(upload.id)).toBe(true);
    expect(upload.expiresAt).toBe(1_000_000 + TUS_EXPIRY_MS);
    expect(await store.offset(upload)).toBe(0);

    const first = await store.append(
      upload.id,
      fakeRequest([Buffer.from('abcd'), Buffer.from('ef')]),
      10,
    );
    expect(first).toMatchObject({ written: 6, aborted: false, overflow: false });

    const restarted = new TusStore(dir);
    const again = await restarted.get(upload.id);
    expect(again).toMatchObject({ bucket: 'photos', length: 10, ownerId: 'user-1' });
    expect(await restarted.offset(again!)).toBe(6);

    const second = await restarted.append(upload.id, fakeRequest([Buffer.from('ghij')]), 10 - 6);
    expect(second.written).toBe(4);
    expect(fs.readFileSync(restarted.binPath(upload.id), 'utf8')).toBe('abcdefghij');
  });

  it('keeps the bytes of an interrupted chunk', async () => {
    const store = new TusStore(dir);
    const upload = await store.create(base);
    const r = await store.append(
      upload.id,
      fakeRequest([Buffer.from('123'), Buffer.from('456'), Buffer.from('789')], { abortAfter: 2 }),
      10,
    );
    expect(r).toMatchObject({ written: 6, aborted: true });
    expect(await store.offset(upload)).toBe(6);
  });

  it('never writes beyond the declared length', async () => {
    const store = new TusStore(dir);
    const upload = await store.create(base);
    const r = await store.append(
      upload.id,
      fakeRequest([Buffer.from('12345'), Buffer.from('67890X')]),
      10,
    );
    expect(r.overflow).toBe(true);
    expect(await store.offset(upload)).toBeLessThanOrEqual(10);
  });

  it('one writer at a time', async () => {
    const store = new TusStore(dir);
    expect(store.lock('x')).toBe(true);
    expect(store.lock('x')).toBe(false);
    store.unlock('x');
    expect(store.lock('x')).toBe(true);
  });

  it('a completed upload leaves a tombstone until it expires; sweep removes expired state', async () => {
    const store = new TusStore(path.join(tmpRoot, 'tus-sweep'));
    const done = await store.create(base, 1000);
    await store.complete(done, 'object-id', 2000);
    expect(await store.offset((await store.get(done.id))!)).toBe(10);
    const fresh = await store.create(base, Date.now());
    expect(await store.sweep(1000 + TUS_EXPIRY_MS + 1)).toBe(1);
    expect(await store.get(done.id)).toBeNull();
    expect(await store.get(fresh.id)).not.toBeNull();
  });

  it('rejects ids that are not its own format', async () => {
    const store = new TusStore(dir);
    expect(await store.get('../../etc/passwd')).toBeNull();
    expect(await store.get('zz')).toBeNull();
  });
});

describe('file helpers', () => {
  it('streamToFile computes the MD5 and enforces the limit', async () => {
    const file = path.join(tmpRoot, 'stream.bin');
    const ok = await streamToFile(
      fakeRequest([Buffer.from('hello '), Buffer.from('world')]),
      file,
      { maxBytes: 100, md5: true },
    );
    expect(ok).toMatchObject({
      written: 11,
      aborted: false,
      overflow: false,
      md5: '5eb63bbbe01eeed093cb22bb8f5acdc3',
    });
    expect(await fileEtag(file, 11)).toBe('5eb63bbbe01eeed093cb22bb8f5acdc3');
    const big = await streamToFile(fakeRequest([Buffer.alloc(60), Buffer.alloc(60)]), file, {
      maxBytes: 100,
    });
    expect(big.overflow).toBe(true);
    expect(fs.statSync(file).size).toBeLessThanOrEqual(100);
  });
});

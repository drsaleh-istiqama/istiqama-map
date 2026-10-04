/**
 * The real tus-js-client driven through a fake HTTP stack that behaves like a TUS 1.0.0
 * server (creation-with-upload, HEAD, PATCH), so resume and error mapping are tested without
 * a network.
 */
import { describe, expect, it } from 'vitest';
import type { SyncError } from './errors';
import type { UploadRequest } from './ports';
import { createTusUploader, type TusUploaderDeps } from './tusUploader';

type HttpStack = NonNullable<TusUploaderDeps['httpStack']>;
type HttpRequest = ReturnType<HttpStack['createRequest']>;
type HttpResponse = Awaited<ReturnType<HttpRequest['send']>>;

const ENDPOINT = 'http://api.test/storage/v1/upload/resumable';

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  bytes: number;
}

interface StoredUpload {
  length: number;
  chunks: Buffer[];
  metadata: Record<string, string>;
}

class FakeTusServer implements HttpStack {
  readonly requests: Recorded[] = [];
  readonly uploads = new Map<string, StoredUpload>();
  /** Status to answer the next request with (once), instead of handling it. */
  refuseNext: { status: number; body?: string; headers?: Record<string, string> } | null = null;
  /** Keep only this many bytes of the next body, then drop the connection. */
  cutNextBodyAt: number | null = null;
  /** Runs before a request is handled. */
  onRequest: ((r: Recorded) => void | Promise<void>) | null = null;
  private seq = 0;

  getName(): string {
    return 'FakeTusServer';
  }

  received(url: string): Buffer {
    return Buffer.concat(this.uploads.get(url)?.chunks ?? []);
  }

  createRequest(method: string, url: string): HttpRequest {
    const headers: Record<string, string> = {};
    let aborted: ((e: Error) => void) | null = null;
    const request: HttpRequest = {
      getMethod: () => method,
      getURL: () => url,
      // XMLHttpRequest semantics (the browser stack of tus-js-client): setting a header twice
      // APPENDS the value ("a, b") instead of replacing it. A Node-style replace here hid a real
      // bug once (double Authorization → 403 "Invalid Compact JWS" in every browser upload).
      setHeader: (name, value) => {
        const key = name.toLowerCase();
        headers[key] = key in headers ? `${headers[key]}, ${value}` : value;
      },
      getHeader: (name) => headers[name.toLowerCase()],
      setProgressHandler: () => undefined,
      abort: async () => {
        aborted?.(new Error('request aborted'));
      },
      getUnderlyingObject: () => null,
      send: (body) =>
        new Promise<HttpResponse>((resolve, reject) => {
          aborted = reject;
          void this.handle(method, url, headers, body as Buffer | null | undefined).then(
            resolve,
            reject,
          );
        }),
    };
    return request;
  }

  private response(status: number, headers: Record<string, string> = {}, body = ''): HttpResponse {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      getStatus: () => status,
      getHeader: (name) => lower[name.toLowerCase()],
      getBody: () => body,
      getUnderlyingObject: () => null,
    };
  }

  private async handle(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: Buffer | null | undefined,
  ): Promise<HttpResponse> {
    const recorded: Recorded = {
      method,
      url,
      headers: { ...headers },
      bytes: body ? body.length : 0,
    };
    this.requests.push(recorded);
    await this.onRequest?.(recorded);
    await new Promise((r) => setTimeout(r, 1));
    if (this.refuseNext) {
      const { status, body: text, headers: extra } = this.refuseNext;
      this.refuseNext = null;
      return this.response(status, extra, text ?? '');
    }
    const accept = (upload: StoredUpload, data: Buffer | null | undefined): void => {
      if (!data || data.length === 0) return;
      if (this.cutNextBodyAt !== null) {
        const kept = data.subarray(0, this.cutNextBodyAt);
        this.cutNextBodyAt = null;
        upload.chunks.push(Buffer.from(kept));
        throw new Error('socket hang up');
      }
      upload.chunks.push(Buffer.from(data));
    };
    const offsetOf = (upload: StoredUpload): number =>
      upload.chunks.reduce((n, c) => n + c.length, 0);

    if (method === 'POST' && url === ENDPOINT) {
      const metadata = Object.fromEntries(
        (headers['upload-metadata'] ?? '').split(',').map((pair) => {
          const [key, value] = pair.split(' ');
          return [key, Buffer.from(value ?? '', 'base64').toString('utf8')];
        }),
      );
      const location = `${ENDPOINT}/${++this.seq}`;
      const upload: StoredUpload = {
        length: Number(headers['upload-length']),
        chunks: [],
        metadata,
      };
      this.uploads.set(location, upload);
      accept(upload, body);
      return this.response(201, {
        Location: location,
        'Upload-Offset': String(offsetOf(upload)),
        'Tus-Resumable': '1.0.0',
      });
    }
    const upload = this.uploads.get(url);
    if (!upload) return this.response(404, {}, 'upload not found');
    if (method === 'HEAD') {
      return this.response(200, {
        'Upload-Offset': String(offsetOf(upload)),
        'Upload-Length': String(upload.length),
      });
    }
    if (method === 'PATCH') {
      if (Number(headers['upload-offset']) !== offsetOf(upload))
        return this.response(409, {}, 'offset mismatch');
      accept(upload, body);
      return this.response(204, { 'Upload-Offset': String(offsetOf(upload)) });
    }
    return this.response(405);
  }
}

function payload(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(size));
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) % 251;
  return bytes;
}

function setup(overrides: Partial<TusUploaderDeps> = {}) {
  const server = new FakeTusServer();
  const tokens = ['tok-1'];
  const uploader = createTusUploader({
    supabaseUrl: 'http://api.test/',
    anonKey: 'anon-key',
    accessToken: async () => tokens[tokens.length - 1] ?? null,
    deviceId: () => 'device-a',
    httpStack: server,
    retryDelays: [],
    ...overrides,
  });
  return { server, uploader, tokens };
}

function request(bytes: Uint8Array<ArrayBuffer>, extra: Partial<UploadRequest> = {}) {
  const urls: string[] = [];
  const progress: number[] = [];
  const req: UploadRequest = {
    blob: new Blob([bytes], { type: 'image/webp' }),
    bucket: 'photos',
    objectName: 'projects/TZ/p/x_full.webp',
    contentType: 'image/webp',
    uploadUrl: null,
    onUploadUrl: (url) => urls.push(url),
    onProgress: (offset) => progress.push(offset),
    signal: new AbortController().signal,
    ...extra,
  };
  return { req, urls, progress };
}

async function failure(promise: Promise<unknown>): Promise<SyncError> {
  try {
    await promise;
  } catch (e) {
    return e as SyncError;
  }
  throw new Error('expected a rejection');
}

describe('tus uploader', () => {
  it('creates the upload with the Supabase headers and metadata and stores the bytes', async () => {
    const { server, uploader } = setup();
    const bytes = payload(1500);
    const { req, urls, progress } = request(bytes);
    await uploader.upload(req);

    expect(server.requests).toHaveLength(1);
    const [post] = server.requests;
    expect(post).toMatchObject({ method: 'POST', url: ENDPOINT, bytes: 1500 });
    expect(post!.headers).toMatchObject({
      authorization: 'Bearer tok-1',
      apikey: 'anon-key',
      'x-device-id': 'device-a',
      'x-upsert': 'true',
      'tus-resumable': '1.0.0',
      'upload-length': '1500',
    });
    const upload = server.uploads.get(urls[0]!)!;
    expect(upload.metadata).toEqual({
      bucketName: 'photos',
      objectName: 'projects/TZ/p/x_full.webp',
      contentType: 'image/webp',
      cacheControl: '3600',
    });
    expect(server.received(urls[0]!).equals(Buffer.from(bytes))).toBe(true);
    expect(urls).toEqual([`${ENDPOINT}/1`]);
    expect(progress.at(-1)).toBe(1500);
  });

  it('uploads in chunks', async () => {
    const { server, uploader } = setup({ chunkSize: 1000 });
    const bytes = payload(2500);
    const { req, urls, progress } = request(bytes);
    await uploader.upload(req);
    expect(server.requests.map((r) => [r.method, r.bytes])).toEqual([
      ['POST', 1000],
      ['PATCH', 1000],
      ['PATCH', 500],
    ]);
    expect(progress).toEqual([1000, 2000, 2500]);
    expect(server.received(urls[0]!).equals(Buffer.from(bytes))).toBe(true);
  });

  it('resumes from the offset the server reports, without re-sending stored bytes', async () => {
    const { server, uploader } = setup({ chunkSize: 1000 });
    const bytes = payload(2500);
    const first = request(bytes);
    // The connection dies during the second chunk; the server keeps 300 bytes of it.
    server.onRequest = (r) => {
      if (r.method === 'PATCH') server.cutNextBodyAt = 300;
    };
    const err = await failure(uploader.upload(first.req));
    expect(err.kind).toBe('network');
    expect(first.urls).toEqual([`${ENDPOINT}/1`]);
    expect(server.received(first.urls[0]!)).toHaveLength(1300);

    // After the "reload": a new uploader call with the stored URL.
    server.onRequest = null;
    const before = server.requests.length;
    const second = request(bytes, { uploadUrl: first.urls[0]! });
    await uploader.upload(second.req);
    const resumed = server.requests.slice(before);
    expect(resumed.map((r) => r.method)).toEqual(['HEAD', 'PATCH', 'PATCH']);
    expect(resumed[1]!.headers['upload-offset']).toBe('1300');
    expect(resumed.map((r) => r.bytes)).toEqual([0, 1000, 200]);
    expect(server.received(first.urls[0]!).equals(Buffer.from(bytes))).toBe(true);
    expect(server.uploads.size).toBe(1); // no second upload was created
  });

  it('starts a new upload when the stored URL expired on the server', async () => {
    const { server, uploader } = setup();
    const bytes = payload(800);
    const { req, urls } = request(bytes, { uploadUrl: `${ENDPOINT}/gone` });
    await uploader.upload(req);
    expect(server.requests.map((r) => r.method)).toEqual(['HEAD', 'POST']);
    expect(urls).toEqual([`${ENDPOINT}/1`]);
    expect(server.received(urls[0]!)).toHaveLength(800);
  });

  it.each([
    [401, '', 'unauthenticated'],
    [403, 'new row violates row-level security policy', 'forbidden'],
    [400, 'jwt expired', 'unauthenticated'],
    [413, 'too large', 'invalid'],
    [415, 'invalid_mime_type', 'invalid'],
    [429, 'slow down', 'rate_limited'],
    [503, 'unavailable', 'server'],
  ] as const)('maps HTTP %i to %s', async (status, body, kind) => {
    const { server, uploader } = setup();
    server.refuseNext = { status, body, headers: status === 429 ? { 'Retry-After': '10' } : {} };
    const err = await failure(uploader.upload(request(payload(10)).req));
    expect(err.kind).toBe(kind);
    expect(err.status).toBe(status);
    if (status === 429) expect(err.retryAfterMs).toBe(10_000);
  });

  it('retries a server error with the configured delays', async () => {
    const { server, uploader } = setup({ retryDelays: [0] });
    server.refuseNext = { status: 502 };
    const { req, urls } = request(payload(100));
    await uploader.upload(req);
    expect(server.requests.map((r) => r.method)).toEqual(['POST', 'POST']);
    expect(server.received(urls.at(-1)!)).toHaveLength(100);
  });

  it('refreshes the access token before every request', async () => {
    const { server, uploader, tokens } = setup({ chunkSize: 1000 });
    server.onRequest = (r) => {
      if (r.method === 'POST') tokens.push('tok-2');
    };
    await uploader.upload(request(payload(1500)).req);
    expect(server.requests.map((r) => r.headers.authorization)).toEqual([
      'Bearer tok-1',
      'Bearer tok-2',
    ]);
  });

  it('fails as unauthenticated without touching the network when there is no session', async () => {
    const { server, uploader } = setup({ accessToken: async () => null });
    const err = await failure(uploader.upload(request(payload(10)).req));
    expect(err.kind).toBe('unauthenticated');
    expect(server.requests).toHaveLength(0);
  });

  it('can be aborted in flight and keeps the upload on the server for a later resume', async () => {
    const { server, uploader } = setup({ chunkSize: 1000 });
    const controller = new AbortController();
    server.onRequest = (r) => {
      if (r.method === 'PATCH') controller.abort();
    };
    const { req, urls } = request(payload(2500), { signal: controller.signal });
    const err = await failure(uploader.upload(req));
    expect(err.kind).toBe('aborted');
    expect(urls).toHaveLength(1);
    expect(server.uploads.has(urls[0]!)).toBe(true); // not terminated
    expect(server.requests.some((r) => r.method === 'DELETE')).toBe(false);

    const already = new AbortController();
    already.abort();
    expect(
      (await failure(uploader.upload(request(payload(5), { signal: already.signal }).req))).kind,
    ).toBe('aborted');
  });
});

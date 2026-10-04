/**
 * A fake `fetch` serving files with HTTP Range support, with fault injection for the pack
 * download tests (dropped connection, hanging request, ignored Range header, corruption).
 */
export interface FakeServerOptions {
  /** Reply 200 with the whole file instead of 206 (a server without Range support). */
  ignoreRange?: boolean;
}

export interface ServedRequest {
  url: string;
  range: string | null;
}

export class FakeServer {
  readonly files = new Map<string, Uint8Array>();
  readonly requests: ServedRequest[] = [];
  /** Called before answering request number `n` (1-based); may throw or hang. */
  beforeAnswer: ((n: number, request: ServedRequest) => Promise<void> | void) | null = null;

  constructor(private readonly options: FakeServerOptions = {}) {}

  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    const request = { url, range: headers.get('range') };
    this.requests.push(request);
    const signal = init?.signal;
    signal?.throwIfAborted();
    if (this.beforeAnswer) {
      await Promise.race([
        this.beforeAnswer(this.requests.length, request),
        new Promise<never>((_, reject) => {
          signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          );
        }),
      ]);
    }
    const file = this.files.get(url);
    if (!file) return new Response('not found', { status: 404 });
    const m = request.range ? /^bytes=(\d+)-(\d+)?$/.exec(request.range) : null;
    if (!m || this.options.ignoreRange) {
      return new Response(file.slice(), {
        status: 200,
        headers: { 'content-length': String(file.length) },
      });
    }
    const start = Number(m[1]);
    const end = Math.min(m[2] === undefined ? file.length - 1 : Number(m[2]), file.length - 1);
    if (start >= file.length) return new Response(null, { status: 416 });
    const body = file.slice(start, end + 1);
    return new Response(body, {
      status: 206,
      headers: {
        'content-range': `bytes ${start}-${end}/${file.length}`,
        'content-length': String(body.length),
      },
    });
  };
}

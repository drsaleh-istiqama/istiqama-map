/**
 * Resumable uploads to Supabase Storage with tus-js-client (docs/contracts/local-gateway.md §2).
 *
 * tus-js-client is loaded on demand: it is needed only when a photo is waiting, so it stays
 * out of the entry chunk. Its own fingerprint store (localStorage) is switched off — the
 * photo queue persists the upload URL in IndexedDB instead.
 */
// Type-only: erased at build time, so tus-js-client stays out of the entry chunk.
import type * as TusModule from 'tus-js-client';
import { SyncError, type SyncErrorKind } from './errors';
import type { ResumableUploader, UploadRequest } from './ports';

/** Real Supabase Storage requires exactly 6 MB chunks (the last one may be smaller). */
export const TUS_CHUNK_SIZE = 6 * 1024 * 1024;

type Tus = typeof TusModule;
type TusOptions = NonNullable<ConstructorParameters<Tus['Upload']>[1]>;
type TusError = Parameters<NonNullable<TusOptions['onError']>>[0];

export interface TusUploaderDeps {
  supabaseUrl: string;
  anonKey: string;
  /** Returns a currently valid access token (refreshed when necessary). */
  accessToken(): Promise<string | null>;
  deviceId(): string;
  chunkSize?: number;
  /** Delays between tus-js-client's own retries of one request. */
  retryDelays?: number[];
  /** Test hooks. */
  loadTus?: () => Promise<Tus>;
  httpStack?: TusOptions['httpStack'];
}

function kindForStatus(status: number): SyncErrorKind {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404 || status === 410) return 'not_found';
  if (status === 409 || status === 423) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  if (status >= 400) return 'invalid';
  return 'unknown';
}

/** Map a tus-js-client failure to a typed error (exported for tests). */
export function mapTusError(error: TusError): SyncError {
  const response = 'originalResponse' in error ? error.originalResponse : null;
  if (!response) return new SyncError('network', `upload: ${error.message}`, { cause: error });
  const status = response.getStatus();
  const body = (response.getBody() ?? '').slice(0, 200);
  // An expired/invalid token is reported by Storage as 400/403 with a JWT message.
  const kind =
    /jwt|token.*expired|invalid.*token/i.test(body) && status < 500
      ? 'unauthenticated'
      : kindForStatus(status);
  const retryAfter = Number(response.getHeader('Retry-After'));
  return new SyncError(kind, `upload: HTTP ${status} ${body}`.trim(), {
    status,
    cause: error,
    retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
  });
}

export function createTusUploader(deps: TusUploaderDeps): ResumableUploader {
  const endpoint = `${deps.supabaseUrl.replace(/\/+$/, '')}/storage/v1/upload/resumable`;
  const loadTus = deps.loadTus ?? (() => import('tus-js-client'));

  return {
    async upload(req: UploadRequest): Promise<void> {
      if (req.signal.aborted) throw new SyncError('aborted', 'upload aborted');
      const token = await deps.accessToken();
      if (!token) throw new SyncError('unauthenticated', 'upload: no session');
      const tus = await loadTus();
      // The Node build of tus-js-client (unit/integration tests) reads Buffers, the browser build Blobs.
      const nodeBuild = tus.defaultOptions.httpStack.getName() === 'NodeHttpStack';
      const NodeBuffer = (globalThis as { Buffer?: { from(data: ArrayBuffer): unknown } }).Buffer;
      const input = (
        nodeBuild && NodeBuffer ? NodeBuffer.from(await req.blob.arrayBuffer()) : req.blob
      ) as Blob;

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (err?: SyncError): void => {
          if (settled) return;
          settled = true;
          req.signal.removeEventListener('abort', onAbort);
          if (err) reject(err);
          else resolve();
        };
        const options: TusOptions = {
          endpoint,
          uploadUrl: req.uploadUrl,
          chunkSize: deps.chunkSize ?? TUS_CHUNK_SIZE,
          retryDelays: deps.retryDelays ?? [0, 1500, 4000],
          uploadDataDuringCreation: true,
          storeFingerprintForResuming: false,
          removeFingerprintOnSuccess: true,
          headers: {
            authorization: `Bearer ${token}`,
            apikey: deps.anonKey,
            'x-device-id': deps.deviceId(),
            // Re-sending an object whose upload finished but was not recorded must not fail.
            'x-upsert': 'true',
          },
          metadata: {
            bucketName: req.bucket,
            objectName: req.objectName,
            contentType: req.contentType,
            cacheControl: '3600',
          },
          // Every TUS request is authenticated; long uploads outlive the access token.
          onBeforeRequest: async (request) => {
            const fresh = await deps.accessToken();
            if (fresh) request.setHeader('authorization', `Bearer ${fresh}`);
          },
          onUploadUrlAvailable: () => {
            if (upload.url) req.onUploadUrl(upload.url);
          },
          onChunkComplete: (_chunk, accepted, total) => req.onProgress(accepted, total),
          onShouldRetry: (error) => {
            if (req.signal.aborted) return false;
            const status = error.originalResponse ? error.originalResponse.getStatus() : 0;
            // Network failures, server errors, offset conflicts and locks are worth another try.
            return status === 0 || status >= 500 || status === 409 || status === 423;
          },
          onError: (error) => finish(mapTusError(error)),
          onSuccess: () => finish(),
        };
        if (deps.httpStack !== undefined) options.httpStack = deps.httpStack;
        const upload = new tus.Upload(input, options);
        const onAbort = (): void => {
          // Keep the upload on the server (no termination): it is resumed from its URL later.
          void upload.abort(false).catch(() => undefined);
          finish(new SyncError('aborted', 'upload aborted'));
        };
        req.signal.addEventListener('abort', onAbort, { once: true });
        upload.start();
      });
    },
  };
}

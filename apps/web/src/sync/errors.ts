/**
 * Typed failures of the sync layer. Every network/RPC failure is normalised to a
 * `SyncError` so that push/pull/engine can decide between "retry the same batch",
 * "back off", "stop and sign out" and "surface to the user" without looking at HTTP details.
 */

export type SyncErrorKind =
  /** fetch failed: no connectivity, DNS, connection reset, CORS… Retry later. */
  | 'network'
  /** The request was aborted by our timeout. Retry later (push is idempotent). */
  | 'timeout'
  /** Cancelled on purpose (stopSync, sign-out, offline). Not an error for the user. */
  | 'aborted'
  /** 401 / PT401: no or expired JWT. Needs a new sign-in; local data is kept. */
  | 'unauthenticated'
  /** 403 / PT403 `session_revoked`: wipe local data and sign out. */
  | 'session_revoked'
  /** Any other 403. */
  | 'forbidden'
  /** 404 / PT404. */
  | 'not_found'
  /** 409 / PT409. */
  | 'conflict'
  /** 422 / PT422 (and other 4xx): the call itself is malformed; retrying does not help. */
  | 'invalid'
  /** 429 / PT429. Back off, then retry. */
  | 'rate_limited'
  /** 5xx, serialization failure, deadlock, lock/statement timeout. Back off, then retry. */
  | 'server'
  /** The server answered 2xx with a body we do not understand. Treated as retryable. */
  | 'bad_response'
  /** IndexedDB refused to store data (QuotaExceededError). */
  | 'storage_full'
  | 'unknown';

export interface SyncErrorInit {
  status?: number;
  code?: string;
  retryAfterMs?: number;
  cause?: unknown;
}

const RETRYABLE: ReadonlySet<SyncErrorKind> = new Set<SyncErrorKind>([
  'network',
  'timeout',
  'rate_limited',
  'server',
  'bad_response',
]);

export class SyncError extends Error {
  readonly kind: SyncErrorKind;
  /** HTTP status (0 when the request never got an answer). */
  readonly status: number;
  /** SQLSTATE / PostgREST / gateway code when the server sent one. */
  readonly code: string;
  /** Server hint (Retry-After) in milliseconds, when known. */
  readonly retryAfterMs: number | undefined;

  constructor(kind: SyncErrorKind, message: string, init: SyncErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'SyncError';
    this.kind = kind;
    this.status = init.status ?? 0;
    this.code = init.code ?? '';
    this.retryAfterMs = init.retryAfterMs;
  }

  /** True when sending the very same request again later can succeed. */
  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }

  /** True when the session is unusable and the engine must stop. */
  get fatalForSession(): boolean {
    return this.kind === 'unauthenticated' || this.kind === 'session_revoked';
  }
}

export function isSyncError(e: unknown): e is SyncError {
  return e instanceof SyncError;
}

function errorName(e: unknown): string {
  return typeof e === 'object' && e !== null && 'name' in e ? String((e as { name: unknown }).name) : '';
}

/** DOMException names browsers use when the origin's storage quota is exhausted. */
export function isQuotaError(e: unknown): boolean {
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && cur !== null && cur !== undefined; depth++) {
    const name = errorName(cur);
    if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
    // Dexie wraps the DOMException: { name: 'AbortError' | 'QuotaExceededError', inner: DOMException }
    const inner = (cur as { inner?: unknown; cause?: unknown }).inner ?? (cur as { cause?: unknown }).cause;
    if (inner === cur) break;
    cur = inner;
  }
  return false;
}

/** Normalise anything thrown inside the sync layer. */
export function toSyncError(e: unknown): SyncError {
  if (e instanceof SyncError) return e;
  if (isQuotaError(e)) return new SyncError('storage_full', 'local storage quota exceeded', { cause: e });
  const name = errorName(e);
  const message = e instanceof Error ? e.message : String(e);
  if (name === 'AbortError') return new SyncError('aborted', message || 'aborted', { cause: e });
  if (name === 'TimeoutError') return new SyncError('timeout', message || 'timeout', { cause: e });
  if (name === 'TypeError' && /fetch|network|load failed/i.test(message)) {
    return new SyncError('network', message, { cause: e });
  }
  return new SyncError('unknown', message || 'unknown error', { cause: e });
}

/** Locale key (namespace `sync`) describing a failure to the user. */
export function errorKey(e: unknown): string {
  const kind = toSyncError(e).kind;
  switch (kind) {
    case 'network':
      return 'sync.error_network';
    case 'timeout':
      return 'sync.error_timeout';
    case 'unauthenticated':
      return 'sync.error_auth';
    case 'session_revoked':
      return 'sync.error_revoked';
    case 'forbidden':
      return 'sync.error_forbidden';
    case 'rate_limited':
      return 'sync.error_rate_limited';
    case 'server':
    case 'bad_response':
      return 'sync.error_server';
    case 'storage_full':
      return 'sync.error_storage_full';
    case 'invalid':
    case 'conflict':
    case 'not_found':
      return 'sync.error_invalid';
    case 'aborted':
    case 'unknown':
    default:
      return 'sync.error_unknown';
  }
}

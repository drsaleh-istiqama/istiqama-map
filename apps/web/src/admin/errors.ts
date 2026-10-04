/**
 * One error type for the three server paths of the console — RPCs through the sync
 * transport (`SyncError`), the `admin` Edge Function and direct PostgREST writes — and the
 * translation of any of them into a locale key of the `admin` namespace.
 */
import { isSyncError } from '../sync';

export type AdminErrorKind =
  | 'network'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'invalid'
  | 'rate_limited'
  | 'server'
  | 'unknown';

export class AdminError extends Error {
  readonly kind: AdminErrorKind;
  /** Short server code (`last_hq_admin`, `23505`, `stale`, …) or ''. */
  readonly code: string;
  readonly status: number;

  constructor(kind: AdminErrorKind, code: string, status = 0, message?: string) {
    super(message ?? (code || kind));
    this.name = 'AdminError';
    this.kind = kind;
    this.code = code;
    this.status = status;
  }
}

export function isAdminError(e: unknown): e is AdminError {
  return e instanceof AdminError;
}

export function kindForStatus(status: number): AdminErrorKind {
  if (status === 0) return 'network';
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  if (status >= 400) return 'invalid';
  return 'unknown';
}

/** Server codes of people-admin.md §0 and the admin function that have their own text. */
const KNOWN_CODES = new Set([
  'forbidden',
  'mfa_required',
  'not_authenticated',
  'session_revoked',
  'user_not_found',
  'role_not_found',
  'device_not_found',
  'last_hq_admin',
  'cannot_deactivate_self',
  'invalid_role_scope',
  'invalid_scope',
  'invalid_argument',
  'invalid_device_id',
  'rate_limited',
  'user_exists',
  'stale',
  'duplicate',
  'check_failed',
  'reference',
  'offline',
]);

/** PostgreSQL SQLSTATEs of direct writes → our short code. */
const SQLSTATE_CODES: Record<string, string> = {
  '23505': 'duplicate',
  '23514': 'check_failed',
  '23503': 'reference',
  '23502': 'check_failed',
  '22P02': 'check_failed',
  '42501': 'forbidden',
};

/** A PostgREST error object (`{ code, message, details, hint }`) of a direct table call. */
export function restError(
  error: { code?: string | null; message?: string | null } | null | undefined,
  status: number,
): AdminError {
  const code = error?.code ?? '';
  const message = error?.message ?? '';
  const mapped = SQLSTATE_CODES[code];
  if (mapped)
    return new AdminError(
      mapped === 'forbidden' ? 'forbidden' : 'invalid',
      mapped,
      status,
      message,
    );
  if (/^PT\d{3}$/.test(code)) {
    const http = Number(code.slice(2));
    return new AdminError(
      kindForStatus(http),
      /^[a-z_]+$/.test(message) ? message : '',
      http,
      message,
    );
  }
  if (/^PGRST30[0-3]$/.test(code))
    return new AdminError('unauthenticated', 'not_authenticated', 401, message);
  if (status === 0 || /fetch|network/i.test(message))
    return new AdminError('network', '', 0, message);
  return new AdminError(kindForStatus(status), '', status, message);
}

/** The JSON body of an `admin` function answer ≥ 400 (`{ code, message, details, hint }`). */
export function functionError(status: number, body: unknown): AdminError {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const message = typeof record.message === 'string' ? record.message : '';
  const code = typeof record.code === 'string' ? record.code : '';
  const short = /^[a-z_]+$/.test(message) ? message : '';
  if (SQLSTATE_CODES[code])
    return new AdminError('invalid', SQLSTATE_CODES[code] as string, status, message);
  return new AdminError(kindForStatus(status), short, status, message || code);
}

function codeOf(e: unknown): { code: string; kind: string } {
  if (isAdminError(e)) return { code: e.code, kind: e.kind };
  if (isSyncError(e)) {
    // The transport keeps the server's `message` in the error text as `<fn>: <code>`.
    const code = e.message.split(': ').pop() ?? '';
    return { code: /^[a-z_]+$/.test(code) ? code : '', kind: e.kind };
  }
  return { code: '', kind: 'unknown' };
}

/** Locale key (namespace `admin`) describing a failed administration call. */
export function adminErrorKey(e: unknown): string {
  const { code, kind } = codeOf(e);
  if (code && KNOWN_CODES.has(code)) return `admin.err_${code}`;
  switch (kind) {
    case 'network':
    case 'timeout':
    case 'aborted':
      return 'admin.err_network';
    case 'unauthenticated':
      return 'admin.err_not_authenticated';
    case 'session_revoked':
      return 'admin.err_session_revoked';
    case 'forbidden':
      return 'admin.err_forbidden';
    case 'rate_limited':
      return 'admin.err_rate_limited';
    case 'not_found':
      return 'admin.err_not_found';
    case 'conflict':
      return 'admin.err_stale';
    case 'invalid':
      return 'admin.err_invalid';
    case 'server':
    case 'bad_response':
      return 'admin.err_server';
    default:
      return 'admin.err_unknown';
  }
}

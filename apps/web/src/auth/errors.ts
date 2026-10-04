/**
 * Friendly authentication errors.
 *
 * Every failure of a sign-in / PIN / MFA flow is turned into an `AuthFlowError` whose `key` is a
 * locale key of the `auth` namespace (views show `t(error.key)`), so no English server message
 * ever reaches the user. Classification uses duck typing on purpose: this module must not pull
 * supabase-js into a chunk by itself and must stay trivially testable.
 */
export type AuthErrorKind =
  | 'offline'
  | 'rate_limited'
  | 'unknown_user'
  | 'code_invalid'
  | 'invalid_email'
  | 'invalid_phone'
  | 'account_disabled'
  | 'sms_failed'
  | 'mfa_code_invalid'
  | 'mfa_challenge_expired'
  | 'pin_invalid'
  | 'pin_weak'
  | 'pin_mismatch'
  | 'pin_locked'
  | 'no_session'
  | 'storage'
  | 'insecure_context'
  | 'generic';

export class AuthFlowError extends Error {
  readonly kind: AuthErrorKind;
  /** Locale key, e.g. `auth.error_rate_limited`. */
  readonly key: string;

  constructor(kind: AuthErrorKind, cause?: unknown) {
    super(kind, cause === undefined ? undefined : { cause });
    this.name = 'AuthFlowError';
    this.kind = kind;
    this.key = `auth.error_${kind}`;
  }
}

interface ErrorLike {
  name?: unknown;
  status?: unknown;
  code?: unknown;
  message?: unknown;
}

function asErrorLike(error: unknown): ErrorLike {
  return typeof error === 'object' && error !== null ? (error as ErrorLike) : {};
}

function browserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

const UNKNOWN_USER_CODES = new Set(['otp_disabled', 'user_not_found', 'signup_disabled']);
const BAD_CODE_CODES = new Set(['otp_expired', 'invalid_credentials', 'bad_code_verifier']);
const MFA_CODE_CODES = new Set(['mfa_verification_failed', 'mfa_verification_rejected']);
const MFA_EXPIRED_CODES = new Set(['mfa_challenge_expired', 'mfa_factor_not_found']);

/** Maps anything thrown/returned by supabase-js, WebCrypto or IndexedDB to an AuthFlowError. */
export function toFlowError(error: unknown): AuthFlowError {
  if (error instanceof AuthFlowError) return error;
  const e = asErrorLike(error);
  const name = typeof e.name === 'string' ? e.name : '';
  const code = typeof e.code === 'string' ? e.code : '';
  const status = typeof e.status === 'number' ? e.status : undefined;
  const message = typeof e.message === 'string' ? e.message : '';

  if (message === 'insecure_context') return new AuthFlowError('insecure_context', error);
  if (
    message.startsWith('indexeddb_') ||
    name === 'QuotaExceededError' ||
    name === 'InvalidStateError'
  ) {
    return new AuthFlowError('storage', error);
  }
  // Network failures: supabase-js wraps fetch rejections and 502/503/504 as retryable errors.
  if (
    name === 'AuthRetryableFetchError' ||
    status === 0 ||
    (name === 'TypeError' && /fetch|network|load failed/i.test(message)) ||
    (status === undefined && code === '' && browserOffline())
  ) {
    return new AuthFlowError('offline', error);
  }
  if (status === 429 || /^over_.*rate_limit$/.test(code))
    return new AuthFlowError('rate_limited', error);
  if (UNKNOWN_USER_CODES.has(code)) return new AuthFlowError('unknown_user', error);
  if (BAD_CODE_CODES.has(code)) return new AuthFlowError('code_invalid', error);
  if (MFA_CODE_CODES.has(code)) return new AuthFlowError('mfa_code_invalid', error);
  if (MFA_EXPIRED_CODES.has(code)) return new AuthFlowError('mfa_challenge_expired', error);
  if (code === 'user_banned') return new AuthFlowError('account_disabled', error);
  if (code === 'sms_send_failed') return new AuthFlowError('sms_failed', error);
  if (code === 'email_address_invalid') return new AuthFlowError('invalid_email', error);
  if (
    name === 'AuthSessionMissingError' ||
    code === 'session_not_found' ||
    code === 'session_expired'
  ) {
    return new AuthFlowError('no_session', error);
  }
  return new AuthFlowError('generic', error);
}

/** PostgREST error of an RPC refused because the session or device was revoked (authz contract). */
export function isSessionRevokedError(error: unknown): boolean {
  const e = asErrorLike(error);
  return (
    e.code === 'PT403' && typeof e.message === 'string' && e.message.includes('session_revoked')
  );
}

/** True for failures that mean "no connectivity / server unreachable" rather than a refusal. */
export function isNetworkError(error: unknown): boolean {
  return toFlowError(error).kind === 'offline';
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuthFlowError,
  isNetworkError,
  isSessionRevokedError,
  toFlowError,
  type AuthErrorKind,
} from './errors';

/** Shapes as supabase-js produces them (AuthApiError: name, status, code, message). */
function apiError(status: number, code: string, message = code) {
  return Object.assign(new Error(message), { name: 'AuthApiError', status, code });
}

describe('friendly auth errors', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const table: Array<[string, unknown, AuthErrorKind]> = [
    ['e-mail rate limit', apiError(429, 'over_email_send_rate_limit'), 'rate_limited'],
    ['SMS rate limit', apiError(429, 'over_sms_send_rate_limit'), 'rate_limited'],
    ['request rate limit', apiError(429, 'over_request_rate_limit'), 'rate_limited'],
    ['any 429', apiError(429, ''), 'rate_limited'],
    ['unknown user (OTP without sign-up)', apiError(422, 'otp_disabled'), 'unknown_user'],
    ['unknown user (sign-ups off)', apiError(422, 'signup_disabled'), 'unknown_user'],
    ['user not found', apiError(404, 'user_not_found'), 'unknown_user'],
    ['wrong or expired code', apiError(403, 'otp_expired'), 'code_invalid'],
    ['wrong password (dev helper)', apiError(400, 'invalid_credentials'), 'code_invalid'],
    ['banned account', apiError(400, 'user_banned'), 'account_disabled'],
    ['SMS provider failure', apiError(500, 'sms_send_failed'), 'sms_failed'],
    ['invalid e-mail', apiError(400, 'email_address_invalid'), 'invalid_email'],
    ['wrong TOTP code', apiError(422, 'mfa_verification_failed'), 'mfa_code_invalid'],
    ['expired MFA challenge', apiError(422, 'mfa_challenge_expired'), 'mfa_challenge_expired'],
    [
      'no session',
      Object.assign(new Error('Auth session missing!'), {
        name: 'AuthSessionMissingError',
        status: 400,
      }),
      'no_session',
    ],
    [
      'retryable fetch error (server unreachable)',
      Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError', status: 0 }),
      'offline',
    ],
    ['raw fetch failure', new TypeError('Failed to fetch'), 'offline'],
    ['insecure context', new Error('insecure_context'), 'insecure_context'],
    ['IndexedDB unavailable', new Error('indexeddb_unavailable'), 'storage'],
    ['quota exceeded', Object.assign(new Error('full'), { name: 'QuotaExceededError' }), 'storage'],
    ['anything else', apiError(500, 'unexpected_failure'), 'generic'],
    ['a string', 'boom', 'generic'],
    ['undefined', undefined, 'generic'],
  ];

  for (const [name, error, kind] of table) {
    it(`${name} → ${kind}`, () => {
      const flow = toFlowError(error);
      expect(flow).toBeInstanceOf(AuthFlowError);
      expect(flow.kind).toBe(kind);
      expect(flow.key).toBe(`auth.error_${kind}`);
    });
  }

  it('keeps an AuthFlowError as it is and remembers the cause', () => {
    const original = new AuthFlowError('pin_weak');
    expect(toFlowError(original)).toBe(original);
    const cause = apiError(403, 'otp_expired');
    expect(toFlowError(cause).cause).toBe(cause);
  });

  it('treats an unclassified failure as "offline" when the browser reports no connection', () => {
    vi.stubGlobal('navigator', { onLine: false });
    expect(toFlowError(new Error('something odd')).kind).toBe('offline');
    // A real answer from the server is still reported as what it is.
    expect(toFlowError(apiError(403, 'otp_expired')).kind).toBe('code_invalid');
  });

  it('isNetworkError separates "could not reach the server" from a refusal', () => {
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isNetworkError(apiError(400, 'refresh_token_not_found'))).toBe(false);
  });

  it('recognises a revoked session reported by an RPC', () => {
    expect(
      isSessionRevokedError({ code: 'PT403', message: 'session_revoked', details: null }),
    ).toBe(true);
    expect(isSessionRevokedError({ code: 'PT403', message: 'forbidden' })).toBe(false);
    expect(isSessionRevokedError({ code: 'PT401', message: 'not_authenticated' })).toBe(false);
    expect(isSessionRevokedError(null)).toBe(false);
  });
});

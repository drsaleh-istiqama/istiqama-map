/**
 * GoTrue error responses.
 *
 * GoTrue answers in one of two shapes depending on the `X-Supabase-Api-Version` request header
 * (supabase-js sends 2024-01-01):
 *   legacy          { "code": 403, "error_code": "otp_expired", "msg": "…" }
 *   >= 2024-01-01   { "code": "otp_expired", "message": "…" }  + the version header echoed back
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { header, sendJson } from '../http.ts';

export class AuthError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public headers: Record<string, string | number> = {},
  ) {
    super(message);
  }
}

const API_VERSION_2024 = '2024-01-01';

function usesNewErrorFormat(req: IncomingMessage): boolean {
  const v = header(req, 'x-supabase-api-version');
  return v !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(v) && v >= API_VERSION_2024;
}

export function sendAuthError(req: IncomingMessage, res: ServerResponse, err: AuthError): void {
  if (usesNewErrorFormat(req)) {
    sendJson(
      res,
      err.status,
      { code: err.code, message: err.message },
      { 'x-supabase-api-version': API_VERSION_2024, ...err.headers },
    );
  } else {
    sendJson(
      res,
      err.status,
      { code: err.status, error_code: err.code, msg: err.message },
      err.headers,
    );
  }
}

export const errors = {
  noAuthorization: () =>
    new AuthError(401, 'no_authorization', 'This endpoint requires a Bearer token'),
  badJwt: (detail: string) =>
    new AuthError(403, 'bad_jwt', `invalid JWT: unable to parse or verify signature, ${detail}`),
  missingSub: () => new AuthError(403, 'bad_jwt', 'invalid claim: missing sub claim'),
  userNotFoundFromJwt: () =>
    new AuthError(403, 'user_not_found', 'User from sub claim in JWT does not exist'),
  sessionNotFound: () =>
    new AuthError(403, 'session_not_found', 'Session from session_id claim in JWT does not exist'),
  notAdmin: () => new AuthError(403, 'not_admin', 'User not allowed'),
  validation: (msg: string) => new AuthError(400, 'validation_failed', msg),
  badJson: () => new AuthError(400, 'bad_json', 'Could not parse request body as JSON'),
  otpDisabled: () => new AuthError(422, 'otp_disabled', 'Signups not allowed for otp'),
  signupDisabled: () =>
    new AuthError(422, 'signup_disabled', 'Signups not allowed for this instance'),
  otpExpired: () => new AuthError(403, 'otp_expired', 'Token has expired or is invalid'),
  userBanned: () => new AuthError(400, 'user_banned', 'User is banned'),
  invalidCredentials: () => new AuthError(400, 'invalid_credentials', 'Invalid login credentials'),
  emailNotConfirmed: () => new AuthError(400, 'email_not_confirmed', 'Email not confirmed'),
  phoneNotConfirmed: () => new AuthError(400, 'phone_not_confirmed', 'Phone not confirmed'),
  refreshTokenNotFound: () =>
    new AuthError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found'),
  refreshTokenAlreadyUsed: () =>
    new AuthError(400, 'refresh_token_already_used', 'Invalid Refresh Token: Already Used'),
  sessionExpired: () =>
    new AuthError(400, 'session_expired', 'Invalid Refresh Token: Session Expired'),
  emailRateLimit: (seconds: number) =>
    new AuthError(
      429,
      'over_email_send_rate_limit',
      `For security purposes, you can only request this after ${seconds} seconds.`,
      {
        'retry-after': seconds,
      },
    ),
  smsRateLimit: (seconds: number) =>
    new AuthError(
      429,
      'over_sms_send_rate_limit',
      `For security purposes, you can only request this after ${seconds} seconds.`,
      {
        'retry-after': seconds,
      },
    ),
  requestRateLimit: () =>
    new AuthError(429, 'over_request_rate_limit', 'Request rate limit reached'),
  emailExists: () =>
    new AuthError(
      422,
      'email_exists',
      'A user with this email address has already been registered',
    ),
  phoneExists: () =>
    new AuthError(422, 'phone_exists', 'A user with this phone number has already been registered'),
  weakPassword: () =>
    new AuthError(422, 'weak_password', 'Password should be at least 6 characters.'),
  userNotFound: () => new AuthError(404, 'user_not_found', 'User not found'),
  factorNotFound: (msg = 'Factor not found') => new AuthError(404, 'mfa_factor_not_found', msg),
  factorNameConflict: (name: string) =>
    new AuthError(
      422,
      'mfa_factor_name_conflict',
      `A factor with the friendly name "${name}" for this user already exists`,
    ),
  tooManyFactors: () =>
    new AuthError(
      422,
      'too_many_enrolled_mfa_factors',
      'Maximum number of verified factors reached, unenroll to continue',
    ),
  insufficientAal: (msg: string) => new AuthError(403, 'insufficient_aal', msg),
  challengeExpired: (id: string) =>
    new AuthError(
      422,
      'mfa_challenge_expired',
      `MFA challenge ${id} has expired, verify against another challenge or create a new challenge.`,
    ),
  mfaVerificationFailed: () =>
    new AuthError(422, 'mfa_verification_failed', 'Invalid TOTP code entered'),
  notEmulated: (what: string) =>
    new AuthError(404, 'not_found', `${what} is not emulated by the local gateway`),
  unexpected: (msg: string) => new AuthError(500, 'unexpected_failure', msg),
};

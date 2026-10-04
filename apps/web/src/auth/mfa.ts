/**
 * TOTP second factor (mandatory for country_manager and hq_admin — brief §3).
 *
 * Nothing about the secret is stored by the app: it is shown once during enrolment (QR code and
 * text) and then lives only in the user's authenticator app and on the Auth server.
 * A successful verification makes supabase-js store a new aal2 session through the vault; the
 * session listener then refreshes `my_context()` and the AuthGate lets the user in.
 */
import { env } from '../env';
import { AuthFlowError, toFlowError } from './errors';
import { supabase } from './supabase';

export interface TotpEnrolment {
  factorId: string;
  /** `data:` URL of the QR code (SVG) for an <img>. */
  qrDataUrl: string;
  /** Base32 secret for manual entry. */
  secret: string;
}

export interface MfaStatus {
  /** Id of the verified TOTP factor to challenge, or null when the user must enrol first. */
  verifiedFactorId: string | null;
}

/** supabase-js prefixes the raw SVG with a data: scheme; re-encode it so "#" and quotes survive. */
export function qrToDataUrl(qrCode: string): string {
  const prefix = 'data:image/svg+xml;utf-8,';
  const svg = qrCode.startsWith(prefix) ? qrCode.slice(prefix.length) : qrCode;
  if (!svg.trimStart().startsWith('<')) return qrCode; // already an encoded data URL
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export async function getMfaStatus(): Promise<MfaStatus> {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) throw toFlowError(error);
  return { verifiedFactorId: data.totp[0]?.id ?? null };
}

/** Starts (or restarts) enrolment. Abandoned, never-verified factors are removed first. */
export async function startTotpEnrolment(): Promise<TotpEnrolment> {
  const listed = await supabase.auth.mfa.listFactors();
  if (listed.error) throw toFlowError(listed.error);
  for (const factor of listed.data.all) {
    if (factor.factor_type === 'totp' && factor.status === 'unverified') {
      await supabase.auth.mfa.unenroll({ factorId: factor.id });
    }
  }
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    ...(env.appName ? { issuer: env.appName } : {}),
  });
  if (error) throw toFlowError(error);
  return { factorId: data.id, qrDataUrl: qrToDataUrl(data.totp.qr_code), secret: data.totp.secret };
}

/** Challenge + verify in one step; on success the session becomes aal2. */
export async function verifyTotp(factorId: string, code: string): Promise<void> {
  const digits = code.replace(/\s+/g, '');
  if (!/^[0-9]{6}$/.test(digits)) throw new AuthFlowError('mfa_code_invalid');
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: digits });
  if (error) throw toFlowError(error);
}

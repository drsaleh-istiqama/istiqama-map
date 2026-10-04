/**
 * OTP delivery providers.
 *
 * Owner decision #4 (SMS provider per country) is open, so only the `fake` provider exists.
 * The structure is ready for real ones: implement `OtpProvider`, register it in `PROVIDERS`
 * and select it per country with `OTP_PROVIDER_<ISO2>` (e.g. `OTP_PROVIDER_TZ=acme`), or for
 * every country with `OTP_PROVIDER`.
 */
import { appEnv, boolEnv, env } from '../_shared/env.ts';

export interface OtpMessage {
  channel: 'sms' | 'email';
  /** E.164 phone number ("+255…") or e-mail address. */
  to: string;
  code: string;
  /** ISO 3166-1 alpha-2 of the phone number's country, when it is one we serve. */
  country: string | null;
  userId: string | null;
}

export interface OtpProvider {
  readonly name: string;
  send(message: OtpMessage): Promise<void>;
}

export class OtpProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 500,
  ) {
    super(message);
    this.name = 'OtpProviderError';
  }
}

/** Calling codes of the countries the association serves (brief §0), longest prefix first. */
const CALLING_CODES: ReadonlyArray<readonly [string, string]> = [
  ['255', 'TZ'],
  ['254', 'KE'],
  ['256', 'UG'],
  ['250', 'RW'],
  ['257', 'BI'],
  ['258', 'MZ'],
  ['968', 'OM'],
];

/** GoTrue stores phones without "+": accept both forms. */
export function normalisePhone(phone: string): string {
  const digits = phone.replace(/[^\d]/g, '');
  return digits === '' ? '' : `+${digits}`;
}

export function countryOfPhone(phone: string): string | null {
  const digits = phone.replace(/[^\d]/g, '');
  for (const [prefix, iso2] of CALLING_CODES) if (digits.startsWith(prefix)) return iso2;
  return null;
}

/** "+255700000001" → "+255•••••001"; "user@example.org" → "u•••@example.org". */
export function maskRecipient(to: string): string {
  const dot = String.fromCharCode(0x2022);
  if (to.includes('@')) {
    const [local, domain] = to.split('@');
    return `${(local ?? '').slice(0, 1)}${dot.repeat(3)}@${domain ?? ''}`;
  }
  if (to.length <= 7) return dot.repeat(to.length);
  return `${to.slice(0, 4)}${dot.repeat(to.length - 7)}${to.slice(-3)}`;
}

/**
 * Development provider: writes one log line and sends nothing, stores nothing. The code is
 * part of the log line (that is the point in development) unless `OTP_FAKE_LOG_CODES=false`.
 * It refuses to work when `APP_ENV=production`, so that a production deployment without a
 * real provider fails loudly instead of "sending" codes into a log.
 */
export const fakeProvider: OtpProvider = {
  name: 'fake',
  send(message: OtpMessage): Promise<void> {
    if (appEnv() === 'production')
      return Promise.reject(
        new OtpProviderError(
          'provider_not_configured',
          'The fake OTP provider is disabled in production.',
        ),
      );
    const code = boolEnv('OTP_FAKE_LOG_CODES', true) ? message.code : '(hidden)';
    console.log(
      `[otp-hook] fake provider: ${message.channel} code ${code} for ${maskRecipient(message.to)}` +
        (message.country ? ` (${message.country})` : ''),
    );
    return Promise.resolve();
  },
};

const PROVIDERS: Record<string, OtpProvider> = {
  fake: fakeProvider,
};

/**
 * Provider name for a message: `OTP_PROVIDER_<ISO2>` for the phone's country, else the
 * request's own hint (the local gateway sends `x-otp-provider`), else `OTP_PROVIDER`, else fake.
 */
export function providerNameFor(message: OtpMessage, hint?: string | null): string {
  const perCountry = message.country ? env(`OTP_PROVIDER_${message.country}`) : undefined;
  return (perCountry ?? hint ?? env('OTP_PROVIDER') ?? 'fake').trim().toLowerCase();
}

/** True when the deployment chose a provider for this message (`OTP_PROVIDER[_<ISO2>]`). */
export function providerConfigured(message: OtpMessage): boolean {
  return (
    (message.country !== null && env(`OTP_PROVIDER_${message.country}`) !== undefined) ||
    env('OTP_PROVIDER') !== undefined
  );
}

export function resolveProvider(name: string): OtpProvider {
  const provider = PROVIDERS[name];
  if (!provider)
    throw new OtpProviderError(
      'provider_not_configured',
      `OTP provider "${name}" is not implemented.`,
    );
  return provider;
}

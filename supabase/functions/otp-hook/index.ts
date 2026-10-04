/**
 * otp-hook — Supabase Auth "Send SMS hook" (and "Send Email hook") handler.
 *
 * Auth calls it instead of sending the one-time code itself:
 *   POST { "user": { "id", "phone", "email", … }, "sms": { "otp": "123456" } }
 *   POST { "user": { … }, "email_data": { "token": "123456", "token_hash", "email_action_type", … } }
 * Answer: 200 `{}` when the code was handed to the provider; otherwise
 * `{ "error": { "http_code": <status>, "message": "…" } }` (the hook error format).
 *
 * Authentication (this function must be deployed with `verify_jwt = false`, Auth sends no JWT):
 *   - Standard Webhooks signature, verified with `SEND_SMS_HOOK_SECRET` /
 *     `SEND_EMAIL_HOOK_SECRET` ("v1,whsec_…" from the dashboard; several secrets may be
 *     separated by spaces during a rotation); or
 *   - the service-role key as bearer (the local gateway calls the hook this way).
 * Anything else is refused: the body contains a live sign-in code.
 *
 * Providers: see ./providers.ts (only `fake` until owner decision #4 is taken). Behind the
 * real (signed) hook a provider must be configured explicitly — see the handler.
 * Configuration: supabase/functions/README.md.
 */
import { isServiceRequest } from '../_shared/auth.ts';
import { env, serveIfEntryPoint } from '../_shared/env.ts';
import { createHandler, isRecord, json, readText } from '../_shared/http.ts';
import { verifyWebhook } from '../_shared/webhook.ts';
import {
  OtpProviderError,
  countryOfPhone,
  normalisePhone,
  providerConfigured,
  providerNameFor,
  resolveProvider,
  type OtpMessage,
} from './providers.ts';

function hookError(status: number, message: string): Response {
  return json({ error: { http_code: status, message } }, status);
}

function hookSecrets(): string[] {
  return [env('SEND_SMS_HOOK_SECRET'), env('SEND_EMAIL_HOOK_SECRET'), env('AUTH_HOOK_SECRET')]
    .flatMap((s) => (s ? s.split(/\s+/) : []))
    .filter((s) => s !== '');
}

/** The message to deliver, or null when the payload is neither an SMS nor an e-mail hook. */
export function messageFromPayload(payload: unknown): OtpMessage | null {
  if (!isRecord(payload) || !isRecord(payload.user)) return null;
  const user = payload.user;
  const userId = typeof user.id === 'string' ? user.id : null;
  if (isRecord(payload.sms) && typeof payload.sms.otp === 'string' && payload.sms.otp !== '') {
    const phone = typeof user.phone === 'string' ? normalisePhone(user.phone) : '';
    if (phone === '') return null;
    return {
      channel: 'sms',
      to: phone,
      code: payload.sms.otp,
      country: countryOfPhone(phone),
      userId,
    };
  }
  if (
    isRecord(payload.email_data) &&
    typeof payload.email_data.token === 'string' &&
    payload.email_data.token !== ''
  ) {
    const email = typeof user.email === 'string' ? user.email.trim() : '';
    if (email === '') return null;
    return { channel: 'email', to: email, code: payload.email_data.token, country: null, userId };
  }
  return null;
}

export const handler = createHandler('otp-hook', ['POST'], async (req) => {
  const raw = await readText(req, 64 * 1024);

  // The local gateway calls with the service key; Supabase Auth calls with a signed webhook.
  const viaAuthHook = !isServiceRequest(req);
  if (viaAuthHook) {
    const secrets = hookSecrets();
    if (secrets.length === 0) return hookError(401, 'The hook secret is not configured.');
    const verdict = await verifyWebhook(secrets, req.headers, raw);
    if (verdict !== 'ok') return hookError(401, `Hook signature rejected (${verdict}).`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return hookError(400, 'The hook payload is not valid JSON.');
  }
  const message = messageFromPayload(payload);
  if (!message) return hookError(400, 'The hook payload has no recipient or no one-time code.');

  try {
    const name = providerNameFor(message, viaAuthHook ? null : req.headers.get('x-otp-provider'));
    // Fail closed on a hosted project: behind the real Auth hook the fake provider must be
    // chosen explicitly (`OTP_PROVIDER=fake`, e.g. a staging project). An unconfigured
    // production project then refuses to "send" instead of writing sign-in codes into the log.
    if (viaAuthHook && name === 'fake' && !providerConfigured(message))
      throw new OtpProviderError(
        'provider_not_configured',
        'No OTP provider is configured (set OTP_PROVIDER or OTP_PROVIDER_<ISO2>).',
      );
    const provider = resolveProvider(name);
    await provider.send(message);
  } catch (e) {
    const status = e instanceof OtpProviderError ? e.status : 500;
    const text = e instanceof Error ? e.message : String(e);
    console.error(`[otp-hook] delivery failed: ${text}`);
    return hookError(status, `Failed to send the code: ${text}`);
  }
  return json({});
});

export default handler;
serveIfEntryPoint(import.meta, handler);

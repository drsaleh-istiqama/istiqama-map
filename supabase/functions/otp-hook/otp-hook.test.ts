import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signWebhook } from '../_shared/webhook.ts';
import { handler, messageFromPayload } from './index.ts';
import {
  OtpProviderError,
  countryOfPhone,
  fakeProvider,
  maskRecipient,
  normalisePhone,
  providerNameFor,
  resolveProvider,
  type OtpMessage,
} from './providers.ts';

const SECRET = 'v1,whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const SERVICE_KEY = 'service-role-key-for-tests';
const SMS_PAYLOAD = {
  user: { id: 'u1', phone: '255700000001', email: '' },
  sms: { otp: '123456' },
};

const sms = (to: string): OtpMessage => ({
  channel: 'sms',
  to,
  code: '123456',
  country: countryOfPhone(to),
  userId: null,
});

let logs: string[] = [];

beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation(
    (...args: unknown[]) => void logs.push(args.join(' ')),
  );
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('phone helpers', () => {
  it('normalises GoTrue phones (stored without "+")', () => {
    expect(normalisePhone('255700000001')).toBe('+255700000001');
    expect(normalisePhone('+255 700-000-001')).toBe('+255700000001');
    expect(normalisePhone('')).toBe('');
  });

  it('finds the country of the numbers we serve', () => {
    expect(countryOfPhone('+255700000001')).toBe('TZ');
    expect(countryOfPhone('254700000001')).toBe('KE');
    expect(countryOfPhone('+256700000001')).toBe('UG');
    expect(countryOfPhone('+250700000001')).toBe('RW');
    expect(countryOfPhone('+25779000000')).toBe('BI');
    expect(countryOfPhone('+258840000000')).toBe('MZ');
    expect(countryOfPhone('+96890000000')).toBe('OM');
    expect(countryOfPhone('+447700900000')).toBeNull();
  });

  it('masks recipients in logs', () => {
    expect(maskRecipient('+255700000001')).toMatch(/^\+255.{6}001$/);
    expect(maskRecipient('+255700000001')).not.toContain('700000');
    expect(maskRecipient('collector@example.org')).toMatch(/^c.{3}@example\.org$/);
  });
});

describe('provider selection', () => {
  it('defaults to fake', () => {
    expect(providerNameFor(sms('+255700000001'))).toBe('fake');
  });

  it('prefers OTP_PROVIDER_<ISO2>, then the request hint, then OTP_PROVIDER', () => {
    vi.stubEnv('OTP_PROVIDER', 'global');
    expect(providerNameFor(sms('+255700000001'))).toBe('global');
    expect(providerNameFor(sms('+255700000001'), 'Hinted')).toBe('hinted');
    vi.stubEnv('OTP_PROVIDER_TZ', 'tz-gateway');
    expect(providerNameFor(sms('+255700000001'), 'hinted')).toBe('tz-gateway');
    expect(providerNameFor(sms('+254700000001'), 'hinted')).toBe('hinted'); // Kenya has no override
  });

  it('refuses providers that are not implemented (fail closed)', () => {
    expect(resolveProvider('fake')).toBe(fakeProvider);
    expect(() => resolveProvider('acme')).toThrowError(OtpProviderError);
  });

  it('the fake provider logs a masked recipient and sends nothing', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await fakeProvider.send(sms('+255700000001'));
    vi.unstubAllGlobals();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('123456');
    expect(logs[0]).toContain('(TZ)');
    expect(logs[0]).not.toContain('+255700000001');
  });

  it('the fake provider can hide codes and refuses to run in production', async () => {
    vi.stubEnv('OTP_FAKE_LOG_CODES', 'false');
    await fakeProvider.send(sms('+255700000001'));
    expect(logs[0]).not.toContain('123456');
    vi.stubEnv('APP_ENV', 'production');
    await expect(fakeProvider.send(sms('+255700000001'))).rejects.toMatchObject({
      code: 'provider_not_configured',
    });
  });
});

describe('messageFromPayload', () => {
  it('reads the Send SMS hook payload', () => {
    expect(messageFromPayload(SMS_PAYLOAD)).toEqual({
      channel: 'sms',
      to: '+255700000001',
      code: '123456',
      country: 'TZ',
      userId: 'u1',
    });
  });

  it('reads the Send Email hook payload', () => {
    const payload = {
      user: { id: 'u2', email: 'hq.admin@example.org' },
      email_data: { token: '654321', token_hash: 'h', email_action_type: 'magiclink' },
    };
    expect(messageFromPayload(payload)).toEqual({
      channel: 'email',
      to: 'hq.admin@example.org',
      code: '654321',
      country: null,
      userId: 'u2',
    });
  });

  it('returns null for anything else', () => {
    for (const p of [
      null,
      'x',
      {},
      { user: {} },
      { user: { phone: '' }, sms: { otp: '1' } },
      { user: { phone: '2557' }, sms: {} },
      { sms: { otp: '1' } },
    ])
      expect(messageFromPayload(p)).toBeNull();
  });
});

describe('otp-hook handler', () => {
  const body = JSON.stringify(SMS_PAYLOAD);

  async function signedRequest(
    payload: string,
    secret = SECRET,
    timestamp = Math.floor(Date.now() / 1000),
  ): Promise<Request> {
    const id = 'msg_test_1';
    return new Request('http://fn.test/otp-hook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': id,
        'webhook-timestamp': String(timestamp),
        'webhook-signature': await signWebhook(secret, id, String(timestamp), payload),
      },
      body: payload,
    });
  }

  it('accepts a correctly signed hook and answers {}', async () => {
    vi.stubEnv('SEND_SMS_HOOK_SECRET', SECRET);
    vi.stubEnv('OTP_PROVIDER', 'fake'); // e.g. a hosted staging project
    const res = await handler(await signedRequest(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(logs.some((l) => l.includes('fake provider'))).toBe(true);
  });

  it('behind the real hook, an unconfigured project fails closed instead of logging codes', async () => {
    vi.stubEnv('SEND_SMS_HOOK_SECRET', SECRET);
    vi.stubEnv('OTP_PROVIDER', ''); // empty = unset
    vi.stubEnv('OTP_PROVIDER_TZ', '');
    const res = await handler(await signedRequest(body));
    expect(res.status).toBe(500);
    expect((await res.json()).error.message).toMatch(/No OTP provider is configured/);
    expect(logs).toHaveLength(0);

    // the request hint of the local gateway is not honoured behind the real hook
    const hinted = await signedRequest(body);
    hinted.headers.set('x-otp-provider', 'fake');
    expect((await handler(hinted)).status).toBe(500);
    expect(logs).toHaveLength(0);

    // a per-country choice counts as configured
    vi.stubEnv('OTP_PROVIDER_TZ', 'fake');
    expect((await handler(await signedRequest(body))).status).toBe(200);
    expect(logs).toHaveLength(1);
  });

  it('accepts the service-role key (local gateway)', async () => {
    const res = await handler(
      new Request('http://fn.test/otp-hook', {
        method: 'POST',
        headers: { authorization: `Bearer ${SERVICE_KEY}`, 'x-otp-provider': 'fake' },
        body,
      }),
    );
    expect(res.status).toBe(200);
  });

  it('rejects unsigned, wrongly signed and replayed requests in the hook error format', async () => {
    vi.stubEnv('SEND_SMS_HOOK_SECRET', SECRET);
    const unsigned = await handler(
      new Request('http://fn.test/otp-hook', { method: 'POST', body }),
    );
    expect(unsigned.status).toBe(401);
    expect(await unsigned.json()).toEqual({
      error: { http_code: 401, message: 'Hook signature rejected (missing_headers).' },
    });

    const wrong = await handler(await signedRequest(body, 'v1,whsec_b3RoZXJzZWNyZXQ='));
    expect(wrong.status).toBe(401);

    const old = await handler(
      await signedRequest(body, SECRET, Math.floor(Date.now() / 1000) - 3600),
    );
    expect(old.status).toBe(401);
    expect(logs).toHaveLength(0); // nothing was "sent"

    const userToken = await handler(
      new Request('http://fn.test/otp-hook', {
        method: 'POST',
        headers: { authorization: 'Bearer some.user.jwt' },
        body,
      }),
    );
    expect(userToken.status).toBe(401);
  });

  it('is closed when no secret is configured', async () => {
    const res = await handler(await signedRequest(body));
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toMatch(/not configured/);
  });

  it('answers 400 for payloads without a code and 500 for unknown providers', async () => {
    const auth = { authorization: `Bearer ${SERVICE_KEY}` };
    const bad = await handler(
      new Request('http://fn.test/otp-hook', {
        method: 'POST',
        headers: auth,
        body: '{"user":{}}',
      }),
    );
    expect(bad.status).toBe(400);
    const notJson = await handler(
      new Request('http://fn.test/otp-hook', { method: 'POST', headers: auth, body: 'nope' }),
    );
    expect(notJson.status).toBe(400);
    const unknown = await handler(
      new Request('http://fn.test/otp-hook', {
        method: 'POST',
        headers: { ...auth, 'x-otp-provider': 'acme' },
        body,
      }),
    );
    expect(unknown.status).toBe(500);
    expect((await unknown.json()).error).toMatchObject({ http_code: 500 });
    expect(logs).toHaveLength(0);
  });
});

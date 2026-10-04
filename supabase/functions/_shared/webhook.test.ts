import { describe, expect, it } from 'vitest';
import { signWebhook, verifyWebhook, webhookKey } from './webhook.ts';

// Test vector of the Standard Webhooks specification.
const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const ID = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
const TIMESTAMP = '1614265330';
const BODY = '{"test": 2432232314}';
const SIGNATURE = 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=';

function headers(signature: string, timestamp = TIMESTAMP, id = ID): Headers {
  return new Headers({ 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': signature });
}

describe('Standard Webhooks signatures', () => {
  it('reproduces the reference signature', async () => {
    expect(await signWebhook(SECRET, ID, TIMESTAMP, BODY)).toBe(SIGNATURE);
  });

  it('accepts the secret in the form Supabase shows it ("v1,whsec_…")', async () => {
    expect(await signWebhook(`v1,${SECRET}`, ID, TIMESTAMP, BODY)).toBe(SIGNATURE);
    expect(webhookKey(`v1,${SECRET}`)).toEqual(webhookKey(SECRET.replace('whsec_', '')));
  });

  it('verifies a valid request', async () => {
    expect(await verifyWebhook([SECRET], headers(SIGNATURE), BODY, 300, Number(TIMESTAMP) + 10)).toBe('ok');
  });

  it('accepts any of several signatures and secrets (rotation)', async () => {
    const h = headers(`v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= ${SIGNATURE} v2,ignored`);
    expect(await verifyWebhook(['whsec_b2xkc2VjcmV0', SECRET], h, BODY, 300, Number(TIMESTAMP))).toBe('ok');
  });

  it('rejects a modified body, a wrong secret and a foreign signature', async () => {
    const at = Number(TIMESTAMP);
    expect(await verifyWebhook([SECRET], headers(SIGNATURE), `${BODY} `, 300, at)).toBe('bad_signature');
    expect(await verifyWebhook(['whsec_b2xkc2VjcmV0'], headers(SIGNATURE), BODY, 300, at)).toBe('bad_signature');
    expect(await verifyWebhook([SECRET], headers('v1,bm9wZQ=='), BODY, 300, at)).toBe('bad_signature');
  });

  it('rejects stale and future timestamps (replay protection)', async () => {
    expect(await verifyWebhook([SECRET], headers(SIGNATURE), BODY, 300, Number(TIMESTAMP) + 301)).toBe('stale_timestamp');
    expect(await verifyWebhook([SECRET], headers(SIGNATURE), BODY, 300, Number(TIMESTAMP) - 301)).toBe('stale_timestamp');
    expect(await verifyWebhook([SECRET], headers(SIGNATURE, 'yesterday'), BODY)).toBe('stale_timestamp');
  });

  it('rejects requests without the signature headers', async () => {
    expect(await verifyWebhook([SECRET], new Headers(), BODY)).toBe('missing_headers');
    expect(await verifyWebhook([SECRET], new Headers({ 'webhook-id': ID }), BODY)).toBe('missing_headers');
  });

  it('reports an unusable secret instead of accepting anything', async () => {
    expect(await verifyWebhook(['whsec_***not base64***'], headers(SIGNATURE), BODY, 300, Number(TIMESTAMP))).toBe('bad_secret');
    expect(await verifyWebhook([], headers(SIGNATURE), BODY, 300, Number(TIMESTAMP))).toBe('bad_secret');
  });
});

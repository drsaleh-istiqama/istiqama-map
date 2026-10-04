/**
 * Standard Webhooks signature check (https://www.standardwebhooks.com), the scheme Supabase
 * Auth uses for HTTP hooks ("Send SMS hook", "Send Email hook").
 *
 *   headers:  webhook-id, webhook-timestamp (unix seconds), webhook-signature
 *   signed:   `${id}.${timestamp}.${raw body}`  with HMAC-SHA256
 *   secret:   "v1,whsec_<base64 key>" as shown in the dashboard (the prefixes are optional here)
 *   header:   one or more space-separated "v1,<base64 signature>" entries (key rotation)
 */

function base64Decode(text: string): Uint8Array {
  const clean = text.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64Encode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Key bytes of a hook secret ("v1,whsec_…", "whsec_…" or the bare base64 key). */
export function webhookKey(secret: string): Uint8Array {
  const bare = secret.trim().replace(/^v1,/, '').replace(/^whsec_/, '');
  return base64Decode(bare);
}

export async function signWebhook(secret: string, id: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    webhookKey(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const data = new TextEncoder().encode(`${id}.${timestamp}.${body}`);
  return `v1,${base64Encode(new Uint8Array(await crypto.subtle.sign('HMAC', key, data)))}`;
}

function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export type WebhookVerdict = 'ok' | 'missing_headers' | 'stale_timestamp' | 'bad_signature' | 'bad_secret';

/**
 * Verify a hook request. `secrets` may hold several secrets (rotation); `toleranceSeconds`
 * bounds replay (default 5 minutes, as the reference implementations).
 */
export async function verifyWebhook(
  secrets: string[],
  headers: Headers,
  body: string,
  toleranceSeconds = 300,
  nowSeconds = Date.now() / 1000,
): Promise<WebhookVerdict> {
  const id = headers.get('webhook-id');
  const timestamp = headers.get('webhook-timestamp');
  const signatures = headers.get('webhook-signature');
  if (!id || !timestamp || !signatures) return 'missing_headers';
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > toleranceSeconds) return 'stale_timestamp';
  const presented = signatures.split(/\s+/).filter((s) => s.startsWith('v1,'));
  let usable = false;
  for (const secret of secrets) {
    let expected: string;
    try {
      expected = await signWebhook(secret, id, timestamp, body);
    } catch {
      continue; // not base64
    }
    usable = true;
    for (const candidate of presented) if (constantTimeEqual(candidate, expected)) return 'ok';
  }
  return usable ? 'bad_signature' : 'bad_secret';
}

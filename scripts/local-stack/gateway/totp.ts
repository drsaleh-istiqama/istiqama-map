/**
 * HOTP (RFC 4226) / TOTP (RFC 6238) and Base32 (RFC 4648), implemented on node:crypto only.
 * GoTrue's TOTP factors use SHA-1, 6 digits, a 30 s period and accept one period of clock skew.
 */
import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(data: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

export function hotp(
  secret: Uint8Array,
  counter: number | bigint,
  digits = 6,
  algorithm: TotpAlgorithm = 'sha1',
): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac(algorithm, secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export interface TotpOptions {
  period?: number;
  digits?: number;
  algorithm?: TotpAlgorithm;
}

export function totp(secret: Uint8Array, timeSeconds: number, opts: TotpOptions = {}): string {
  const period = opts.period ?? 30;
  return hotp(secret, Math.floor(timeSeconds / period), opts.digits ?? 6, opts.algorithm ?? 'sha1');
}

/** Constant-time check of `code` against the current period ± `skew` periods. */
export function verifyTotp(
  secret: Uint8Array,
  code: string,
  timeSeconds: number,
  opts: TotpOptions & { skew?: number } = {},
): boolean {
  const digits = opts.digits ?? 6;
  const period = opts.period ?? 30;
  const skew = opts.skew ?? 1;
  const given = code.trim();
  if (!new RegExp(`^\\d{${digits}}$`).test(given)) return false;
  const givenBuf = Buffer.from(given);
  let ok = false;
  for (let step = -skew; step <= skew; step++) {
    const expected = Buffer.from(totp(secret, timeSeconds + step * period, opts));
    if (crypto.timingSafeEqual(expected, givenBuf)) ok = true;
  }
  return ok;
}

/** 20 random bytes (160 bit, the RFC 4226 recommendation) as unpadded Base32. */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

/** Key URI understood by authenticator apps (same layout as GoTrue / pquerna/otp). */
export function otpauthUri(issuer: string, account: string, secretBase32: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const q = new URLSearchParams({
    algorithm: 'SHA1',
    digits: '6',
    issuer,
    period: '30',
    secret: secretBase32,
  });
  return `otpauth://totp/${label}?${q.toString()}`;
}

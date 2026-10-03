import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  otpauthUri,
  totp,
  verifyTotp,
} from '../totp.ts';

const SHA1_SECRET = Buffer.from('12345678901234567890', 'ascii');
const SHA256_SECRET = Buffer.from('12345678901234567890123456789012', 'ascii');
const SHA512_SECRET = Buffer.from(
  '1234567890123456789012345678901234567890123456789012345678901234',
  'ascii',
);

describe('TOTP (RFC 6238 Appendix B test vectors)', () => {
  const vectors: Array<[number, string, string, string]> = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];
  for (const [time, sha1, sha256, sha512] of vectors) {
    it(`T=${time}`, () => {
      expect(totp(SHA1_SECRET, time, { digits: 8, algorithm: 'sha1' })).toBe(sha1);
      expect(totp(SHA256_SECRET, time, { digits: 8, algorithm: 'sha256' })).toBe(sha256);
      expect(totp(SHA512_SECRET, time, { digits: 8, algorithm: 'sha512' })).toBe(sha512);
    });
  }
});

describe('HOTP (RFC 4226 Appendix D test vectors)', () => {
  it('counter 0..9', () => {
    const expected = [
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ];
    expect(expected.map((_, i) => hotp(SHA1_SECRET, i))).toEqual(expected);
  });
});

describe('Base32 (RFC 4648 test vectors, unpadded)', () => {
  const vectors: Array<[string, string]> = [
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ];
  it('encodes', () => {
    for (const [plain, encoded] of vectors) expect(base32Encode(Buffer.from(plain))).toBe(encoded);
  });
  it('decodes (padding, lower case and spaces tolerated)', () => {
    for (const [plain, encoded] of vectors) expect(base32Decode(encoded).toString()).toBe(plain);
    expect(base32Decode('mzxw 6ytb oi======').toString()).toBe('foobar');
    expect(() => base32Decode('MZXW1')).toThrow();
  });
  it('round-trips random secrets', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Encode(base32Decode(secret))).toBe(secret);
  });
});

describe('verifyTotp', () => {
  const secret = base32Decode('JBSWY3DPEHPK3PXP');
  const now = 1_700_000_015;

  it('accepts the current code and one period of skew either way', () => {
    expect(verifyTotp(secret, totp(secret, now), now)).toBe(true);
    expect(verifyTotp(secret, totp(secret, now - 30), now)).toBe(true);
    expect(verifyTotp(secret, totp(secret, now + 30), now)).toBe(true);
  });

  it('rejects older codes, wrong codes and malformed input', () => {
    expect(verifyTotp(secret, totp(secret, now - 90), now)).toBe(false);
    expect(verifyTotp(secret, totp(secret, now), now, { skew: 0 })).toBe(true);
    expect(verifyTotp(secret, totp(secret, now - 30), now, { skew: 0 })).toBe(false);
    expect(verifyTotp(secret, '12345', now)).toBe(false);
    expect(verifyTotp(secret, 'abcdef', now)).toBe(false);
    expect(verifyTotp(secret, '', now)).toBe(false);
  });
});

describe('otpauthUri', () => {
  it('produces a key URI that authenticator apps accept', () => {
    const uri = otpauthUri('localhost:5173', 'u_hq@example.org', 'JBSWY3DPEHPK3PXP');
    const url = new URL(uri);
    expect(url.protocol).toBe('otpauth:');
    expect(uri.startsWith('otpauth://totp/localhost%3A5173:u_hq%40example.org?')).toBe(true);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      algorithm: 'SHA1',
      digits: '6',
      issuer: 'localhost:5173',
      period: '30',
      secret: 'JBSWY3DPEHPK3PXP',
    });
  });
});

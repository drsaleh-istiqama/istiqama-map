import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { AuthError, sendAuthError } from '../auth/errors.ts';
import {
  isValidEmail,
  isValidPhone,
  normalizeEmail,
  normalizePhone,
  otpHash,
} from '../auth/store.ts';
import { loadConfig, parseGoDuration, parseSize, parseTomlLite } from '../config.ts';
import { encodeQr, qrSvg } from '../qr.ts';
import { RateLimiter } from '../ratelimit.ts';

describe('config', () => {
  const toml = `
# comment
project_id = "istiqama-map"

[auth]
enable_signup = false   # nobody self-registers
jwt_expiry = 1800
refresh_token_reuse_interval = 7
site_url = "http://localhost:5173"

[auth.email]
enable_signup = false
otp_expiry = 600
max_frequency = "2s"

[auth.sms.test_otp]
"255700000001" = "123456"
254700000001 = "654321"

[storage]
file_size_limit = "50MiB"

[functions.otp-hook]
verify_jwt = false
`;

  it('reads sections, scalars, quoted keys and ignores comments', () => {
    const t = parseTomlLite(toml);
    expect(t['']).toEqual({ project_id: 'istiqama-map' });
    expect(t.auth).toMatchObject({
      enable_signup: false,
      jwt_expiry: 1800,
      site_url: 'http://localhost:5173',
    });
    expect(t['auth.sms.test_otp']).toEqual({ '255700000001': '123456', '254700000001': '654321' });
    expect(t['functions.otp-hook']).toEqual({ verify_jwt: false });
  });

  it('environment variables win, config.toml fills the gaps, defaults last', () => {
    const cfg = loadConfig(
      {
        SUPABASE_JWT_SECRET: 's'.repeat(40),
        SUPABASE_ANON_KEY: 'a',
        SUPABASE_SERVICE_ROLE_KEY: 'b',
        JWT_EXPIRY_SECONDS: '120',
      },
      toml,
    );
    expect(cfg.port).toBe(54321);
    expect(cfg.postgrestUrl.href).toBe('http://127.0.0.1:54323/');
    expect(cfg.jwtExpiry).toBe(120);
    expect(cfg.enableSignup).toBe(false);
    expect(cfg.refreshReuseInterval).toBe(7);
    expect(cfg.otpEmailExpiry).toBe(600);
    expect(cfg.otpEmailMinInterval).toBe(2);
    expect(cfg.otpSmsMinInterval).toBe(5);
    expect(cfg.testOtps.get('255700000001')).toBe('123456');
    expect(cfg.fileSizeLimit).toBe(50 * 1024 * 1024);
    expect(cfg.photoSizeLimit).toBe(10 * 1024 * 1024);
    expect(cfg.functionVerifyJwt.get('otp-hook')).toBe(false);
    expect(cfg.otpProvider).toBe('fake');
    // the config.toml trap is reported
    expect(cfg.warnings.some((w) => w.includes('[auth.email] enable_signup'))).toBe(true);
  });

  it('works without config.toml', () => {
    const cfg = loadConfig(
      {
        GATEWAY_PORT: '55555',
        OTP_TEST_CODES: '+255 700 000 009=111111',
        AUTH_ENABLE_SIGNUP: 'true',
      },
      '',
    );
    expect(cfg.port).toBe(55555);
    expect(cfg.jwtExpiry).toBe(3600);
    expect(cfg.enableSignup).toBe(true);
    expect(cfg.testOtps.get('255700000009')).toBe('111111');
    expect(cfg.warnings).toEqual([]);
  });

  it('sizes and Go durations', () => {
    expect(parseSize('50MiB', 0)).toBe(52_428_800);
    expect(parseSize('10MB', 0)).toBe(10_485_760);
    expect(parseSize('1024', 0)).toBe(1024);
    expect(parseSize(undefined, 7)).toBe(7);
    expect(parseSize('nonsense', 7)).toBe(7);
    expect(parseGoDuration('90s')).toBe(90);
    expect(parseGoDuration('1h30m')).toBe(5400);
    expect(parseGoDuration('250ms')).toBeCloseTo(0.25);
    expect(parseGoDuration('876000h')).toBe(876000 * 3600);
    expect(parseGoDuration('forever')).toBeNull();
    expect(parseGoDuration('')).toBeNull();
    expect(parseGoDuration('10')).toBeNull();
  });
});

describe('auth helpers', () => {
  it('normalises identifiers like GoTrue', () => {
    expect(normalizeEmail('  U_HQ@Example.ORG ')).toBe('u_hq@example.org');
    expect(normalizePhone('+255 700-000 001')).toBe('255700000001');
    expect(isValidEmail('a@example.org')).toBe(true);
    expect(isValidEmail('a@b')).toBe(false);
    expect(isValidPhone('255700000001')).toBe(true);
    expect(isValidPhone('0700')).toBe(false);
  });

  it('hashes OTPs as sha224(identifier + code)', () => {
    expect(otpHash('a@example.org', '123456')).toMatch(/^[0-9a-f]{56}$/);
    expect(otpHash('a@example.org', '123456')).not.toBe(otpHash('a@example.org', '123457'));
    expect(otpHash('a@example.org', '123456')).not.toBe(otpHash('b@example.org', '123456'));
  });

  it('formats errors for both GoTrue API versions', () => {
    const capture = (
      version?: string,
    ): { status: number; headers: Record<string, unknown>; body: Record<string, unknown> } => {
      const out = {
        status: 0,
        headers: {} as Record<string, unknown>,
        body: {} as Record<string, unknown>,
      };
      const req = {
        headers: version ? { 'x-supabase-api-version': version } : {},
      } as unknown as IncomingMessage;
      const res = {
        writeHead: (status: number, headers: Record<string, unknown>) => {
          out.status = status;
          out.headers = headers;
        },
        end: (payload: Buffer) => {
          out.body = JSON.parse(payload.toString('utf8'));
        },
      } as unknown as ServerResponse;
      sendAuthError(req, res, new AuthError(403, 'otp_expired', 'Token has expired or is invalid'));
      return out;
    };
    expect(capture().body).toEqual({
      code: 403,
      error_code: 'otp_expired',
      msg: 'Token has expired or is invalid',
    });
    const modern = capture('2024-01-01');
    expect(modern.status).toBe(403);
    expect(modern.body).toEqual({
      code: 'otp_expired',
      message: 'Token has expired or is invalid',
    });
    expect(modern.headers['x-supabase-api-version']).toBe('2024-01-01');
    expect(capture('2023-06-01').body).toHaveProperty('error_code', 'otp_expired');
  });
});

describe('rate limiter', () => {
  it('allows max hits per sliding window', () => {
    const rl = new RateLimiter();
    expect(rl.take('k', 2, 1000, 0)).toBe(true);
    expect(rl.take('k', 2, 1000, 100)).toBe(true);
    expect(rl.take('k', 2, 1000, 200)).toBe(false);
    expect(rl.retryAfter('k', 2, 1000, 200)).toBe(800);
    expect(rl.take('other', 2, 1000, 200)).toBe(true);
    expect(rl.take('k', 2, 1000, 1001)).toBe(true);
    expect(rl.retryAfter('fresh', 1, 1000, 0)).toBe(0);
  });
});

describe('QR code for the TOTP key URI', () => {
  it('has the right size and the three finder patterns', () => {
    const { version, size, modules } = encodeQr(
      'otpauth://totp/x:y?secret=JBSWY3DPEHPK3PXP&issuer=x',
    );
    expect(size).toBe(version * 4 + 17);
    const finder = (ox: number, oy: number): boolean => {
      for (let y = 0; y < 7; y++) {
        for (let x = 0; x < 7; x++) {
          const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
          if (modules[oy + y]![ox + x] !== (ring !== 2)) return false;
        }
      }
      return true;
    };
    expect(finder(0, 0) && finder(size - 7, 0) && finder(0, size - 7)).toBe(true);
    // timing pattern alternates
    for (let i = 8; i < size - 8; i++) expect(modules[6]![i]).toBe(i % 2 === 0);
  });

  it('grows with the payload and renders URI-safe SVG', () => {
    expect(encodeQr('a').version).toBe(1);
    expect(encodeQr('x'.repeat(200)).version).toBeGreaterThan(8);
    const svg = qrSvg('otpauth://totp/x:y?secret=JBSWY3DPEHPK3PXP&issuer=x');
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).not.toMatch(/[#%]/);
    expect(() => encodeQr('x'.repeat(5000))).toThrow();
  });
});

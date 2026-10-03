/**
 * Gateway configuration. Everything comes from environment variables (optionally loaded from
 * <repo>/.env.local). A few GoTrue/Storage settings that have no dedicated variable fall back
 * to supabase/config.toml so that the local stack behaves like the Supabase CLI stack used in CI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export type TomlValue = string | number | boolean;
export type TomlSections = Record<string, Record<string, TomlValue>>;

/**
 * Minimal TOML reader: `[section.sub]` headers and `key = scalar` pairs (strings, integers,
 * floats, booleans; bare or quoted keys). Arrays and inline tables are skipped. Enough for the
 * handful of settings read from supabase/config.toml.
 */
export function parseTomlLite(text: string): TomlSections {
  const out: TomlSections = { '': {} };
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    const header = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (header) {
      section = header[1]!
        .split('.')
        .map((p) => p.trim().replace(/^["']|["']$/g, ''))
        .join('.');
      out[section] ??= {};
      continue;
    }
    const kv = /^("([^"]*)"|'([^']*)'|[A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const key = kv[2] ?? kv[3] ?? kv[1]!;
    const value = parseScalar(kv[4]!.trim());
    if (value !== undefined) out[section]![key] = value;
  }
  return out;
}

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

function parseScalar(v: string): TomlValue | undefined {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^[+-]?\d[\d_]*$/.test(v)) return Number(v.replaceAll('_', ''));
  if (/^[+-]?\d[\d_]*\.\d+$/.test(v)) return Number(v.replaceAll('_', ''));
  const dq = /^"((?:[^"\\]|\\.)*)"$/.exec(v);
  if (dq)
    return dq[1]!.replace(/\\(["\\nt])/g, (_m, c: string) =>
      c === 'n' ? '\n' : c === 't' ? '\t' : c,
    );
  const sq = /^'([^']*)'$/.exec(v);
  if (sq) return sq[1]!;
  return undefined;
}

/** "50MiB", "10MB", "1048576" → bytes. */
export function parseSize(v: string | number | undefined, fallback: number): number {
  if (typeof v === 'number') return v;
  if (!v) return fallback;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)i?b?\s*$/i.exec(v);
  if (!m) return fallback;
  // Like the Supabase CLI (go-units RAMInBytes): MB and MiB are both 1024-based.
  const exp = { '': 0, k: 1, m: 2, g: 3, t: 4 }[m[2]!.toLowerCase()] ?? 0;
  return Math.round(Number(m[1]) * 1024 ** exp);
}

/** Go duration ("90s", "1h30m", "250ms") → seconds; null when it is not one. */
export function parseGoDuration(v: string): number | null {
  const text = v.trim();
  if (!text) return null;
  const units: Record<string, number> = {
    ns: 1e-9,
    us: 1e-6,
    µs: 1e-6,
    ms: 1e-3,
    s: 1,
    m: 60,
    h: 3600,
  };
  const re = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/gy;
  let total = 0;
  let pos = 0;
  for (;;) {
    re.lastIndex = pos;
    const m = re.exec(text);
    if (!m) break;
    total += Number(m[1]) * units[m[2]!]!;
    pos = re.lastIndex;
  }
  return pos === text.length && pos > 0 ? total : null;
}

export interface GatewayConfig {
  host: string;
  port: number;
  postgrestUrl: URL;
  databaseUrl: string;
  dbPoolSize: number;
  jwtSecret: string;
  anonKey: string;
  serviceKey: string;
  jwtExpiry: number;
  /** "fake": codes are kept in memory, logged and served by GET /dev/otp. Anything else: the `otp-hook` function is invoked. */
  otpProvider: string;
  storageDir: string;
  functionsDir: string;
  corsOrigin: string;
  logLevel: 'info' | 'warn' | 'silent';
  siteUrl: string;
  /** GoTrue DISABLE_SIGNUP inverted: may /otp create users that do not exist yet? */
  enableSignup: boolean;
  otpLength: number;
  otpEmailExpiry: number;
  otpSmsExpiry: number;
  /** Minimum seconds between two codes for the same identifier (GoTrue max_frequency). */
  otpEmailMinInterval: number;
  otpSmsMinInterval: number;
  otpMaxPerHour: number;
  /** Fixed codes per phone number (digits only), as in `[auth.sms.test_otp]`. */
  testOtps: Map<string, string>;
  refreshRotation: boolean;
  refreshReuseInterval: number;
  mfaChallengeExpiry: number;
  mfaMaxEnrolledFactors: number;
  /** Global per-object upload limit (`[storage] file_size_limit`). */
  fileSizeLimit: number;
  /** Hard cap for the `photos` bucket (brief §11). */
  photoSizeLimit: number;
  /** Object uploads allowed per user per minute. */
  uploadRatePerMinute: number;
  /** `[functions.<name>] verify_jwt` (default true). */
  functionVerifyJwt: Map<string, boolean>;
  reportsRefreshMinutes: number;
  purgeEveryHours: number;
  warnings: string[];
}

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : fallback;
};
const bool = (v: string | undefined, fallback: boolean): boolean =>
  v === undefined || v === '' ? fallback : /^(1|true|yes|on)$/i.test(v);

export function loadDotenv(): void {
  const file = path.join(ROOT, '.env.local');
  if (fs.existsSync(file)) dotenv.config({ path: file, quiet: true });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, tomlText?: string): GatewayConfig {
  let toml: TomlSections = {};
  if (tomlText === undefined) {
    const file = path.join(ROOT, 'supabase', 'config.toml');
    if (fs.existsSync(file)) toml = parseTomlLite(fs.readFileSync(file, 'utf8'));
  } else toml = parseTomlLite(tomlText);
  const t = (section: string, key: string): TomlValue | undefined => toml[section]?.[key];
  const warnings: string[] = [];

  const port = num(env.GATEWAY_PORT, 54321);
  const testOtps = new Map<string, string>();
  for (const [phone, code] of Object.entries(toml['auth.sms.test_otp'] ?? {})) {
    testOtps.set(phone.replace(/\D/g, ''), String(code));
  }
  // OTP_TEST_CODES="255700000001=123456,254700000001=123456" overrides/extends config.toml
  for (const pair of (env.OTP_TEST_CODES ?? '').split(',')) {
    const [phone, code] = pair.split('=');
    if (phone && code) testOtps.set(phone.replace(/\D/g, ''), code.trim());
  }

  const functionVerifyJwt = new Map<string, boolean>();
  for (const [section, values] of Object.entries(toml)) {
    const m = /^functions\.(.+)$/.exec(section);
    if (m && typeof values.verify_jwt === 'boolean')
      functionVerifyJwt.set(m[1]!, values.verify_jwt);
  }

  if (t('auth.email', 'enable_signup') === false) {
    warnings.push(
      'supabase/config.toml: [auth.email] enable_signup = false makes real GoTrue reject EVERY e-mail login ' +
        '("Email logins are disabled"). Use [auth] enable_signup = false to forbid self-registration.',
    );
  }
  if (t('auth.sms', 'enable_signup') === false) {
    warnings.push(
      'supabase/config.toml: [auth.sms] enable_signup = false disables the phone provider on real GoTrue ' +
        '(phone OTP logins fail). Use [auth] enable_signup = false to forbid self-registration.',
    );
  }

  const storageDir = path.resolve(ROOT, env.STORAGE_DIR ?? path.join('.local', 'storage'));
  const logLevel =
    env.GATEWAY_LOG_LEVEL === 'warn' || env.GATEWAY_LOG_LEVEL === 'silent'
      ? env.GATEWAY_LOG_LEVEL
      : 'info';

  return {
    host: env.GATEWAY_HOST ?? '127.0.0.1',
    port,
    postgrestUrl: new URL(env.POSTGREST_URL ?? 'http://127.0.0.1:54323'),
    databaseUrl: env.DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:54322/istiqama',
    dbPoolSize: num(env.GATEWAY_DB_POOL, 16),
    jwtSecret: env.SUPABASE_JWT_SECRET ?? '',
    anonKey: env.SUPABASE_ANON_KEY ?? '',
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    jwtExpiry: num(
      env.JWT_EXPIRY_SECONDS,
      typeof t('auth', 'jwt_expiry') === 'number' ? (t('auth', 'jwt_expiry') as number) : 3600,
    ),
    otpProvider: env.OTP_PROVIDER ?? 'fake',
    storageDir,
    functionsDir: path.resolve(ROOT, env.FUNCTIONS_DIR ?? path.join('supabase', 'functions')),
    corsOrigin: env.GATEWAY_CORS_ORIGIN ?? '*',
    logLevel,
    siteUrl:
      env.SITE_URL ??
      (typeof t('auth', 'site_url') === 'string'
        ? (t('auth', 'site_url') as string)
        : 'http://localhost:5173'),
    enableSignup: bool(env.AUTH_ENABLE_SIGNUP, t('auth', 'enable_signup') === true),
    otpLength:
      typeof t('auth.email', 'otp_length') === 'number'
        ? (t('auth.email', 'otp_length') as number)
        : 6,
    otpEmailExpiry: num(
      env.OTP_EMAIL_EXPIRY_SECONDS,
      typeof t('auth.email', 'otp_expiry') === 'number'
        ? (t('auth.email', 'otp_expiry') as number)
        : 3600,
    ),
    otpSmsExpiry: num(env.OTP_SMS_EXPIRY_SECONDS, 60),
    otpEmailMinInterval: num(
      env.OTP_MIN_INTERVAL_SECONDS,
      parseGoDuration(String(t('auth.email', 'max_frequency') ?? '')) ?? 1,
    ),
    otpSmsMinInterval: num(
      env.OTP_MIN_INTERVAL_SECONDS,
      parseGoDuration(String(t('auth.sms', 'max_frequency') ?? '')) ?? 5,
    ),
    otpMaxPerHour: num(env.OTP_MAX_PER_HOUR, 30),
    testOtps,
    refreshRotation: bool(
      env.REFRESH_TOKEN_ROTATION,
      t('auth', 'enable_refresh_token_rotation') !== false,
    ),
    refreshReuseInterval: num(
      env.REFRESH_TOKEN_REUSE_INTERVAL,
      typeof t('auth', 'refresh_token_reuse_interval') === 'number'
        ? (t('auth', 'refresh_token_reuse_interval') as number)
        : 10,
    ),
    mfaChallengeExpiry: num(env.MFA_CHALLENGE_EXPIRY_SECONDS, 300),
    mfaMaxEnrolledFactors:
      typeof t('auth.mfa', 'max_enrolled_factors') === 'number'
        ? (t('auth.mfa', 'max_enrolled_factors') as number)
        : 10,
    fileSizeLimit: parseSize(
      env.STORAGE_FILE_SIZE_LIMIT ??
        (t('storage', 'file_size_limit') as string | number | undefined),
      50 * 1024 * 1024,
    ),
    photoSizeLimit: parseSize(env.STORAGE_PHOTO_SIZE_LIMIT, 10 * 1024 * 1024),
    uploadRatePerMinute: num(env.STORAGE_UPLOAD_RATE_PER_MINUTE, 600),
    functionVerifyJwt,
    reportsRefreshMinutes: num(env.REPORTS_REFRESH_MINUTES, 15),
    purgeEveryHours: num(env.PURGE_PHOTOS_EVERY_HOURS, 24),
    warnings,
  };
}

/** Fail fast on a configuration the stack cannot work with. */
export function assertUsable(cfg: GatewayConfig): void {
  const missing: string[] = [];
  if (cfg.jwtSecret.length < 32) missing.push('SUPABASE_JWT_SECRET (at least 32 characters)');
  if (!cfg.anonKey) missing.push('SUPABASE_ANON_KEY');
  if (!cfg.serviceKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length) {
    throw new Error(
      `gateway: missing configuration: ${missing.join(', ')} — run "npm run stack:setup" or fill .env.local`,
    );
  }
}

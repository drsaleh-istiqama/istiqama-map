/**
 * Live test of the auth module against the running local stack (gateway + PostgREST + seed).
 *
 *   npx vitest run --config apps/web/vitest.integration.config.ts
 *
 * Covers: e-mail OTP sign-in through `/dev/otp`, the PIN vault around the real supabase-js
 * client (nothing readable at rest, lock / offline unlock), token refresh, `my_context()`,
 * phone OTP, friendly errors, TOTP enrolment + verification for hq.admin (aal2) and sign-out.
 *
 * It uses the seeded staging accounts only and removes the TOTP factor it creates, so the
 * accounts are left as the seed made them. No service-role key is used.
 */
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/i18n', () => ({ t: (key: string) => key }));

import { tokenAal } from '../../src/auth/context';
import { deviceId } from '../../src/auth/device';
import { AuthFlowError } from '../../src/auth/errors';
import { getMfaStatus, startTotpEnrolment, verifyTotp } from '../../src/auth/mfa';
import {
  authState,
  can,
  initAuth,
  me,
  pin,
  refreshContext,
  session,
  setAuthPorts,
  signInWithEmailOtp,
  signInWithPhoneOtp,
  signOut,
  verifyOtp,
} from '../../src/auth/session';
import { vault } from '../../src/auth/store';
import { supabase } from '../../src/auth/supabase';

const API = process.env.VITE_SUPABASE_URL ?? '';
const ANON = process.env.VITE_SUPABASE_ANON_KEY ?? '';
const PIN = '739153';

const COLLECTOR = 'collector.pemba@example.org';
const COLLECTOR_PHONE = '+255700000001';
const HQ = 'hq.admin@example.org';

/** Where an unfinished run leaves the secret of the factor it created (git-ignored). */
const TOTP_STATE = path.join(
  fileURLToPath(new URL('../../../..', import.meta.url)),
  '.local',
  'tmp',
  'auth-live-totp.json',
);

const resets: string[] = [];

async function devOtp(identifier: string): Promise<string> {
  const res = await fetch(`${API}/dev/otp?identifier=${encodeURIComponent(identifier)}`);
  if (!res.ok) throw new Error(`GET /dev/otp answered ${res.status} (needs OTP_PROVIDER=fake)`);
  return ((await res.json()) as { code: string }).code;
}

function base32Decode(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of text.toUpperCase().replace(/[\s=-]/g, '')) {
    const index = alphabet.indexOf(ch);
    if (index < 0) throw new Error('invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP: SHA-1, 6 digits, 30 s period (what GoTrue issues). */
function totp(secret: string, atMs = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 30_000)));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(bin % 1_000_000).padStart(6, '0');
}

/** Bytes and strings of everything the vault wrote to IndexedDB, as one searchable text. */
async function storedText(): Promise<string> {
  const chunks: string[] = [];
  const visit = (value: unknown): void => {
    if (value instanceof ArrayBuffer) chunks.push(Buffer.from(value).toString('latin1'));
    else if (ArrayBuffer.isView(value)) {
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('latin1'));
    } else if (typeof value === 'object' && value !== null) Object.values(value).forEach(visit);
    else chunks.push(String(value));
  };
  for (const entry of await vault.dump()) {
    chunks.push(entry.key);
    visit(entry.value);
  }
  return chunks.join('\n');
}

async function signInByEmail(email: string): Promise<void> {
  await signInWithEmailOtp(email);
  await verifyOtp(email, await devOtp(email), 'email');
}

beforeAll(async () => {
  expect(API, 'VITE_SUPABASE_URL (.env.local)').not.toBe('');
  expect(ANON, 'VITE_SUPABASE_ANON_KEY (.env.local)').not.toBe('');
  const health = await fetch(`${API}/dev/health`).catch(() => null);
  if (!health?.ok)
    throw new Error(`the local stack is not reachable at ${API} (npm run stack:start)`);
  setAuthPorts({
    resetLocalData: async (reason) => {
      resets.push(reason);
    },
    pendingWork: async () => ({ ops: 0, photos: 0 }),
    confirm: async () => true,
  });
  await initAuth();
});

afterAll(async () => {
  if (session.value) await signOut({ force: true });
});

describe('field collector — e-mail OTP, PIN vault, refresh, my_context, sign-out', () => {
  it('starts signed out', () => {
    expect(authState.value).toBe('signed_out');
    expect(session.value).toBeNull();
  });

  it('reports an unknown account and a wrong code in friendly terms', async () => {
    await expect(signInWithEmailOtp('nobody.here@example.org')).rejects.toMatchObject({
      kind: 'unknown_user',
    });
    await signInWithEmailOtp(COLLECTOR);
    const code = await devOtp(COLLECTOR);
    const wrong = code === '000000' ? '111111' : '000000';
    const failure = await verifyOtp(COLLECTOR, wrong, 'email').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AuthFlowError);
    expect((failure as AuthFlowError).kind).toBe('code_invalid');
    expect(session.value).toBeNull();

    await verifyOtp(COLLECTOR, code, 'email');
    expect(session.value?.user.email).toBe(COLLECTOR);
    expect(tokenAal(session.value?.access_token)).toBe('aal1');
  });

  it('keeps the session in memory only until a PIN is chosen', async () => {
    expect(authState.value).toBe('pin_setup');
    expect(await pin.isSet()).toBe(false);
    expect(await vault.dump()).toEqual([]);
  });

  it('loads my_context() with the device id header', async () => {
    const ctx = await refreshContext();
    expect(ctx?.session_ok).toBe(true);
    expect(ctx?.device_id).toBe(deviceId());
    expect(ctx?.roles.map((r) => r.role)).toEqual(['field_collector']);
    expect(ctx?.mfa_required).toBe(false);
    expect(can.write.value).toBe(true);
    expect(can.review.value).toBe(false);
    expect(can.seeRestricted.value).toBe(false);
    expect(can.admin.value).toBe(false);
  });

  it('encrypts the session under the PIN: no token is readable at rest', async () => {
    await pin.set(PIN);
    expect(authState.value).toBe('ready');
    const current = session.value!;
    const text = await storedText();
    expect(text.length).toBeGreaterThan(500);
    expect(text).not.toContain(current.access_token);
    expect(text).not.toContain(current.refresh_token);
    expect(text).not.toContain('access_token');
    expect(text).not.toContain(COLLECTOR);
  });

  it('refreshes the token and persists the rotated session', async () => {
    const before = session.value!;
    const { data, error } = await supabase.auth.refreshSession();
    expect(error).toBeNull();
    expect(data.session?.refresh_token).not.toBe(before.refresh_token);
    expect(session.value?.refresh_token).toBe(data.session?.refresh_token);
    await vault.flush();
    const text = await storedText();
    expect(text).not.toContain(data.session!.refresh_token);
  });

  it('locks, refuses a wrong PIN, and unlocks without the network', async () => {
    const rotated = session.value!.refresh_token;
    pin.lock();
    expect(pin.locked.value).toBe(true);
    expect(authState.value).toBe('locked');
    expect(session.value).toBeNull();
    expect(me.value).toBeNull();
    expect(can.write.value).toBe(false);
    expect((await supabase.auth.getSession()).data.session).toBeNull();

    expect(await pin.unlock('135790')).toBe(false);
    expect(pin.attempts.value.failures).toBe(1);

    // "Offline": every request fails; unlocking must still work and bring back the cached context.
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new TypeError('fetch failed'));
    try {
      await new Promise((resolve) => setTimeout(resolve, 1100)); // throttle after one failure: 1 s
      expect(await pin.unlock(PIN)).toBe(true);
      expect(session.value?.refresh_token).toBe(rotated);
      expect(me.value?.roles[0]?.role).toBe('field_collector');
      expect(authState.value).toBe('ready');
      expect(can.write.value).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect((await refreshContext())?.session_ok).toBe(true);
  });

  it('signs out: local session wiped, refresh token revoked on the server', async () => {
    const old = session.value!.refresh_token;
    await signOut();
    expect(session.value).toBeNull();
    expect(authState.value).toBe('signed_out');
    expect(await pin.isSet()).toBe(false);
    expect(await vault.dump()).toEqual([]);
    expect(resets.at(-1)).toBe('sign_out');
    const replay = await fetch(`${API}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: ANON, 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: old }),
    });
    expect(replay.status).toBeGreaterThanOrEqual(400);
  });
});

describe('field collector — phone OTP', () => {
  it('signs in with an SMS code', async () => {
    await signInWithPhoneOtp(COLLECTOR_PHONE);
    await verifyOtp(COLLECTOR_PHONE, await devOtp(COLLECTOR_PHONE), 'sms');
    expect(session.value?.user.email).toBe(COLLECTOR);
    expect((await refreshContext())?.profile?.phone).toBe(COLLECTOR_PHONE);
    await signOut({ force: true });
    expect(session.value).toBeNull();
  });
});

describe('hq_admin — mandatory TOTP', () => {
  let factorId: string | null = null;

  /** A previous run died between verify and unenrol: finish its factor off with the saved secret. */
  async function removeLeftoverFactor(verifiedFactorId: string): Promise<void> {
    const saved = existsSync(TOTP_STATE)
      ? (JSON.parse(readFileSync(TOTP_STATE, 'utf8')) as { factorId: string; secret: string })
      : null;
    if (saved?.factorId !== verifiedFactorId) {
      throw new Error(
        `${HQ} already has a verified TOTP factor (${verifiedFactorId}) that this test did not create. ` +
          'Remove it (Auth admin API: DELETE /auth/v1/admin/users/<id>/factors/<factor id>, or npm run db:reset) and run again.',
      );
    }
    await verifyTotp(verifiedFactorId, totp(saved.secret));
    const { error } = await supabase.auth.mfa.unenroll({ factorId: verifiedFactorId });
    expect(error).toBeNull();
    rmSync(TOTP_STATE, { force: true });
    // Removing the factor ends the aal2 session's reason to exist: start again from aal1.
    await signOut({ force: true });
    await signInByEmail(HQ);
    await pin.set(PIN);
    await refreshContext();
  }

  afterAll(async () => {
    if (factorId && tokenAal(session.value?.access_token) === 'aal2') {
      const { error } = await supabase.auth.mfa.unenroll({ factorId });
      if (!error) rmSync(TOTP_STATE, { force: true });
    }
  });

  it('is held at the MFA gate after OTP sign-in', async () => {
    await signInByEmail(HQ);
    await pin.set(PIN);
    const ctx = await refreshContext();
    expect(ctx?.aal).toBe('aal1');
    expect(ctx?.mfa_required).toBe(true);
    expect(ctx?.roles).toEqual([]);
    expect(ctx?.assigned_roles.map((r) => r.role)).toEqual(['hq_admin']);
    expect(authState.value).toBe('mfa');
    expect(can.admin.value).toBe(false);
    expect(can.write.value).toBe(false);
  });

  it('enrols TOTP, rejects a wrong code, reaches aal2 with the right one', async () => {
    const status = await getMfaStatus();
    if (status.verifiedFactorId) await removeLeftoverFactor(status.verifiedFactorId);
    expect((await getMfaStatus()).verifiedFactorId).toBeNull();

    const enrolment = await startTotpEnrolment();
    factorId = enrolment.factorId;
    mkdirSync(path.dirname(TOTP_STATE), { recursive: true });
    writeFileSync(TOTP_STATE, JSON.stringify({ factorId, secret: enrolment.secret }));
    expect(enrolment.qrDataUrl.startsWith('data:image/svg+xml;charset=utf-8,%3Csvg')).toBe(true);
    expect(enrolment.secret).toMatch(/^[A-Z2-7]{16,}$/);

    const good = totp(enrolment.secret);
    const bad = good === '000000' ? '111111' : '000000';
    await expect(verifyTotp(factorId, bad)).rejects.toMatchObject({ kind: 'mfa_code_invalid' });
    expect(authState.value).toBe('mfa');

    await verifyTotp(factorId, totp(enrolment.secret));
    expect(tokenAal(session.value?.access_token)).toBe('aal2');
    const ctx = await refreshContext();
    expect(ctx?.aal).toBe('aal2');
    expect(ctx?.mfa_required).toBe(false);
    expect(ctx?.capabilities.is_hq).toBe(true);
    expect(ctx?.roles.map((r) => r.role)).toEqual(['hq_admin']);
    expect(authState.value).toBe('ready');
    expect(can.admin.value).toBe(true);
    expect(can.seeRestricted.value).toBe(true);
    if (process.env.AUTH_LIVE_PRINT_CONTEXT) console.info(JSON.stringify(ctx));

    // Neither the secret nor the tokens are stored in the clear.
    await vault.flush();
    const text = await storedText();
    expect(text).not.toContain(enrolment.secret);
    expect(text).not.toContain(session.value!.access_token);
  });

  it('stays aal2 across lock / unlock and a later challenge is not needed', async () => {
    pin.lock();
    expect(authState.value).toBe('locked');
    expect(await pin.unlock(PIN)).toBe(true);
    expect(tokenAal(session.value?.access_token)).toBe('aal2');
    expect(authState.value).toBe('ready');
    expect((await getMfaStatus()).verifiedFactorId).toBe(factorId);
  });

  it('removes its factor and signs out', async () => {
    const { error } = await supabase.auth.mfa.unenroll({ factorId: factorId! });
    expect(error).toBeNull();
    rmSync(TOTP_STATE, { force: true });
    factorId = null;
    await signOut({ force: true });
    expect(session.value).toBeNull();
    expect(authState.value).toBe('signed_out');
  });
});

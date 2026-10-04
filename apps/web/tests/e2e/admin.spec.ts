/**
 * Administration console (brief §2.6, §3, §15; docs/contracts/people-admin.md §6).
 *
 * One journey on the running stack:
 *  1. a seeded field collector signs in on device B (second browser profile);
 *  2. hq.admin signs in on device A: e-mail OTP → PIN → mandatory TOTP (enrolled here, the
 *     code computed from the shown key — RFC 6238);
 *  3. A assigns a role to the collector (role + scope type + branch) — checked on the server;
 *  4. A revokes all the collector's sessions → the collector's old access token no longer
 *     passes (`my_context().session_ok` false / refused) and device B is signed out with the
 *     "revoked" notice at its next server call;
 *  5. A removes the role again, adds a country and an option value without new code, then
 *     soft-deletes both again.
 *
 * Clean-up: the role, the country and the option value are soft-deleted again (service role
 * as a fallback), and the TOTP factor this run created for hq.admin is removed so that other
 * suites (auth.live) find the account as seeded.
 */
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import {
  appNavigate,
  firstPage,
  launchDevice,
  localEnv,
  newProfileDir,
  observe,
  PIN,
  readOtp,
  removeProfile,
  runTag,
  serviceSelect,
  serviceUpdate,
  signIn,
  SUPABASE_URL,
  unexpectedErrors,
  userIdOf,
  visible,
  waitFirstSync,
} from './helpers';

const HQ = 'hq.admin@example.org';
/** A seeded account without MFA whose sessions this test may end (it signs in again later). */
const TARGET = 'collector.mombasa@example.org';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
/** Secret of the factor this run created, kept until it is removed (git-ignored). */
const TOTP_STATE = join(ROOT, '.local', 'tmp', 'e2e-admin-totp-hq.admin.json');

// ---------------------------------------------------------------------------------------------
// TOTP (RFC 6238: SHA-1, 6 digits, 30 s — what GoTrue and the local gateway issue)
// ---------------------------------------------------------------------------------------------

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

function totp(secret: string, atMs = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 30_000)));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const bin =
    (((mac[offset] as number) & 0x7f) << 24) |
    ((mac[offset + 1] as number) << 16) |
    ((mac[offset + 2] as number) << 8) |
    (mac[offset + 3] as number);
  return String(bin % 1_000_000).padStart(6, '0');
}

/** A code that stays valid for a few seconds (never the last 3 s of a period). */
async function freshTotp(secret: string): Promise<string> {
  const left = 30_000 - (Date.now() % 30_000);
  if (left < 3_000) await new Promise((r) => setTimeout(r, left + 200));
  return totp(secret);
}

// ---------------------------------------------------------------------------------------------
// Service-role helpers of the test runner (never given to the app)
// ---------------------------------------------------------------------------------------------

function serviceHeaders(): Record<string, string> {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? localEnv().SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY missing (.env.local or environment)');
  return { apikey: key, Authorization: `Bearer ${key}` };
}

function anonKey(): string {
  const key = process.env.VITE_SUPABASE_ANON_KEY ?? localEnv().VITE_SUPABASE_ANON_KEY;
  if (!key) throw new Error('VITE_SUPABASE_ANON_KEY missing');
  return key;
}

interface Factor {
  id: string;
  status?: string;
  factor_type?: string;
}

async function listFactors(request: APIRequestContext, userId: string): Promise<Factor[]> {
  const response = await request.get(`${SUPABASE_URL}/auth/v1/admin/users/${userId}/factors`, {
    headers: serviceHeaders(),
  });
  expect(response.ok(), `factors: ${response.status()}`).toBe(true);
  const body = (await response.json()) as Factor[] | { factors?: Factor[] };
  return Array.isArray(body) ? body : (body.factors ?? []);
}

async function deleteFactor(
  request: APIRequestContext,
  userId: string,
  factorId: string,
): Promise<void> {
  const response = await request.delete(
    `${SUPABASE_URL}/auth/v1/admin/users/${userId}/factors/${factorId}`,
    { headers: serviceHeaders() },
  );
  expect([200, 204, 404]).toContain(response.status());
}

/**
 * hq.admin must reach the enrolment screen (the key is only shown there): a verified factor
 * left by an interrupted run of this spec is removed. Unverified factors do not matter.
 */
async function prepareTotp(request: APIRequestContext, userId: string): Promise<void> {
  const verified = (await listFactors(request, userId)).filter((f) => f.status === 'verified');
  for (const factor of verified) {
    // Left over by an earlier run of this spec, or by an interrupted auth.live run — both are
    // throw-away test factors of a seeded staging account on the local stack.
    await deleteFactor(request, userId, factor.id);
  }
}

// ---------------------------------------------------------------------------------------------
// Sign-in of a manager / HQ account: OTP → PIN → TOTP
// ---------------------------------------------------------------------------------------------

async function signInWithTotp(
  page: Page,
  request: APIRequestContext,
  email: string,
): Promise<string> {
  await page.goto('/');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-code')).toBeVisible();
  const code = await readOtp(request, email);
  await page.getByTestId('login-code').fill(code);
  await page.getByTestId('login-verify').click();
  await expect(page.getByTestId('pin-confirm')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('pin-input').fill(PIN);
  await page.getByTestId('pin-confirm').fill(PIN);
  await page.getByTestId('pin-submit').click();

  await expect(page.getByTestId('mfa-view')).toBeVisible({ timeout: 30_000 });
  const secretEl = page.getByTestId('mfa-secret');
  await expect(secretEl).toBeVisible({ timeout: 30_000 });
  const secret = ((await secretEl.textContent()) ?? '').replace(/\s+/g, '');
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  mkdirSync(join(ROOT, '.local', 'tmp'), { recursive: true });
  writeFileSync(TOTP_STATE, JSON.stringify({ email, secret, at: new Date().toISOString() }));

  await page.getByTestId('mfa-code').fill(await freshTotp(secret));
  await page.getByTestId('mfa-verify').click();
  await expect(page.getByTestId('sync-badge')).toBeVisible({ timeout: 30_000 });
  return secret;
}

// ---------------------------------------------------------------------------------------------

/** Two letters / three letters that no country (live or deleted) uses yet. */
async function freeCountryCodes(
  request: APIRequestContext,
): Promise<{ iso2: string; iso3: string }> {
  const rows = await serviceSelect<{ iso2: string; iso3: string | null }>(
    request,
    'countries?select=iso2,iso3',
  );
  const used2 = new Set(rows.map((r) => r.iso2));
  const used3 = new Set(rows.map((r) => r.iso3).filter(Boolean));
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (let i = 0; i < 2000; i++) {
    const pick = () => letters[Math.floor(Math.random() * 26)] as string;
    const iso2 = `Q${pick()}`;
    const iso3 = `Q${pick()}${pick()}`;
    if (!used2.has(iso2) && !used3.has(iso3)) return { iso2, iso3 };
  }
  throw new Error('no free test country code left (QA–QZ)');
}

test.describe('administration console', () => {
  test.setTimeout(420_000);

  test('HQ with TOTP assigns a role, revokes sessions (the other device is signed out), adds and removes a country and an option value', async ({
    request,
  }) => {
    const tag = runTag();
    const hqId = await userIdOf(request, HQ);
    const targetId = await userIdOf(request, TARGET);
    const branch = (
      await serviceSelect<{ id: string }>(
        request,
        'branches?select=id&code=eq.MOMBASA&deleted_at=is.null',
      )
    )[0];
    expect(branch, 'seed branch MOMBASA').toBeTruthy();
    await prepareTotp(request, hqId);

    const dirA = newProfileDir('admin-hq');
    const dirB = newProfileDir('admin-target');
    let deviceA: BrowserContext | null = null;
    let deviceB: BrowserContext | null = null;
    const created = {
      roleIds: [] as string[],
      countryIds: [] as string[],
      optionIds: [] as string[],
    };

    try {
      // -- 1. the collector's device ----------------------------------------------------------
      deviceB = await launchDevice(dirB);
      const seenB = await observe(deviceB);
      const pageB = await firstPage(deviceB);
      const tokensB: string[] = [];
      deviceB.on('request', (req) => {
        if (!req.url().startsWith(SUPABASE_URL)) return;
        const auth = req.headers().authorization ?? '';
        const token = auth.replace(/^Bearer\s+/i, '');
        if (token.split('.').length === 3 && token !== anonKey()) tokensB.push(token);
      });
      await signIn(pageB, request, TARGET);
      await waitFirstSync(pageB);
      const oldToken = tokensB.at(-1);
      expect(oldToken, 'device B used a user token').toBeTruthy();

      // The token works before the revocation.
      const before = await request.post(`${SUPABASE_URL}/rest/v1/rpc/my_context`, {
        headers: {
          apikey: anonKey(),
          Authorization: `Bearer ${oldToken}`,
          'Content-Type': 'application/json',
        },
        data: {},
      });
      expect(before.ok()).toBe(true);
      expect(((await before.json()) as { session_ok?: boolean }).session_ok).toBe(true);

      // -- 2. head office with the mandatory second factor -----------------------------------
      deviceA = await launchDevice(dirA);
      const seenA = await observe(deviceA);
      const page = await firstPage(deviceA);
      await signInWithTotp(page, request, HQ);
      await waitFirstSync(page);

      await appNavigate(page, '/admin');
      await expect(page.getByTestId('admin-page')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('admin-page')).toHaveAttribute('data-role', 'hq');
      await appNavigate(page, '/admin/users');

      // -- 3. assign a role ------------------------------------------------------------------
      await page.getByTestId('admin-users-search').fill(TARGET);
      const row = page.locator(`[data-testid="admin-user-row"][data-user-id="${targetId}"]`);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.click();
      const detail = page.getByTestId('admin-user-detail');
      await expect(detail).toHaveAttribute('data-user-id', targetId);

      await page.getByTestId('admin-user-add-role').click();
      await expect(page.getByTestId('admin-role-dialog')).toBeVisible();
      // Validation first: nothing chosen.
      await page.getByTestId('admin-role-save').click();
      await expect(page.getByTestId('admin-role-dialog')).toBeVisible();
      await page.getByTestId('admin-role-role').selectOption('viewer');
      await page.getByTestId('admin-role-scope-type').selectOption('branch');
      await page.getByTestId('admin-role-scope').selectOption(branch!.id);
      await page.getByTestId('admin-role-save').click();
      await expect(page.getByTestId('admin-role-dialog')).toHaveCount(0, { timeout: 20_000 });

      const viewerItem = detail.locator('[data-testid="admin-role-item"][data-role="viewer"]');
      await expect(viewerItem).toBeVisible({ timeout: 20_000 });
      const grants = await serviceSelect<{ id: string; scope_type: string; scope_id: string }>(
        request,
        `user_roles?select=id,scope_type,scope_id&user_id=eq.${targetId}&role=eq.viewer&deleted_at=is.null`,
      );
      expect(grants).toHaveLength(1);
      expect(grants[0]).toMatchObject({ scope_type: 'branch', scope_id: branch!.id });
      created.roleIds.push(grants[0]!.id);

      // -- 4. revoke every session of the collector -------------------------------------------
      await page.getByTestId('admin-user-revoke').click();
      await expect(page.getByTestId('confirm-dialog')).toBeVisible();
      await page.getByTestId('confirm-ok').click();
      await expect(page.getByTestId('admin-user-revoked-at')).toBeVisible({ timeout: 20_000 });

      const profile = await serviceSelect<{ sessions_revoked_at: string | null }>(
        request,
        `profiles?select=sessions_revoked_at&id=eq.${targetId}`,
      );
      expect(profile[0]?.sessions_revoked_at).toBeTruthy();

      // The old access token no longer passes (its next statement sees a dead session).
      const after = await request.post(`${SUPABASE_URL}/rest/v1/rpc/my_context`, {
        headers: {
          apikey: anonKey(),
          Authorization: `Bearer ${oldToken}`,
          'Content-Type': 'application/json',
        },
        data: {},
      });
      if (after.ok()) {
        expect(((await after.json()) as { session_ok?: boolean } | null)?.session_ok ?? false).toBe(
          false,
        );
      } else {
        expect([401, 403]).toContain(after.status());
      }

      // Device B: its next server call ends the session — back to sign-in with the notice.
      await visible(pageB, 'sync-now')
        .click({ timeout: 10_000 })
        .catch(() => undefined);
      await expect(pageB.getByTestId('login-email')).toBeVisible({ timeout: 90_000 });
      await expect(pageB.getByTestId('login-notice')).toBeVisible();

      // -- 5a. remove the role again (UI) -----------------------------------------------------
      await viewerItem.getByTestId('admin-role-remove').click();
      await page.getByTestId('confirm-ok').click();
      await expect(viewerItem).toHaveCount(0, { timeout: 20_000 });
      const left = await serviceSelect(
        request,
        `user_roles?select=id&id=eq.${created.roleIds[0]}&deleted_at=is.null`,
      );
      expect(left).toHaveLength(0);
      created.roleIds = [];

      // -- 5b. a new country without new code -------------------------------------------------
      const { iso2, iso3 } = await freeCountryCodes(request);
      await appNavigate(page, '/admin/countries');
      await page.getByTestId('admin-country-add').click();
      await expect(page.getByTestId('admin-country-dialog')).toBeVisible();
      await page.getByTestId('admin-country-save').click(); // empty → validation, stays open
      await expect(page.getByTestId('admin-country-dialog')).toBeVisible();
      await page.getByTestId('admin-country-iso2').fill(iso2);
      await page.getByTestId('admin-country-iso3').fill(iso3);
      await page.getByTestId('admin-country-name-ar').fill(`دولة اختبار ${tag}`);
      await page.getByTestId('admin-country-name-en').fill(`Test country ${tag}`);
      await page.getByTestId('admin-country-name-sw').fill(`Nchi ya majaribio ${tag}`);
      await page.getByTestId('admin-country-currency').fill('USD');
      await page.getByTestId('admin-country-save').click();
      await expect(page.getByTestId('admin-country-dialog')).toHaveCount(0, { timeout: 20_000 });
      const countryRow = page.locator(`[data-testid="admin-country-row"][data-iso2="${iso2}"]`);
      await expect(countryRow).toBeVisible({ timeout: 20_000 });
      const countries = await serviceSelect<{
        id: string;
        name_en: string;
        default_currency: string;
      }>(request, `countries?select=id,name_en,default_currency&iso2=eq.${iso2}`);
      expect(countries).toHaveLength(1);
      expect(countries[0]).toMatchObject({
        name_en: `Test country ${tag}`,
        default_currency: 'USD',
      });
      created.countryIds.push(countries[0]!.id);

      await countryRow.getByTestId('admin-country-delete').click();
      await page.getByTestId('confirm-ok').click();
      await expect(countryRow).toHaveCount(0, { timeout: 20_000 });
      const countryAfter = await serviceSelect<{ deleted_at: string | null }>(
        request,
        `countries?select=deleted_at&id=eq.${created.countryIds[0]}`,
      );
      expect(countryAfter[0]?.deleted_at).toBeTruthy();
      created.countryIds = [];

      // -- 5c. a new option value of a list ---------------------------------------------------
      const code = `e2e_${tag}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      await appNavigate(page, '/admin/options');
      await page.getByTestId('admin-options-list').selectOption('livelihoods');
      await page.getByTestId('admin-option-add').click();
      await expect(page.getByTestId('admin-option-dialog')).toBeVisible();
      await page.getByTestId('admin-option-name-ar').fill(`خيار اختبار ${tag}`);
      await page.getByTestId('admin-option-name-en').fill(`Test option ${tag}`);
      await page.getByTestId('admin-option-name-sw').fill(`Chaguo la majaribio ${tag}`);
      await page.getByTestId('admin-option-code').fill(code);
      await expect(page.getByTestId('admin-option-sort')).not.toHaveValue('');
      await page.getByTestId('admin-option-save').click();
      await expect(page.getByTestId('admin-option-dialog')).toHaveCount(0, { timeout: 20_000 });
      const optionRow = page.locator(`[data-testid="admin-option-row"][data-code="${code}"]`);
      await expect(optionRow).toBeVisible({ timeout: 20_000 });
      const options = await serviceSelect<{ id: string; list_key: string; name_sw: string }>(
        request,
        `option_values?select=id,list_key,name_sw&code=eq.${code}`,
      );
      expect(options).toHaveLength(1);
      expect(options[0]).toMatchObject({
        list_key: 'livelihoods',
        name_sw: `Chaguo la majaribio ${tag}`,
      });
      created.optionIds.push(options[0]!.id);

      await optionRow.getByTestId('admin-option-delete').click();
      await page.getByTestId('confirm-ok').click();
      await expect(optionRow).toHaveCount(0, { timeout: 20_000 });
      const optionAfter = await serviceSelect<{ deleted_at: string | null }>(
        request,
        `option_values?select=deleted_at&id=eq.${created.optionIds[0]}`,
      );
      expect(optionAfter[0]?.deleted_at).toBeTruthy();
      created.optionIds = [];

      // -- hygiene -----------------------------------------------------------------------------
      expect(seenA.cspViolations).toEqual([]);
      expect(seenA.foreignRequests).toEqual([]);
      expect(unexpectedErrors(seenA.consoleErrors)).toEqual([]);
      expect(seenB.cspViolations).toEqual([]);
      expect(seenB.foreignRequests).toEqual([]);
    } finally {
      const now = new Date().toISOString();
      for (const id of created.roleIds)
        await serviceUpdate(request, `user_roles?id=eq.${id}&deleted_at=is.null`, {
          deleted_at: now,
        }).catch(() => undefined);
      for (const id of created.countryIds)
        await serviceUpdate(request, `countries?id=eq.${id}&deleted_at=is.null`, {
          deleted_at: now,
        }).catch(() => undefined);
      for (const id of created.optionIds)
        await serviceUpdate(request, `option_values?id=eq.${id}&deleted_at=is.null`, {
          deleted_at: now,
        }).catch(() => undefined);
      await deviceA?.close().catch(() => undefined);
      await deviceB?.close().catch(() => undefined);
      removeProfile(dirA);
      removeProfile(dirB);
      // Leave hq.admin as seeded (no verified factor) for the other suites.
      try {
        for (const factor of await listFactors(request, hqId))
          await deleteFactor(request, hqId, factor.id);
        if (existsSync(TOTP_STATE)) rmSync(TOTP_STATE, { force: true });
      } catch {
        // the next run's prepareTotp() removes it
      }
    }
  });
});

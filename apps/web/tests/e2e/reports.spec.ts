/**
 * Reports, export and print (brief §9, §10, §11; docs/contracts/reports-import-export.md).
 *
 * Two journeys on the running stack:
 *  1. manager.tz signs in (e-mail OTP → PIN → mandatory TOTP enrolled here, the code computed
 *     from the shown key — RFC 6238). The dashboard shows the monthly payroll per currency
 *     and its USD total. An XLSX export in Arabic is requested: the job finishes, the
 *     notification arrives in the bell, the file downloads and has Arabic headers and
 *     translated values (record state "معتمد", not "approved").
 *  2. collector2.pemba (Arabic profile) opens the print card of an approved PEMBA project
 *     that has a paid staff member: the document is right-to-left Arabic, the staff table is
 *     there, and neither the salary option nor any salary figure is shown — the server does
 *     not even send one.
 *
 * Clean-up: the export job and its notification are soft-deleted (service role) and the TOTP
 * factor this run created for manager.tz is removed so other suites find the account as
 * seeded.
 */
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import * as XLSX from 'xlsx';
import {
  appNavigate,
  localEnv,
  observe,
  PIN,
  readOtp,
  serviceSelect,
  serviceUpdate,
  signIn,
  SUPABASE_URL,
  unexpectedErrors,
  userIdOf,
} from './helpers';

const MANAGER = 'manager.tz@example.org';
const COLLECTOR = 'collector2.pemba@example.org';
/** Seeded approved PEMBA project with one staff member who has a compensation row. */
const PRINT_PROJECT_CODE = 'TZ-PN-000008';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const TOTP_STATE = join(ROOT, '.local', 'tmp', 'e2e-reports-totp-manager.tz.json');
const SHOTS = join(ROOT, '.local', 'screens');

const ARABIC = /[؀-ۿ]/;
const RECORD_STATES_AR = ['مسودة', 'مُرسل للمراجعة', 'معتمد', 'مُعاد للتعديل'];

// ---------------------------------------------------------------------------------------------
// TOTP (RFC 6238: SHA-1, 6 digits, 30 s)
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

async function freshTotp(secret: string): Promise<string> {
  const left = 30_000 - (Date.now() % 30_000);
  if (left < 3_000) await new Promise((r) => setTimeout(r, left + 200));
  return totp(secret);
}

function serviceHeaders(): Record<string, string> {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? localEnv().SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY missing (.env.local or environment)');
  return { apikey: key, Authorization: `Bearer ${key}` };
}

interface Factor {
  id: string;
  status?: string;
}

async function listFactors(request: APIRequestContext, userId: string): Promise<Factor[]> {
  const response = await request.get(`${SUPABASE_URL}/auth/v1/admin/users/${userId}/factors`, {
    headers: serviceHeaders(),
  });
  expect(response.ok(), `factors: ${response.status()}`).toBe(true);
  const body = (await response.json()) as Factor[] | { factors?: Factor[] };
  return Array.isArray(body) ? body : (body.factors ?? []);
}

async function deleteFactors(
  request: APIRequestContext,
  userId: string,
  onlyVerified: boolean,
): Promise<void> {
  for (const factor of await listFactors(request, userId)) {
    if (onlyVerified && factor.status !== 'verified') continue;
    const response = await request.delete(
      `${SUPABASE_URL}/auth/v1/admin/users/${userId}/factors/${factor.id}`,
      { headers: serviceHeaders() },
    );
    expect([200, 204, 404]).toContain(response.status());
  }
}

/** OTP → PIN → TOTP enrolment (the key is only shown at enrolment). */
async function signInWithTotp(page: Page, request: APIRequestContext, email: string) {
  await page.goto('/');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-code')).toBeVisible();
  await page.getByTestId('login-code').fill(await readOtp(request, email));
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
}

// ---------------------------------------------------------------------------------------------

test.describe('reports, export and print', () => {
  test.setTimeout(360_000);

  test('manager with TOTP: payroll per currency + USD, Arabic XLSX export downloads with Arabic headers and values', async ({
    browser,
    request,
  }) => {
    const managerId = await userIdOf(request, MANAGER);
    await deleteFactors(request, managerId, true);
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    const seen = await observe(context, page);
    const startedAt = new Date().toISOString();
    try {
      await signInWithTotp(page, request, MANAGER);

      // -- dashboard -----------------------------------------------------------------------
      await appNavigate(page, '/reports');
      await expect(page.getByTestId('reports-page')).toBeVisible();
      await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 60_000 });
      const payroll = page.getByTestId('dash-payroll');
      await expect(payroll).toBeVisible();
      const rows = payroll.getByTestId('dash-payroll-row');
      await expect(rows.first()).toBeVisible();
      const currencies = await rows.evaluateAll((els) =>
        els.map((el) => el.getAttribute('data-currency')),
      );
      expect(currencies.length).toBeGreaterThan(0);
      for (const c of currencies) expect(c).toMatch(/^[A-Z]{3}$/);
      await expect(rows.first().getByTestId('dash-payroll-local')).toHaveText(/\d/);
      await expect(payroll.getByTestId('dash-payroll-usd')).toHaveText(/\d/);
      await page.screenshot({ path: join(SHOTS, 'reports-dashboard-manager.png'), fullPage: true });

      // -- export XLSX in Arabic -----------------------------------------------------------
      await page.getByTestId('reports-export').click();
      const dialog = page.getByTestId('export-dialog');
      await expect(dialog).toBeVisible();
      await dialog.getByTestId('export-format-xlsx').check();
      await dialog.getByTestId('export-lang-ar').check();
      await dialog.getByTestId('export-submit').click();
      await expect(dialog).toBeHidden({ timeout: 30_000 });

      const job = page.getByTestId('export-job-row').first();
      await expect(job).toHaveAttribute('data-state', 'done', { timeout: 180_000 });
      const jobId = (await job.getAttribute('data-id')) as string;
      expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
      const serverJob = await serviceSelect<{ format: string; lang: string; state: string }>(
        request,
        `export_jobs?select=format,lang,state&id=eq.${jobId}`,
      );
      expect(serverJob[0]).toMatchObject({ format: 'xlsx', lang: 'ar', state: 'done' });

      // The export.ready notification reaches the bell (pulled by the sync after the job).
      await expect(page.getByTestId('notifications-count')).toHaveText(/[1-9١-٩]/, {
        timeout: 90_000,
      });

      // The download link is issued by the export function (fixed lifetime, own live job);
      // the browser never signs export files itself.
      const linkRequests: string[] = [];
      page.on('request', (r) => {
        const u = r.url();
        if (u.includes('/storage/v1/object/sign/') || u.includes('/functions/v1/export'))
          linkRequests.push(`${r.method()} ${u}`);
      });
      const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
      await job.getByTestId('export-download').click();
      const download = await downloadPromise;
      expect(
        linkRequests.some((l) => l.startsWith(`GET `) && l.includes(`export?job=${jobId}`)),
      ).toBe(true);
      expect(
        linkRequests.filter((l) => l.startsWith('POST ') && l.includes('/object/sign/')),
      ).toEqual([]);
      expect(download.suggestedFilename()).toMatch(/\.xlsx$/i);
      const filePath = await download.path();
      const workbook = XLSX.read(readFileSync(filePath), { type: 'buffer' });
      const sheetName = workbook.SheetNames[0] as string;
      expect(sheetName).toBe('المشاريع');
      const table = XLSX.utils.sheet_to_json<unknown[]>(
        workbook.Sheets[sheetName] as XLSX.WorkSheet,
        {
          header: 1,
          raw: false,
          defval: '',
        },
      );
      const header = (table[0] ?? []).map(String);
      expect(header.length).toBeGreaterThan(10);
      for (const h of header) expect(h).toMatch(ARABIC);
      expect(header[0]).toBe('رمز المشروع');
      // Phones stay E.164 in XLSX: no formula-guard apostrophe in the value (inline strings
      // are never evaluated; formula-looking text carries a quotePrefix style instead).
      const phoneCol = header.indexOf('هاتف المسؤول');
      expect(phoneCol).toBeGreaterThanOrEqual(0);
      const phones = table
        .slice(1)
        .map((r) => String(r[phoneCol] ?? ''))
        .filter((v) => v !== '');
      expect(phones.length).toBeGreaterThan(0);
      for (const v of phones) expect(v).toMatch(/^\+\d{6,15}$/);
      const stateCol = header.indexOf('حالة السجل');
      expect(stateCol).toBeGreaterThanOrEqual(0);
      const dataRows = table.slice(1).filter((r) => r.length > 0);
      expect(dataRows.length).toBeGreaterThan(0);
      for (const r of dataRows) {
        const value = String(r[stateCol] ?? '');
        expect(RECORD_STATES_AR, `record state cell "${value}"`).toContain(value);
      }
      const typeCol = header.indexOf('النوع');
      expect(typeCol).toBeGreaterThanOrEqual(0);
      for (const r of dataRows) {
        const value = String(r[typeCol] ?? '');
        if (value) expect(value).toMatch(ARABIC);
      }

      // -- hygiene -------------------------------------------------------------------------
      expect(seen.cspViolations).toEqual([]);
      expect(seen.foreignRequests).toEqual([]);
      expect(unexpectedErrors(seen.consoleErrors)).toEqual([]);
    } finally {
      const now = new Date().toISOString();
      const removed = await serviceUpdate<{ storage_path: string | null }>(
        request,
        `export_jobs?user_id=eq.${managerId}&created_at=gte.${startedAt}&deleted_at=is.null`,
        { deleted_at: now },
      ).catch(() => [] as Array<{ storage_path: string | null }>);
      // A soft-deleted job keeps no file behind (it holds payroll columns).
      const files = removed.map((j) => j.storage_path).filter((p): p is string => !!p);
      if (files.length > 0) {
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? localEnv().SUPABASE_SERVICE_ROLE_KEY;
        await request
          .delete(`${SUPABASE_URL}/storage/v1/object/exports`, {
            headers: {
              apikey: key!,
              Authorization: `Bearer ${key}`,
              'Content-Type': 'application/json',
            },
            data: { prefixes: files },
          })
          .catch(() => undefined);
      }
      await serviceUpdate(
        request,
        `notifications?user_id=eq.${managerId}&created_at=gte.${startedAt}&deleted_at=is.null`,
        { deleted_at: now },
      ).catch(() => undefined);
      await context.close().catch(() => undefined);
      try {
        await deleteFactors(request, managerId, false);
        if (existsSync(TOTP_STATE)) rmSync(TOTP_STATE, { force: true });
      } catch {
        // the next run removes it before it starts
      }
    }
  });

  test('collector prints a project card: right-to-left Arabic, staff listed, no salary anywhere', async ({
    browser,
    request,
  }) => {
    const [project] = await serviceSelect<{ id: string }>(
      request,
      `projects?select=id&code=eq.${PRINT_PROJECT_CODE}&deleted_at=is.null`,
    );
    expect(project, `seeded project ${PRINT_PROJECT_CODE}`).toBeTruthy();
    const context = await browser.newContext();
    const page = await context.newPage();
    const seen = await observe(context, page);
    try {
      await signIn(page, request, COLLECTOR);
      const reportBody = page.waitForResponse(
        (r) => r.url().includes('/rest/v1/rpc/report_project') && r.request().method() === 'POST',
        { timeout: 60_000 },
      );
      await appNavigate(page, `/reports/print/project/${(project as { id: string }).id}`);
      const response = await reportBody;
      expect(response.ok()).toBe(true);
      const text = await response.text();
      expect(text).not.toContain('monthly_amount');

      const doc = page.getByTestId('print-doc');
      await expect(doc).toBeVisible({ timeout: 60_000 });
      await expect(doc).toHaveAttribute('dir', 'rtl');
      await expect(doc).toHaveAttribute('lang', 'ar');
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(doc).toHaveAttribute('data-kind', 'project');
      await expect(doc.getByTestId('print-code')).toContainText(PRINT_PROJECT_CODE);
      await expect(doc.getByTestId('print-staff-row').first()).toBeVisible();
      await expect(page.getByTestId('print-salary')).toHaveCount(0);
      await expect(page.getByTestId('print-show-salaries')).toHaveCount(0);
      const direction = await doc.evaluate((el) => getComputedStyle(el).direction);
      expect(direction).toBe('rtl');
      await page.screenshot({ path: join(SHOTS, 'reports-print-collector.png'), fullPage: true });

      expect(seen.cspViolations).toEqual([]);
      expect(seen.foreignRequests).toEqual([]);
      expect(unexpectedErrors(seen.consoleErrors)).toEqual([]);
    } finally {
      await context.close().catch(() => undefined);
    }
  });
});

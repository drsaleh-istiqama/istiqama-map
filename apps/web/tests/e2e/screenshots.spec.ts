/**
 * Screenshots of the user guides (brief §14.9: docs/USER_GUIDE_ar.md, docs/USER_GUIDE_sw.md).
 *
 * NOT part of the regular e2e run: it only runs with `GUIDE_SCREENS=1`.
 *
 *   GUIDE_SCREENS=1 npx playwright test screenshots.spec.ts      (from apps/web, stack running)
 *   python docs/screens/optimize.py                               (palette PNGs → docs/screens/{ar,sw})
 *
 * Raw PNGs are written to `.local/screens/guide/<lang>/` (git-ignored); the optimiser turns them
 * into the small palette PNGs under `docs/screens/<lang>/` that the guides reference.
 *
 * Journeys, each once in Arabic and once in Swahili (language chosen on the sign-in screen):
 *   1. collector.pemba on a phone: sign-in, PIN, map, list, details, maintenance, incomplete
 *      records, the project form section by section, GPS accuracy warning, photos, duplicate
 *      warning, import wizard (preview only), settings, and the sync badge states
 *      (synced → offline → pending; the offline entry never reaches the server);
 *   2. a second collector device holding v2 data: the migration offer and its summary
 *      (cancelled — nothing is migrated);
 *   3. supervisor.pemba on a phone: review queue, a conflict (inserted for the shot and
 *      soft-deleted again), villages, people, person card, merge dialog (cancelled);
 *   4. manager.tz with TOTP (phone + desktop): reports dashboard, export dialog (not sent),
 *      print card, administration (users, user detail, revoke confirmation — cancelled,
 *      devices / sync status).
 *
 * Clean-up: the staged import batch, the injected conflict and the TOTP factor are removed or
 * soft-deleted; no project, person or role is created on the server.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chromium,
  devices,
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import {
  appNavigate,
  BASE_URL,
  firstPage,
  localEnv,
  makeJpeg,
  newProfileDir,
  PIN,
  readOtp,
  removeProfile,
  serviceSelect,
  serviceUpdate,
  SUPABASE_URL,
  userIdOf,
  visible,
  waitFirstSync,
} from './helpers';

const COLLECTOR = 'collector.pemba@example.org';
const SUPERVISOR = 'supervisor.pemba@example.org';
const MANAGER = 'manager.tz@example.org';

/** Seeded approved Pemba mosque under maintenance, with staff and a compensation row. */
const DETAILS_CODE = 'TZ-PN-000008';
/** Seeded approved mosque used to trigger the duplicate warning (150 m rule). */
const DUP_CODE = 'TZ-PN-000001';
const DUP_POINT = { latitude: -5.0552, longitude: 39.7292 };
/** Seeded submitted Pemba project that receives the injected conflict. */
const CONFLICT_CODE = 'TZ-PN-000009';
/** North Pemba, away from every seeded project. */
const FREE_POINT = { latitude: -5.012, longitude: 39.781 };

const LANGS = ['ar', 'sw'] as const;
type Lang = (typeof LANGS)[number];

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const RAW_DIR = join(ROOT, '.local', 'screens', 'guide');

const PHONE = devices['Pixel 5'];
const DESKTOP = { width: 1280, height: 800 };

test.skip(!process.env.GUIDE_SCREENS, 'guide screenshots: run with GUIDE_SCREENS=1');
test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

// ---------------------------------------------------------------------------------------------
// Devices and screenshots
// ---------------------------------------------------------------------------------------------

async function launchPhone(
  dir: string,
  geolocation: { latitude: number; longitude: number; accuracy?: number } = {
    ...FREE_POINT,
    accuracy: 5,
  },
): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext(dir, {
    channel: 'chrome',
    headless: !process.env.E2E_HEADED,
    baseURL: BASE_URL,
    locale: 'en-US',
    serviceWorkers: 'allow',
    viewport: PHONE.viewport,
    userAgent: PHONE.userAgent,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    geolocation,
    permissions: ['geolocation'],
    acceptDownloads: true,
  });
  await context.grantPermissions(['geolocation'], { origin: BASE_URL });
  return context;
}

async function launchDesktop(dir: string): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext(dir, {
    channel: 'chrome',
    headless: !process.env.E2E_HEADED,
    baseURL: BASE_URL,
    locale: 'en-US',
    serviceWorkers: 'allow',
    viewport: DESKTOP,
    deviceScaleFactor: 1,
    acceptDownloads: true,
  });
  return context;
}

/** Screenshot writer of one language. Failures never fail the journey (best effort). */
function shooter(lang: Lang) {
  const dir = join(RAW_DIR, lang);
  mkdirSync(dir, { recursive: true });
  const taken: string[] = [];
  return {
    taken,
    /** Viewport screenshot (after transitions settle). */
    async page(page: Page, name: string): Promise<void> {
      await page
        .evaluate(() => {
          window.scrollTo(0, 0);
          document.documentElement.scrollTop = 0;
          document.body.scrollTop = 0;
        })
        .catch(() => undefined);
      await page.waitForTimeout(400);
      await page
        .screenshot({ path: join(dir, `${name}.png`), animations: 'disabled' })
        .then(() => taken.push(name))
        .catch((e: Error) => console.warn(`shot ${lang}/${name}: ${e.message}`));
    },
    /** One element (with a small margin of page around it). */
    async element(locator: Locator, name: string): Promise<void> {
      await locator.scrollIntoViewIfNeeded().catch(() => undefined);
      await locator.page().waitForTimeout(300);
      await locator
        .screenshot({ path: join(dir, `${name}.png`), animations: 'disabled' })
        .then(() => taken.push(name))
        .catch((e: Error) => console.warn(`shot ${lang}/${name}: ${e.message}`));
    },
  };
}

type Shooter = ReturnType<typeof shooter>;

async function isShown(locator: Locator, timeout = 5_000): Promise<boolean> {
  return locator
    .first()
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);
}

/** Scrolls `locator` to the top of the scrolling `<main>` (so the shot shows what follows it). */
async function scrollToTop(locator: Locator): Promise<void> {
  await locator
    .first()
    .evaluate((el) => {
      // Scroll only the shell's <main> (or the dialog body holding the element): scrolling
      // the document itself would shift the fixed shell and leave a blank band in the shot.
      let box: HTMLElement | null = el.parentElement;
      while (
        box &&
        !(
          box.scrollHeight > box.clientHeight + 2 &&
          /(auto|scroll)/.test(getComputedStyle(box).overflowY)
        )
      )
        box = box.parentElement;
      if (box) {
        const delta = el.getBoundingClientRect().top - box.getBoundingClientRect().top - 8;
        box.scrollTop += delta;
      }
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    })
    .catch(() => undefined);
  await locator
    .page()
    .waitForTimeout(250)
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------------------------
// Sign-in with screenshots (e-mail OTP → PIN [→ TOTP])
// ---------------------------------------------------------------------------------------------

async function signInShots(
  page: Page,
  request: APIRequestContext,
  email: string,
  lang: Lang,
  shot: Shooter | null,
  opts: { totp?: boolean } = {},
): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('login-email')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId(`lang-${lang}`).click();
  await page.waitForFunction((l) => document.documentElement.lang === l, lang);
  await page.getByTestId('login-email').fill(email);
  const loginShots = opts.totp ? null : shot; // phone sign-in shots come from the collector
  if (loginShots) await loginShots.page(page, 'login-email');
  const before = await request
    .get(`${SUPABASE_URL}/dev/otp?identifier=${encodeURIComponent(email)}`)
    .then(async (r) => (r.ok() ? String(((await r.json()) as { code?: unknown }).code ?? '') : ''))
    .catch(() => '');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-code')).toBeVisible();
  let code = await readOtp(request, email);
  if (before && code === before) {
    await page.waitForTimeout(800);
    code = await readOtp(request, email);
  }
  await page.getByTestId('login-code').fill(code);
  if (loginShots) await loginShots.page(page, 'login-code');
  await page.getByTestId('login-verify').click();
  await expect(page.getByTestId('pin-confirm')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('pin-input').fill(PIN);
  await page.getByTestId('pin-confirm').fill(PIN);
  if (loginShots) await loginShots.page(page, 'pin-setup');
  await page.getByTestId('pin-submit').click();
  if (opts.totp) {
    await expect(page.getByTestId('mfa-view')).toBeVisible({ timeout: 30_000 });
    const secretEl = page.getByTestId('mfa-secret');
    await expect(secretEl).toBeVisible({ timeout: 30_000 });
    const secret = ((await secretEl.textContent()) ?? '').replace(/\s+/g, '');
    expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
    if (shot) {
      // The key of this throw-away factor is blurred in the guide anyway.
      // (CSSOM, not a <style> tag: the app's CSP forbids inline styles.)
      await page.evaluate(() => {
        for (const el of document.querySelectorAll<HTMLElement>(
          '[data-testid="mfa-secret"],[data-testid="mfa-qr"]',
        ))
          el.style.setProperty('filter', 'blur(6px)', 'important');
      });
      await shot.page(page, 'mfa-enrol');
    }
    await page.getByTestId('mfa-code').fill(await freshTotp(secret));
    await page.getByTestId('mfa-verify').click();
  }
  await expect(page.getByTestId('sync-badge')).toBeVisible({ timeout: 30_000 });
}

// ---------------------------------------------------------------------------------------------
// TOTP (RFC 6238: SHA-1, 6 digits, 30 s) and factor clean-up of manager.tz
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

function serviceHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? localEnv().SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY missing (.env.local or environment)');
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

async function deleteFactors(
  request: APIRequestContext,
  userId: string,
  onlyVerified: boolean,
): Promise<void> {
  const response = await request.get(`${SUPABASE_URL}/auth/v1/admin/users/${userId}/factors`, {
    headers: serviceHeaders(),
  });
  if (!response.ok()) return;
  const body = (await response.json()) as
    Array<{ id: string; status?: string }> | { factors?: Array<{ id: string; status?: string }> };
  const factors = Array.isArray(body) ? body : (body.factors ?? []);
  for (const factor of factors) {
    if (onlyVerified && factor.status !== 'verified') continue;
    await request
      .delete(`${SUPABASE_URL}/auth/v1/admin/users/${userId}/factors/${factor.id}`, {
        headers: serviceHeaders(),
      })
      .catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// Journeys
// ---------------------------------------------------------------------------------------------

async function projectId(request: APIRequestContext, code: string): Promise<string> {
  const [row] = await serviceSelect<{ id: string }>(
    request,
    `projects?select=id&code=eq.${code}&deleted_at=is.null`,
  );
  expect(row, `seeded project ${code}`).toBeTruthy();
  return (row as { id: string }).id;
}

/** Answers the questions asked before a save until the details page or the duplicate dialog. */
async function pressSave(
  page: Page,
  button: 'form-save' | 'form-save-draft',
  onDuplicate: 'shoot-and-back' | 'different',
  shot: Shooter | null,
): Promise<'saved' | 'duplicate-back'> {
  await page.getByTestId(button).click();
  let result: 'saved' | 'duplicate-back' | null = null;
  let warnedOnce = false;
  await expect
    .poll(
      async () => {
        if (/\/projects\/[0-9a-f-]{36}$/.test(new URL(page.url()).pathname)) {
          result = 'saved';
          return 'done';
        }
        if (await page.getByTestId('form-dup-dialog').isVisible()) {
          if (onDuplicate === 'shoot-and-back') {
            if (shot) await shot.page(page, 'form-duplicate');
            await page.getByTestId('form-dup-cancel').click();
            result = 'duplicate-back';
            return 'done';
          }
          await page.getByTestId('form-dup-different').click();
        } else if (await page.getByTestId('confirm-dialog').isVisible()) {
          if (shot && !warnedOnce) await shot.page(page, 'form-save-warning');
          warnedOnce = true;
          await page.getByTestId('confirm-ok').click();
        }
        return 'waiting';
      },
      { timeout: 45_000, message: 'the save finished or the duplicate dialog appeared' },
    )
    .toBe('done');
  return result as unknown as 'saved' | 'duplicate-back';
}

async function collectorJourney(request: APIRequestContext, lang: Lang): Promise<string[]> {
  const shot = shooter(lang);
  const dir = newProfileDir(`guide-col-${lang}`);
  const context = await launchPhone(dir);
  let batchFile: string | null = null;
  const userId = await userIdOf(request, COLLECTOR);
  try {
    const page = await firstPage(context);
    await signInShots(page, request, COLLECTOR, lang, shot);
    await waitFirstSync(page);

    // -- the PIN lock after a restart ---------------------------------------------------------
    await page.reload();
    await expect(page.getByTestId('pin-input')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('pin-input').fill(PIN);
    await shot.page(page, 'pin-lock');
    await page.getByTestId('pin-submit').click();
    await expect(page.getByTestId('sync-badge')).toBeVisible({ timeout: 30_000 });

    // -- synced badge (top bar) ----------------------------------------------------------------
    await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-state', 'ok', {
      timeout: 60_000,
    });
    await shot.element(page.locator('.topbar').first(), 'sync-synced');

    // -- the map -------------------------------------------------------------------------------
    await visible(page, 'nav-map').click();
    const view = page.getByTestId('map-view');
    await expect(view).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
    await page.waitForTimeout(2_500); // tiles and clusters drawn
    await shot.page(page, 'map');
    const heat = page.getByTestId('map-heat-maintenance');
    if (await isShown(heat, 3_000)) {
      await heat.click();
      await page.waitForTimeout(1_500);
      await shot.page(page, 'map-heat');
      await heat.click();
    }
    if (await isShown(page.getByTestId('map-show-list'), 3_000)) {
      await page.getByTestId('map-show-list').click();
      await page.getByTestId('search-input').fill(DUP_CODE);
      const row = page.getByTestId('project-row').filter({ hasText: DUP_CODE });
      await expect(row).toHaveCount(1, { timeout: 20_000 });
      await shot.page(page, 'map-list');
      await row.click();
      await expect(page.getByTestId('map-project-card')).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(1_500);
      await shot.page(page, 'map-project-card');
      await page.getByTestId('map-project-close').click();
      await page.getByTestId('search-input').fill('');
    }

    // -- "more" sheet of the phone ------------------------------------------------------------
    if (await isShown(page.getByTestId('nav-more'), 2_000)) {
      await page.getByTestId('nav-more').click();
      if (await isShown(page.getByTestId('more-sheet'), 5_000)) {
        await shot.page(page, 'more-sheet');
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('more-sheet')).toHaveCount(0, { timeout: 5_000 });
      }
    }

    // -- register, details, maintenance, incomplete records -------------------------------------
    await appNavigate(page, '/projects');
    await expect(page.getByTestId('projects-page')).toBeVisible();
    await expect(page.getByTestId('project-row').first()).toBeVisible({ timeout: 30_000 });
    await shot.page(page, 'projects-list');

    const detailsId = await projectId(request, DETAILS_CODE);
    await appNavigate(page, `/projects/${detailsId}`);
    await expect(page.getByTestId('project-details')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(800);
    await shot.page(page, 'project-details');
    const maintSection = page.getByTestId('details-maintenance');
    if (await isShown(maintSection, 3_000)) {
      await scrollToTop(maintSection);
      await shot.page(page, 'project-details-maintenance');
    }
    const actions = page.getByTestId('details-actions');
    if (await isShown(actions, 3_000)) {
      await scrollToTop(actions);
      await shot.page(page, 'project-details-actions');
    }

    await visible(page, 'nav-maintenance').click();
    await expect(page.getByTestId('maintenance-page')).toBeVisible();
    await page.waitForTimeout(1_000);
    await shot.page(page, 'maintenance');

    await appNavigate(page, '/incomplete');
    await expect(page.getByTestId('incomplete-page')).toBeVisible();
    await page.waitForTimeout(1_000);
    await shot.page(page, 'incomplete');

    // -- the project form, section by section ---------------------------------------------------
    await visible(page, 'add-project').click();
    if (await isShown(page.getByTestId('form-resume-dialog'), 2_000))
      await page
        .getByTestId('form-draft-discard')
        .click()
        .catch(() => undefined);
    await expect(page.getByTestId('project-form')).toBeVisible();
    await shot.page(page, 'form-empty');
    await page.getByTestId('form-type-mosque').click();
    await page.getByTestId('form-name').fill('مسجد الرحمة');
    await page.getByTestId('form-name-latin').fill('Msikiti wa Rahma');
    await page.getByTestId('form-gps').click();
    const accuracy = page.getByTestId('form-gps-accuracy');
    await expect(accuracy).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('form-area')).not.toHaveValue('', { timeout: 30_000 });
    await scrollToTop(page.getByTestId('form-gps'));
    await shot.page(page, 'form-location');
    await scrollToTop(page.getByTestId('form-status'));
    await shot.page(page, 'form-status-photo');

    // photos
    const files = [];
    for (let i = 1; i <= 3; i++)
      files.push({
        name: `guide-${i}.jpg`,
        mimeType: 'image/jpeg',
        buffer: await makeJpeg(page, i),
      });
    await page.getByTestId('form-photo-input').setInputFiles(files);
    await expect(page.getByTestId('photo-card')).toHaveCount(3, { timeout: 90_000 });
    await page.waitForTimeout(800);
    await scrollToTop(page.getByTestId('photo-card').first());
    await shot.page(page, 'form-photos');

    // "needs maintenance" opens a maintenance entry
    await page.getByTestId('form-status').selectOption('maintenance');
    const maintDialog = page.getByTestId('form-maintenance-dialog');
    if (await isShown(maintDialog, 5_000)) {
      await page.getByTestId('form-maint-description').fill('تشقق في سقف المصلى');
      await shot.page(page, 'form-maintenance-dialog');
      await page.getByTestId('form-maint-cancel').click();
      if (await isShown(page.getByTestId('confirm-dialog'), 2_000))
        await page.getByTestId('confirm-ok').click();
      await expect(maintDialog).toHaveCount(0);
    }
    await page.getByTestId('form-status').selectOption('active');

    // optional sections (folded by default)
    for (const key of [
      'basics',
      'donors',
      'staff',
      'land',
      'facilities',
      'community',
      'sensitive',
    ] as const) {
      const toggle = page.getByTestId(`form-section-${key}`);
      if (!(await isShown(toggle, 1_500))) continue;
      await toggle.click();
      if (key === 'staff' && (await isShown(page.getByTestId('form-staff-add'), 2_000)))
        await page.getByTestId('form-staff-add').click();
      if (key === 'donors' && (await isShown(page.getByTestId('form-donor-add'), 2_000)))
        await page.getByTestId('form-donor-add').click();
      await scrollToTop(toggle);
      await shot.page(page, `form-section-${key}`);
      // Empty repeatable entries would block the save: remove the ones added for the shot.
      for (const remove of ['form-staff-remove', 'form-donor-remove']) {
        const button = page.getByTestId(remove).first();
        if (await isShown(button, 500)) {
          await button.click();
          if (await isShown(page.getByTestId('confirm-dialog'), 1_500))
            await page.getByTestId('confirm-ok').click();
        }
      }
      await toggle.click();
    }
    const meter = page.getByTestId('form-completeness');
    if (await isShown(meter, 2_000)) await shot.element(meter, 'form-completeness');

    // weak GPS: accuracy above 30 m
    await context.setGeolocation({ ...FREE_POINT, accuracy: 85 });
    await scrollToTop(page.getByTestId('form-gps'));
    await page.getByTestId('form-gps').click();
    await expect(accuracy).toHaveAttribute('data-warn', 'true', { timeout: 30_000 });
    await shot.page(page, 'form-gps-weak');

    // duplicate: same type within 150 m of a seeded mosque with the same name
    await context.setGeolocation({ ...DUP_POINT, accuracy: 6 });
    await page.getByTestId('form-name').fill('مسجد النور');
    await page.getByTestId('form-gps').click();
    await expect(accuracy).toHaveAttribute('data-warn', 'false', { timeout: 30_000 });
    await page.waitForTimeout(1_000);
    await pressSave(page, 'form-save-draft', 'shoot-and-back', shot);

    // discard the entry: nothing was saved
    await page.getByTestId('form-discard').click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await shot.page(page, 'form-discard-confirm');
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('project-form')).toHaveCount(0);

    // -- import wizard (preview only) -----------------------------------------------------------
    await visible(page, 'nav-map').click();
    await appNavigate(page, '/import');
    await expect(page.getByTestId('import-upload')).toBeVisible({ timeout: 30_000 });
    await shot.page(page, 'import-start');
    const guide = page.getByTestId('import-template-guide');
    if (await isShown(guide, 2_000)) {
      await guide.click();
      if (await isShown(page.getByTestId('import-guide-table'), 5_000)) {
        await scrollToTop(page.getByTestId('import-guide-table'));
        await shot.page(page, 'import-template');
      }
    }
    batchFile = `guide-import-${lang}-${Date.now().toString(36)}.csv`;
    const csv =
      'external_id,name_ar,type,status,capacity,lat,lon,country,maintenance_note\n' +
      `guide-${lang}-1,مسجد التجربة,mosque,active,150,-5.151,39.771,TZ,\n` +
      ',,bogus,,abc,abc,39.7,TZ,\n' +
      ',مسجد النور,mosque,active,,-5.055,39.729,TZ,\n';
    await page.getByTestId('import-file').setInputFiles({
      name: batchFile,
      mimeType: 'text/csv',
      buffer: Buffer.from(csv, 'utf8'),
    });
    await page.getByTestId('import-upload-submit').click();
    const preview = page.getByTestId('import-preview');
    await expect(preview).toBeVisible({ timeout: 60_000 });
    await scrollToTop(preview);
    await shot.page(page, 'import-preview');
    const firstRow = preview.getByTestId('import-row').nth(1);
    if (await isShown(firstRow, 2_000)) {
      await scrollToTop(firstRow);
      await shot.page(page, 'import-preview-rows');
    }
    const history = page.getByTestId('import-history');
    if (await isShown(history, 2_000)) {
      await scrollToTop(history);
      await shot.page(page, 'import-history');
    }

    // -- settings -------------------------------------------------------------------------------
    await appNavigate(page, '/settings');
    await expect(page.getByTestId('settings-page')).toBeVisible();
    await page.waitForTimeout(1_000);
    await shot.page(page, 'settings');
    for (const [id, name] of [
      ['storage-usage', 'settings-storage'],
      ['settings-map-packs', 'settings-map-packs'],
      ['pin-current', 'settings-pin'],
      ['settings-v2-import', 'settings-v2-import'],
      ['about-version', 'settings-about'],
    ] as const) {
      const target = page.getByTestId(id);
      if (!(await isShown(target, 2_000))) continue;
      await scrollToTop(target.locator('xpath=ancestor-or-self::section[1]'));
      await shot.page(page, name);
    }

    // -- offline: the badge, the banner and a pending entry (never uploaded) --------------------
    await visible(page, 'nav-map').click();
    await expect(view).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
    await context.setOffline(true);
    await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-state', 'offline', {
      timeout: 30_000,
    });
    await page.waitForTimeout(1_000);
    await shot.page(page, 'offline-map');
    await shot.element(page.locator('.topbar').first(), 'sync-offline');

    await context.setGeolocation({ ...FREE_POINT, accuracy: 5 });
    await visible(page, 'add-project').click();
    if (await isShown(page.getByTestId('form-resume-dialog'), 2_000))
      await page
        .getByTestId('form-draft-discard')
        .click()
        .catch(() => undefined);
    await expect(page.getByTestId('project-form')).toBeVisible();
    await page.getByTestId('form-type-school').click();
    await page.getByTestId('form-name').fill('مدرسة الفجر لتحفيظ القرآن');
    await page.getByTestId('form-gps').click();
    await expect(page.getByTestId('form-gps-accuracy')).toBeVisible({ timeout: 30_000 });
    await page
      .getByTestId('form-photo-input')
      .setInputFiles([
        { name: 'guide-offline.jpg', mimeType: 'image/jpeg', buffer: await makeJpeg(page, 9) },
      ]);
    await expect(page.getByTestId('photo-card')).toHaveCount(1, { timeout: 60_000 });
    await pressSave(page, 'form-save-draft', 'different', null);
    await expect(page.getByTestId('project-details')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('sync-pending-ops')).not.toHaveText('0', { timeout: 30_000 });
    await page.waitForTimeout(800);
    await shot.page(page, 'details-pending');
    await shot.element(page.locator('.topbar').first(), 'sync-pending');
    return shot.taken;
  } finally {
    // The offline entry dies with the temporary profile; the staged import batch is removed.
    await context.close().catch(() => undefined);
    removeProfile(dir);
    if (batchFile) {
      const batches = await serviceSelect<{ id: string }>(
        request,
        `import_batches?select=id&user_id=eq.${userId}&file_name=eq.${encodeURIComponent(batchFile)}`,
      ).catch(() => [] as Array<{ id: string }>);
      const now = new Date().toISOString();
      for (const { id } of batches) {
        await serviceUpdate(request, `import_rows?batch_id=eq.${id}&deleted_at=is.null`, {
          deleted_at: now,
        }).catch(() => undefined);
        await serviceUpdate(request, `import_batches?id=eq.${id}&deleted_at=is.null`, {
          deleted_at: now,
        }).catch(() => undefined);
      }
    }
  }
}

/** reference/v2 sample data shape (two projects, one person). */
function v2Sample(lang: Lang): { projects: unknown[]; people: unknown[] } {
  const id = (n: number) => `guide-${lang}-${Date.now().toString(36)}-${n}`;
  return {
    projects: [
      {
        id: id(1),
        name: 'مسجد النور',
        type: 'mosque',
        country: 'تنزانيا',
        region: 'بيمبا',
        locality: 'ويتي',
        lat: -5.055,
        lng: 39.729,
        capacity: 350,
        status: 'active',
        manager: 'عبدالله سالم',
        builder: 'الاستقامة',
        buildDate: '2019-01-01',
        createdBy: 'المشرف العام',
        staff: [{ name: 'عبدالله سالم', role: 'imam', salary: 150000 }],
      },
      {
        id: id(2),
        name: 'مدرسة الفلاح للقرآن',
        type: 'school',
        country: 'تنزانيا',
        region: 'بيمبا',
        locality: 'ويتي',
        lat: -5.066,
        lng: 39.714,
        capacity: 120,
        status: 'maintenance',
        maintenanceNotes: 'السقف يحتاج إلى صيانة',
        builder: 'الاستقامة',
        buildDate: '2021-01-01',
        createdBy: 'المشرف العام',
      },
    ],
    people: [{ id: 'p-1', name: 'عبدالله سالم', normalizedName: 'عبدالله سالم', roles: ['imam'] }],
  };
}

async function migrationJourney(request: APIRequestContext, lang: Lang): Promise<string[]> {
  const shot = shooter(lang);
  const dir = newProfileDir(`guide-mig-${lang}`);
  const context = await launchPhone(dir);
  try {
    const data = v2Sample(lang);
    await context.addInitScript(
      ({ projects, people }) => {
        if (localStorage.getItem('e2e.v2.seeded')) return;
        localStorage.setItem('istiqama-projects-v2', JSON.stringify(projects));
        localStorage.setItem('istiqama-people-v1', JSON.stringify(people));
        localStorage.setItem('e2e.v2.seeded', '1');
      },
      { projects: data.projects, people: data.people },
    );
    const page = await firstPage(context);
    await signInShots(page, request, COLLECTOR, lang, null);
    await waitFirstSync(page);
    const prompt = page.getByTestId('v2-migrate-prompt');
    if (await isShown(prompt, 15_000)) {
      await shot.page(page, 'v2-offer');
      const accept = page.getByTestId('v2-migrate-accept').or(page.getByTestId('v2-migrate-show'));
      await accept.first().click();
    } else {
      await appNavigate(page, '/import');
      await expect(page.getByTestId('import-v2')).toBeVisible({ timeout: 30_000 });
      await shot.page(page, 'v2-offer');
      await page.getByTestId('v2-local-offer').getByRole('button').first().click();
    }
    const summary = page.getByTestId('v2-migrate-summary');
    await expect(summary).toBeVisible({ timeout: 90_000 });
    await page.waitForTimeout(500);
    await shot.page(page, 'v2-summary');
    const warnings = page.getByTestId('v2-migrate-warnings');
    if (await isShown(warnings, 2_000)) {
      await warnings
        .locator('summary')
        .click()
        .catch(() => undefined);
      await scrollToTop(warnings);
      await shot.page(page, 'v2-warnings');
    }
    // Nothing is migrated: the guide only shows the offer and its summary.
    await page.getByTestId('v2-migrate-cancel').click();
    if (await isShown(page.getByTestId('confirm-dialog'), 2_000))
      await page.getByTestId('confirm-ok').click();
    return shot.taken;
  } finally {
    await context.close().catch(() => undefined);
    removeProfile(dir);
  }
}

async function supervisorJourney(request: APIRequestContext, lang: Lang): Promise<string[]> {
  const shot = shooter(lang);
  const dir = newProfileDir(`guide-sup-${lang}`);
  const context = await launchPhone(dir);
  const collectorId = await userIdOf(request, COLLECTOR);
  const [target] = await serviceSelect<{ id: string; name_ar: string; version: number }>(
    request,
    `projects?select=id,name_ar,version&code=eq.${CONFLICT_CODE}&deleted_at=is.null`,
  );
  expect(target, `seeded project ${CONFLICT_CODE}`).toBeTruthy();
  const conflictId = randomUUID();
  const inserted = await request.post(`${SUPABASE_URL}/rest/v1/sync_conflicts`, {
    headers: serviceHeaders({ 'content-type': 'application/json', prefer: 'return=minimal' }),
    data: {
      id: conflictId,
      table_name: 'projects',
      row_id: target!.id,
      project_id: target!.id,
      field: 'name_ar',
      base_version: Math.max(1, target!.version - 1),
      server_value: target!.name_ar,
      client_value: `${target!.name_ar} الجديد`,
      client_user_id: collectorId,
      client_device_id: 'guide-device',
      client_op_id: randomUUID(),
      state: 'open',
    },
  });
  expect(inserted.ok(), `conflict insert: ${inserted.status()} ${await inserted.text()}`).toBe(
    true,
  );
  try {
    const page = await firstPage(context);
    await signInShots(page, request, SUPERVISOR, lang, null);
    await waitFirstSync(page);

    // The phone's bottom bar has no "review" item (it is in the "more" sheet).
    await appNavigate(page, '/review');
    await expect(page.getByTestId('review-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('review-row').first()).toBeVisible({ timeout: 30_000 });
    await shot.page(page, 'review-queue');

    const returnButton = page.getByTestId('review-row').first().getByTestId('review-return');
    if (await isShown(returnButton, 2_000)) {
      await returnButton.click();
      if (await isShown(page.getByTestId('return-dialog'), 5_000)) {
        await page
          .getByTestId('return-note')
          .fill(lang === 'ar' ? 'الصور ناقصة، أضف صورة الواجهة.' : 'Picha ya mbele haipo.');
        await shot.page(page, 'review-return');
        await page.keyboard.press('Escape');
        if (await isShown(page.getByTestId('confirm-dialog'), 2_000))
          await page.getByTestId('confirm-ok').click();
      }
    }

    await page.getByTestId('review-tab-conflicts').click();
    const conflict = page.getByTestId('conflict-row').first();
    // The pull cursor stops at the cluster-wide snapshot xmin (ARCHITECTURE §3.2): a long
    // transaction in ANY database of the server (e.g. load-data generation) delays the
    // injected row. Sync again until it arrives.
    await expect
      .poll(
        async () => {
          if (await conflict.isVisible()) return true;
          await page.getByTestId('review-tab-localities').click();
          await page.getByTestId('review-tab-conflicts').click();
          if (await isShown(conflict, 1_500)) return true;
          const now = visible(page, 'sync-now');
          if (await now.isEnabled().catch(() => false)) await now.click().catch(() => undefined);
          return false;
        },
        { timeout: 300_000, intervals: [5_000, 10_000], message: 'the injected conflict arrived' },
      )
      .toBe(true);
    await page.waitForTimeout(500);
    await shot.page(page, 'review-conflict');

    await page.getByTestId('review-tab-localities').click();
    await page.waitForTimeout(800);
    await shot.page(page, 'review-localities');

    // -- people -----------------------------------------------------------------------------
    await appNavigate(page, '/people');
    await expect(page.getByTestId('people-page')).toBeVisible();
    await expect(page.getByTestId('person-row').first()).toBeVisible({ timeout: 30_000 });
    await shot.page(page, 'people');
    await page.getByTestId('person-row').first().click();
    await expect(page.getByTestId('person-card')).toBeVisible();
    await page.waitForTimeout(500);
    await shot.page(page, 'person-card');
    const mergeButton = page.getByTestId('person-merge');
    if (await isShown(mergeButton, 3_000)) {
      await mergeButton.click();
      await expect(page.getByTestId('merge-dialog')).toBeVisible();
      const suggestion = page.getByTestId('merge-suggestion').first();
      if (await isShown(suggestion, 4_000)) await suggestion.click();
      await page.waitForTimeout(600);
      await shot.page(page, 'merge-dialog');
      await page.getByTestId('merge-cancel').first().click();
      if (await isShown(page.getByTestId('confirm-dialog'), 2_000))
        await page.getByTestId('confirm-ok').click();
    }
    await page
      .getByTestId('person-back')
      .click()
      .catch(() => undefined);
    const requests = page.getByTestId('people-tab-requests');
    if (await isShown(requests, 2_000)) {
      await requests.click();
      await page.waitForTimeout(800);
      await shot.page(page, 'merge-requests');
    }
    return shot.taken;
  } finally {
    await context.close().catch(() => undefined);
    removeProfile(dir);
    await serviceUpdate(request, `sync_conflicts?id=eq.${conflictId}&deleted_at=is.null`, {
      deleted_at: new Date().toISOString(),
    }).catch(() => undefined);
  }
}

async function managerJourney(request: APIRequestContext, lang: Lang): Promise<string[]> {
  const shot = shooter(lang);
  const managerId = await userIdOf(request, MANAGER);
  await deleteFactors(request, managerId, true);
  const dir = newProfileDir(`guide-mgr-${lang}`);
  const context = await launchDesktop(dir);
  try {
    const page = await firstPage(context);
    await signInShots(page, request, MANAGER, lang, shot, { totp: true });
    await waitFirstSync(page);

    // -- reports ------------------------------------------------------------------------------
    await appNavigate(page, '/reports');
    await expect(page.getByTestId('reports-page')).toBeVisible();
    await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(1_500);
    await shot.page(page, 'reports-dashboard');
    for (const [id, name] of [
      ['dash-payroll', 'reports-payroll'],
      ['dash-needs', 'reports-needs'],
      ['dash-collectors', 'reports-collectors'],
    ] as const) {
      const card = page.getByTestId(id);
      if (await isShown(card, 2_000)) {
        await scrollToTop(card);
        await shot.page(page, name);
      }
    }
    await page.getByTestId('reports-export').click();
    const dialog = page.getByTestId('export-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('export-format-xlsx').check();
    await dialog.getByTestId(`export-lang-${lang}`).check();
    await page.waitForTimeout(300);
    await shot.page(page, 'reports-export');
    await page.getByTestId('export-close').click();
    await expect(dialog).toHaveCount(0);

    const detailsId = await projectId(request, DETAILS_CODE);
    await appNavigate(page, `/reports/print/project/${detailsId}`);
    await expect(page.getByTestId('print-doc')).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(1_500);
    await shot.page(page, 'print-project');

    // -- administration -----------------------------------------------------------------------
    await appNavigate(page, '/admin/users');
    await expect(page.getByTestId('admin-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('admin-user-row').first()).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(800);
    await shot.page(page, 'admin-users');
    await page.getByTestId('admin-users-search').fill('collector.pemba');
    const row = page.getByTestId('admin-user-row').first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    await expect(page.getByTestId('admin-user-detail')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(800);
    await shot.page(page, 'admin-user-detail');
    const revoke = page.getByTestId('admin-user-revoke');
    if (await isShown(revoke, 3_000)) {
      await revoke.click();
      await expect(page.getByTestId('confirm-dialog')).toBeVisible();
      await shot.page(page, 'admin-revoke');
      // The guide only shows the question: the collector's sessions stay valid.
      await page.getByTestId('confirm-cancel').click();
      await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
    }
    await appNavigate(page, '/admin/sync');
    if (await isShown(page.getByTestId('admin-sync'), 20_000)) {
      await page.waitForTimeout(1_500);
      await shot.page(page, 'admin-sync');
    }

    // -- the same dashboard on a phone -----------------------------------------------------------
    await page.setViewportSize(PHONE.viewport);
    await appNavigate(page, '/reports');
    await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(1_500);
    await shot.page(page, 'reports-phone');
    return shot.taken;
  } finally {
    await context.close().catch(() => undefined);
    removeProfile(dir);
    await deleteFactors(request, managerId, false).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------

for (const lang of LANGS) {
  test.describe(`guide screenshots (${lang})`, () => {
    test(`${lang}: field collector`, async ({ request }) => {
      test.setTimeout(15 * 60_000);
      const taken = await collectorJourney(request, lang);
      console.log(`[${lang}] collector: ${taken.length} shots`);
      expect(taken.length).toBeGreaterThan(20);
    });

    test(`${lang}: v2 migration offer`, async ({ request }) => {
      test.setTimeout(8 * 60_000);
      const taken = await migrationJourney(request, lang);
      console.log(`[${lang}] migration: ${taken.length} shots`);
      expect(taken.length).toBeGreaterThan(1);
    });

    test(`${lang}: branch supervisor`, async ({ request }) => {
      test.setTimeout(10 * 60_000);
      const taken = await supervisorJourney(request, lang);
      console.log(`[${lang}] supervisor: ${taken.length} shots`);
      expect(taken.length).toBeGreaterThan(4);
    });

    test(`${lang}: country manager (TOTP)`, async ({ request }) => {
      test.setTimeout(10 * 60_000);
      const taken = await managerJourney(request, lang);
      console.log(`[${lang}] manager: ${taken.length} shots`);
      expect(taken.length).toBeGreaterThan(5);
    });
  });
}

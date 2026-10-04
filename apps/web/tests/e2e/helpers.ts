/**
 * Shared helpers of the e2e suite (docs/contracts/web.md §4 test ids).
 *
 *  - `observe`             console errors, CSP violations and off-loopback requests
 *  - `readOtp`, `signIn`   e-mail OTP sign-in against the fake provider + first PIN / unlock
 *  - `launchDevice`        a persistent Chrome profile = one "device" that survives a restart
 *  - `waitSynced`          the permanent sync badge reports nothing pending
 *  - `service*`            service-role REST calls made by the TEST RUNNER to verify results
 *                          on the server (the key is read from .env.local here, in Node; it is
 *                          never given to the app)
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chromium,
  expect,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';

export const BASE_URL = 'http://127.0.0.1:4173';
export const SUPABASE_URL =
  process.env.E2E_SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? 'http://127.0.0.1:54321';
export const ALLOWED_HOSTS = new Set(['127.0.0.1']);
/** Every seeded account uses e-mail OTP here; the PIN is per device. */
export const PIN = '482916';

/** Repository root (…/apps/web/tests/e2e → …). */
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
/** Screenshots for the lead and the user guide (git-ignored). */
export const SCREENS_DIR = join(ROOT, '.local', 'screens');

// ---------------------------------------------------------------------------------------------
// Hygiene
// ---------------------------------------------------------------------------------------------

export interface Observed {
  consoleErrors: string[];
  cspViolations: string[];
  foreignRequests: string[];
  /** API answers ≥ 400 (method, path, status, start of the body, claims of the token). */
  failedResponses: string[];
}

/** iat / exp / sub of a bearer token (diagnostics only; the signature is not checked). */
function tokenClaims(authorization: string | undefined): string {
  const token = authorization?.replace(/^Bearer\s+/i, '') ?? '';
  const payload = token.split('.')[1];
  if (!payload) return `token=${token ? 'opaque' : 'none'}`;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      iat?: number;
      exp?: number;
      sub?: string;
      role?: string;
    };
    const age = claims.iat ? Math.round(Date.now() / 1000 - claims.iat) : '?';
    const left = claims.exp ? Math.round(claims.exp - Date.now() / 1000) : '?';
    return `role=${claims.role} sub=${claims.sub?.slice(0, 8)} age=${age}s expiresIn=${left}s`;
  } catch {
    return 'token=unreadable';
  }
}

/** Collects console errors, CSP violations and off-origin requests of pages AND the service worker. */
export async function observe(context: BrowserContext, page?: Page): Promise<Observed> {
  const seen: Observed = {
    consoleErrors: [],
    cspViolations: [],
    foreignRequests: [],
    failedResponses: [],
  };
  context.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol === 'data:' || url.protocol === 'blob:') return;
    if (!ALLOWED_HOSTS.has(url.hostname)) seen.foreignRequests.push(request.url());
  });
  context.on('response', (response) => {
    const url = new URL(response.url());
    if (response.status() < 400 || url.origin !== new URL(SUPABASE_URL).origin) return;
    const request = response.request();
    void response
      .text()
      .catch(() => '')
      .then((body) => {
        seen.failedResponses.push(
          `${request.method()} ${url.pathname} → ${response.status()} ${body.slice(0, 200)} ` +
            `[${tokenClaims(request.headers().authorization)}]`,
        );
      });
  });
  const watch = (p: Page): void => {
    p.on('console', (message) => {
      if (message.type() === 'error')
        seen.consoleErrors.push(`${message.text()} @ ${message.location().url || '?'}`);
    });
    p.on('pageerror', (error) => seen.consoleErrors.push(`pageerror: ${error.message}`));
  };
  if (page) watch(page);
  else {
    for (const p of context.pages()) watch(p);
    context.on('page', watch);
  }
  await context.exposeBinding('__e2eCspViolation', (_source, text: string) => {
    seen.cspViolations.push(text);
  });
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const report = (window as unknown as { __e2eCspViolation?: (text: string) => void })
        .__e2eCspViolation;
      report?.(`${event.effectiveDirective} blocked ${event.blockedURI || '(inline)'}`);
    });
  });
  return seen;
}

/**
 * Console errors that are expected while the test deliberately cuts the network: failed
 * fetches the browser itself logs (`net::ERR_INTERNET_DISCONNECTED`, …). Everything else
 * still fails the test.
 */
export function unexpectedErrors(errors: readonly string[]): string[] {
  return errors.filter(
    (e) => !/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|net::ERR_FAILED|Failed to fetch/.test(e),
  );
}

// ---------------------------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------------------------

/** The fake OTP provider keeps the last code per identifier (loopback only). */
export async function readOtp(request: APIRequestContext, identifier: string): Promise<string> {
  let code = '';
  await expect
    .poll(
      async () => {
        const response = await request.get(
          `${SUPABASE_URL}/dev/otp?identifier=${encodeURIComponent(identifier)}`,
        );
        if (!response.ok()) return '';
        code = String(((await response.json()) as { code?: unknown }).code ?? '');
        return code;
      },
      { message: `no OTP code for ${identifier} at ${SUPABASE_URL}/dev/otp`, timeout: 15_000 },
    )
    .toMatch(/^\d{6}$/);
  return code;
}

/**
 * E-mail OTP sign-in on a fresh device, then the first PIN. Resolves once the shell is on
 * screen (the sync badge is visible).
 */
export async function signIn(
  page: Page,
  request: APIRequestContext,
  email: string,
  pin = PIN,
): Promise<void> {
  await page.goto('/');
  await page.getByTestId('login-email').fill(email);
  // The previous code of this identifier must not be mistaken for the new one.
  const before = await request
    .get(`${SUPABASE_URL}/dev/otp?identifier=${encodeURIComponent(email)}`)
    .then(async (r) => (r.ok() ? String(((await r.json()) as { code?: unknown }).code ?? '') : ''))
    .catch(() => '');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-code')).toBeVisible();
  let code = await readOtp(request, email);
  if (before && code === before) {
    // The provider may hand out the same code twice; give a new one a moment to arrive.
    await page.waitForTimeout(500);
    code = await readOtp(request, email);
  }
  await page.getByTestId('login-code').fill(code);
  await page.getByTestId('login-verify').click();
  await expect(page.getByTestId('pin-confirm')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('pin-input').fill(pin);
  await page.getByTestId('pin-confirm').fill(pin);
  await page.getByTestId('pin-submit').click();
  await expect(page.getByTestId('sync-badge')).toBeVisible({ timeout: 30_000 });
}

/** The PIN lock of a device that already has a session (after a restart or an idle lock). */
export async function unlock(page: Page, pin = PIN): Promise<void> {
  await expect(page.getByTestId('pin-input')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('pin-confirm')).toHaveCount(0);
  await page.getByTestId('pin-input').fill(pin);
  await page.getByTestId('pin-submit').click();
  await expect(page.getByTestId('sync-badge')).toBeVisible({ timeout: 30_000 });
}

/** Waits for the first successful sync of a fresh device and for the service worker. */
export async function waitFirstSync(page: Page): Promise<void> {
  await expect(page.getByTestId('sync-last')).toHaveAttribute('data-at', /^\d+$/, {
    timeout: 120_000,
  });
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
}

/**
 * Online, nothing pending (operations and photos — or operations only with
 * `{ photos: false }`), no sync running. Presses "sync now" while waiting so the test does not
 * depend on the 2-minute timer.
 */
export async function waitSynced(
  page: Page,
  timeout = 180_000,
  opts: { photos?: boolean } = {},
): Promise<void> {
  const badge = page.getByTestId('sync-badge');
  const ops = page.getByTestId('sync-pending-ops');
  const photos = page.getByTestId('sync-pending-photos');
  const withPhotos = opts.photos !== false;
  const started = Date.now();
  await expect
    .poll(
      async () => {
        const state = await badge.getAttribute('data-state');
        const pendingOps = (await ops.textContent())?.trim();
        const pendingPhotos = (await photos.textContent())?.trim();
        if (state === 'ok' && pendingOps === '0' && (!withPhotos || pendingPhotos === '0'))
          return 'synced';
        const now = page.getByTestId('sync-now');
        if (
          state !== 'syncing' &&
          Date.now() - started > 5_000 &&
          (await now.isEnabled().catch(() => false))
        ) {
          await now.click().catch(() => undefined);
        }
        return `${state} ops=${pendingOps} photos=${pendingPhotos}`;
      },
      { timeout, intervals: [1_000, 2_000, 3_000] },
    )
    .toBe('synced');
}

/**
 * One complete sync round started with "sync now" (push + pull): waits until the last-sync
 * time moved forward and the badge is back to "ok".
 */
export async function syncOnce(page: Page, timeout = 120_000): Promise<void> {
  const last = page.getByTestId('sync-last');
  const before = Number((await last.getAttribute('data-at')) || '0');
  await expect(page.getByTestId('sync-now')).toBeEnabled({ timeout });
  await page.getByTestId('sync-now').click();
  await expect
    .poll(async () => Number((await last.getAttribute('data-at')) || '0'), { timeout })
    .toBeGreaterThan(before);
  await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-state', 'ok', { timeout });
}

/**
 * In-app navigation (the router listens to `popstate`), as a click on a link would do. A
 * full page load would show the PIN lock again, which is the app's correct behaviour.
 */
export async function appNavigate(page: Page, path: string): Promise<void> {
  await page.evaluate((target) => {
    window.history.pushState({ key: `e2e-${Date.now()}` }, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

/**
 * Presses a save button of the project form and answers the questions that may come before
 * the save — a possible duplicate ("different project") or the geo-validation warning
 * ("save anyway") — then waits for the details page. Returns the project id.
 */
export async function saveProjectForm(page: Page, button: 'form-save' | 'form-save-draft') {
  await page.getByTestId(button).click();
  const details = /\/projects\/([0-9a-f-]{36})$/;
  const asked: string[] = [];
  await expect
    .poll(
      async () => {
        if (details.test(new URL(page.url()).pathname)) return 'saved';
        if (await page.getByTestId('form-dup-dialog').isVisible()) {
          await page.getByTestId('form-dup-different').click();
          asked.push('duplicate');
        } else if (await page.getByTestId('confirm-dialog').isVisible()) {
          await page.getByTestId('confirm-ok').click();
          asked.push('geo');
        }
        return 'waiting';
      },
      { timeout: 30_000, message: 'the project form saved and opened the details page' },
    )
    .toBe('saved');
  await expect(page.getByTestId('project-details-page')).toBeVisible();
  const id = (details.exec(new URL(page.url()).pathname) as RegExpExecArray)[1] as string;
  return { id, asked };
}

/** Rows of a store of the app database (read inside the page; IndexedDB is per profile). */
export async function countLocal(page: Page, store: string): Promise<number> {
  return page.evaluate(
    (name) =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open('istiqama-map');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result;
          const request = database.transaction(name, 'readonly').objectStore(name).count();
          request.onsuccess = () => {
            resolve(request.result);
            database.close();
          };
          request.onerror = () => reject(request.error);
        };
      }),
    store,
  );
}

/** One stored row of the app database on this device (undefined when absent). */
export async function localRow<T = Record<string, unknown>>(
  page: Page,
  store: string,
  id: string,
): Promise<T | undefined> {
  return page.evaluate(
    ([name, key]) =>
      new Promise<T | undefined>((resolve, reject) => {
        const open = indexedDB.open('istiqama-map');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result;
          const request = database
            .transaction(name as string, 'readonly')
            .objectStore(name as string)
            .get(key as string);
          request.onsuccess = () => {
            resolve(request.result as T | undefined);
            database.close();
          };
          request.onerror = () => reject(request.error);
        };
      }),
    [store, id],
  );
}

/** Keys of `meta` entries starting with `prefix`. */
export async function localMetaKeys(page: Page, prefix: string): Promise<string[]> {
  return page.evaluate(
    (start) =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open('istiqama-map');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result;
          const request = database
            .transaction('meta', 'readonly')
            .objectStore('meta')
            .getAllKeys(IDBKeyRange.bound(start, start + String.fromCharCode(0xffff)));
          request.onsuccess = () => {
            resolve(request.result.map(String));
            database.close();
          };
          request.onerror = () => reject(request.error);
        };
      }),
    prefix,
  );
}

// ---------------------------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------------------------

export interface DeviceOptions {
  geolocation?: { latitude: number; longitude: number; accuracy?: number };
  viewport?: { width: number; height: number };
}

/** A temporary user-data directory: one per simulated device, removed by `removeProfile`. */
export function newProfileDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `istiqama-e2e-${label}-`));
}

export function removeProfile(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch {
    // Chrome may still hold a lock file for a moment on Windows; the OS temp cleanup takes it.
  }
}

/**
 * A persistent Chrome profile: IndexedDB, the service worker, its caches and the encrypted
 * session survive `context.close()` and the next `launchDevice()` on the same directory —
 * exactly what closing and reopening the browser on a phone does.
 */
export async function launchDevice(
  userDataDir: string,
  opts: DeviceOptions = {},
): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless: process.env.E2E_HEADED ? false : true,
    baseURL: BASE_URL,
    locale: 'en-US',
    serviceWorkers: 'allow',
    viewport: opts.viewport ?? { width: 1280, height: 860 },
    geolocation: opts.geolocation,
    permissions: ['geolocation'],
  });
  await context.grantPermissions(['geolocation'], { origin: BASE_URL });
  return context;
}

/** The single page a persistent context opens with. */
export function firstPage(context: BrowserContext): Promise<Page> {
  const existing = context.pages()[0];
  return existing ? Promise.resolve(existing) : context.newPage();
}

/**
 * Screenshot of the whole page content: the shell scrolls inside `<main>`, so `fullPage`
 * alone stops at the viewport — the window is made as tall as the content for the shot.
 */
export async function tallScreenshot(page: Page, path: string): Promise<void> {
  const size = page.viewportSize() ?? { width: 1280, height: 860 };
  const height = await page.evaluate(() => {
    const main = document.getElementById('main');
    const extra = main ? main.scrollHeight - main.clientHeight : 0;
    return Math.ceil(window.innerHeight + Math.max(0, extra));
  });
  await page.setViewportSize({ width: size.width, height: Math.min(4000, height) });
  await page.waitForTimeout(300);
  await page.screenshot({ path });
  await page.setViewportSize(size);
}

/** First visible element of a test id (the sidebar and the bottom bar never coexist, but be safe). */
export function visible(page: Page, testId: string) {
  return page.getByTestId(testId).filter({ visible: true }).first();
}

// ---------------------------------------------------------------------------------------------
// Server-side verification (service role, test runner only)
// ---------------------------------------------------------------------------------------------

let cachedEnv: Record<string, string> | null = null;

/** Variables of the repository's .env.local (never handed to the browser). */
export function localEnv(): Record<string, string> {
  if (cachedEnv) return cachedEnv;
  const out: Record<string, string> = {};
  try {
    const text = readFileSync(join(ROOT, '.env.local'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && m[1]) out[m[1]] = (m[2] ?? '').replace(/^["']|["']$/g, '');
    }
  } catch {
    // CI passes the variables through the environment instead.
  }
  cachedEnv = out;
  return out;
}

function serviceKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? localEnv().SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY missing (.env.local or environment)');
  return key;
}

function serviceHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const key = serviceKey();
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

/** PostgREST GET with the service role: `path` is e.g. `projects?select=id&code=eq.X`. */
export async function serviceSelect<T = Record<string, unknown>>(
  request: APIRequestContext,
  path: string,
): Promise<T[]> {
  const response = await request.get(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: serviceHeaders(),
  });
  expect(response.ok(), `GET ${path}: ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as T[];
}

/** PostgREST PATCH with the service role; returns the changed rows. */
export async function serviceUpdate<T = Record<string, unknown>>(
  request: APIRequestContext,
  path: string,
  values: Record<string, unknown>,
): Promise<T[]> {
  const response = await request.patch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: serviceHeaders({
      Prefer: 'return=representation',
      'Content-Type': 'application/json',
    }),
    data: values,
  });
  expect(response.ok(), `PATCH ${path}: ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as T[];
}

/** HEAD of a storage object with the service role: true when it exists. */
export async function storageObjectExists(
  request: APIRequestContext,
  bucket: string,
  name: string,
): Promise<boolean> {
  const response = await request.head(
    `${SUPABASE_URL}/storage/v1/object/${bucket}/${name.split('/').map(encodeURIComponent).join('/')}`,
    { headers: serviceHeaders() },
  );
  return response.status() === 200;
}

/** `auth.users.id` of a seeded account (admin API, service role). */
export async function userIdOf(request: APIRequestContext, email: string): Promise<string> {
  const response = await request.get(`${SUPABASE_URL}/auth/v1/admin/users?per_page=1000`, {
    headers: serviceHeaders(),
  });
  expect(response.ok(), `admin users: ${response.status()}`).toBe(true);
  const body = (await response.json()) as
    { users?: Array<{ id: string; email?: string }> } | Array<{ id: string; email?: string }>;
  const users = Array.isArray(body) ? body : (body.users ?? []);
  const user = users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (!user) throw new Error(`no auth user ${email}`);
  return user.id;
}

/** Soft delete through the service role (test clean-up). Returns how many rows were marked. */
export async function softDeleteRows(
  request: APIRequestContext,
  table: string,
  column: string,
  ids: readonly string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  let marked = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const rows = await serviceUpdate(
      request,
      `${table}?${column}=in.(${chunk.join(',')})&deleted_at=is.null&select=id`,
      { deleted_at: new Date().toISOString() },
    );
    marked += rows.length;
  }
  return marked;
}

// ---------------------------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------------------------

/**
 * A small JPEG drawn in the page (no image files in the repository, no network): coloured
 * background + the number, ~10–20 kB.
 */
export async function makeJpeg(page: Page, seed: number): Promise<Buffer> {
  const base64 = await page.evaluate(async (n) => {
    const canvas = new OffscreenCanvas(800, 600);
    const g = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
    g.fillStyle = `hsl(${(n * 47) % 360} 55% 45%)`;
    g.fillRect(0, 0, 800, 600);
    g.fillStyle = '#ffffff';
    g.fillRect(40, 420, 720, 120);
    g.fillStyle = '#0f2545';
    g.font = 'bold 96px sans-serif';
    g.fillText(`E2E ${n}`, 60, 520);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }, seed);
  return Buffer.from(base64, 'base64');
}

/** Short random tag that keeps names of one run apart from earlier runs. */
export function runTag(): string {
  return Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 5);
}

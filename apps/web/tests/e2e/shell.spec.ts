/**
 * Seed of the e2e suite: the shell boots on the built app against the running stack.
 *
 *   e-mail OTP sign-in (code read from the fake provider's /dev/otp)
 *   → first PIN → first sync (last-sync time shown, nothing pending)
 *   → reload while offline → PIN prompt → unlock from the encrypted vault
 *   → back online → language switch flips <html lang dir>
 *
 * Throughout: no console errors, no CSP violations, no request to an origin other than the
 * loopback (the app itself on :4173 and the stack on :54321).
 *
 * The account's profile language is left as seeded (the last switch selects it again).
 */
import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';

const SUPABASE_URL =
  process.env.E2E_SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const ANON_KEY = process.env.E2E_SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? '';
const EMAIL = process.env.E2E_EMAIL ?? 'collector.pemba@example.org';
/** Seeded preferred_language of the account (supabase/seed.staging.sql). */
const PROFILE_LANGUAGE = process.env.E2E_PROFILE_LANGUAGE ?? 'sw';
const PIN = '482916';
const ALLOWED_HOSTS = new Set(['127.0.0.1']);

interface Observed {
  consoleErrors: string[];
  cspViolations: string[];
  foreignRequests: string[];
}

/** Collects console errors, CSP violations and off-origin requests of pages AND the service worker. */
async function observe(context: BrowserContext, page: Page): Promise<Observed> {
  const seen: Observed = { consoleErrors: [], cspViolations: [], foreignRequests: [] };
  context.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol === 'data:' || url.protocol === 'blob:') return;
    if (!ALLOWED_HOSTS.has(url.hostname)) seen.foreignRequests.push(request.url());
  });
  page.on('console', (message) => {
    if (message.type() === 'error')
      seen.consoleErrors.push(`${message.text()} @ ${message.location().url || '?'}`);
  });
  page.on('pageerror', (error) => seen.consoleErrors.push(`pageerror: ${error.message}`));
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

/** The fake OTP provider keeps the last code per identifier (loopback only). */
async function readOtp(request: APIRequestContext, identifier: string): Promise<string> {
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
 * Settings → language. The choice is also saved to the profile (fire and forget): wait for
 * that write so consecutive switches cannot reach the server out of order.
 */
async function switchLanguage(page: Page, lang: string): Promise<void> {
  const button = page.getByTestId(`lang-${lang}`);
  if ((await button.getAttribute('aria-pressed')) === 'true') return;
  const saved = page.waitForResponse(
    (response) =>
      response.url().includes('/rest/v1/profiles') && response.request().method() === 'PATCH',
  );
  await button.click();
  expect((await saved).ok(), `profile language ${lang} saved`).toBe(true);
}

async function expectDirection(page: Page, lang: string, dir: 'rtl' | 'ltr'): Promise<void> {
  const html = page.locator('html');
  await expect(html).toHaveAttribute('lang', lang);
  await expect(html).toHaveAttribute('dir', dir);
}

/**
 * LOCAL STACK WORKAROUND — remove once scripts/local-stack/gateway/proxy.ts is fixed.
 * The gateway keeps idle keep-alive sockets to PostgREST longer than PostgREST keeps them open,
 * so the first API request after a pause (e.g. the build that precedes this suite) can come back
 * 502 ("postgrest_unreachable: socket hang up" in .local/logs/gateway.log). The app retries,
 * but Chrome logs the 502 as a console error. Consume the stale sockets first: the agent hands
 * out its free sockets newest first, so the first non-502 answer means none is left.
 */
test.beforeAll(async ({ request }) => {
  if (!ANON_KEY) return;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await request.get(`${SUPABASE_URL}/rest/v1/countries?select=id&limit=1`, {
      headers: { apikey: ANON_KEY },
    });
    if (response.status() !== 502) return;
  }
});

test('shell boots: OTP sign-in, PIN, first sync, offline unlock, language switch', async ({
  page,
  context,
  request,
}) => {
  const seen = await observe(context, page);

  // --- sign in --------------------------------------------------------------------------------
  await page.goto('/');
  // Arabic is the default language before anybody signed in on this device.
  await expectDirection(page, 'ar', 'rtl');
  await page.getByTestId('login-email').fill(EMAIL);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-code')).toBeVisible();
  await page.getByTestId('login-code').fill(await readOtp(request, EMAIL));
  await page.getByTestId('login-verify').click();

  // --- first sign-in on this device: choose a PIN ---------------------------------------------
  await expect(page.getByTestId('pin-confirm')).toBeVisible();
  await page.getByTestId('pin-input').fill(PIN);
  await page.getByTestId('pin-confirm').fill(PIN);
  await page.getByTestId('pin-submit').click();

  // --- shell + first sync ---------------------------------------------------------------------
  const badge = page.getByTestId('sync-badge');
  await expect(badge).toBeVisible();
  await expect(page.getByTestId('sync-last')).toHaveAttribute('data-at', /^\d+$/, {
    timeout: 90_000,
  });
  await expect(badge).toHaveAttribute('data-state', 'ok');
  await expect(page.getByTestId('sync-pending-ops')).toHaveText('0');
  await expect(page.getByTestId('sync-pending-photos')).toHaveText('0');
  await expect(page.getByTestId('sync-now')).toBeEnabled();
  // The seeded profile language is adopted on a device where nobody chose one yet.
  await expectDirection(page, PROFILE_LANGUAGE, PROFILE_LANGUAGE === 'ar' ? 'rtl' : 'ltr');

  // The service worker must have finished precaching before the network goes away.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });

  // --- reload offline → PIN prompt → unlock from the vault ------------------------------------
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('pin-input')).toBeVisible();
  await expect(page.getByTestId('pin-confirm')).toHaveCount(0); // the lock, not the setup
  await page.getByTestId('pin-input').fill(PIN);
  await page.getByTestId('pin-submit').click();
  await expect(badge).toHaveAttribute('data-state', 'offline');
  await expect(page.getByTestId('offline-banner')).toBeVisible();
  await expect(page.getByTestId('sync-now')).toBeDisabled();
  await expect(page.getByTestId('sync-pending-ops')).toHaveText('0');

  // --- back online ----------------------------------------------------------------------------
  await context.setOffline(false);
  await expect(badge).toHaveAttribute('data-state', 'ok', { timeout: 30_000 });
  await expect(page.getByTestId('offline-banner')).toHaveCount(0);

  // --- language switch flips the direction ----------------------------------------------------
  await page.getByTestId('nav-settings').filter({ visible: true }).first().click();
  await expect(page.getByTestId('settings-page')).toBeVisible();
  const titles = new Set<string>();
  const order: Array<['ar' | 'sw' | 'en', 'rtl' | 'ltr']> = [
    ['ar', 'rtl'],
    ['en', 'ltr'],
    ['sw', 'ltr'],
    ['ar', 'rtl'],
  ];
  for (const [lang, dir] of order) {
    await switchLanguage(page, lang);
    await expectDirection(page, lang, dir);
    await expect(page.getByTestId(`lang-${lang}`)).toHaveAttribute('aria-pressed', 'true');
    titles.add((await page.getByTestId('view-title').textContent()) ?? '');
  }
  expect(titles.size, 'the view title is translated in every language').toBe(3);
  // Leave the account as seeded (Settings saves the choice to the profile).
  await switchLanguage(page, PROFILE_LANGUAGE);
  await expectDirection(page, PROFILE_LANGUAGE, PROFILE_LANGUAGE === 'ar' ? 'rtl' : 'ltr');
  await expect(badge).toHaveAttribute('data-state', 'ok');

  // --- hygiene --------------------------------------------------------------------------------
  expect(seen.cspViolations, 'CSP violations').toEqual([]);
  expect(seen.foreignRequests, 'requests outside the loopback').toEqual([]);
  expect(seen.consoleErrors, 'console errors').toEqual([]);
});

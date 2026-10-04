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
import { expect, test, type Page } from '@playwright/test';
import { observe, PIN, readOtp } from './helpers';

const EMAIL = process.env.E2E_EMAIL ?? 'collector.pemba@example.org';
/** Seeded preferred_language of the account (supabase/seed.staging.sql). */
const PROFILE_LANGUAGE = process.env.E2E_PROFILE_LANGUAGE ?? 'sw';

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

/**
 * People directory on a phone (brief §2.4, §5, §7.4), Arabic, a Pemba collector:
 *
 *  - the person card's project link is a full touch target (>= 44 px high);
 *  - an unfinished "add person" entry (name, Latin name, birth year typed in the new-person
 *    form) survives a reload of the app and comes back when the dialog opens again;
 *  - the directory counter and the search answer from the device.
 *
 * Nothing is written to the server: the new person is never created, and the stored draft is
 * discarded at the end.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  appNavigate,
  firstPage,
  launchDevice,
  newProfileDir,
  observe,
  removeProfile,
  runTag,
  signIn,
  unexpectedErrors,
  unlock,
  waitFirstSync,
} from './helpers';

const EMAIL = 'collector2.pemba@example.org';
const PHONE = { width: 375, height: 812 };

async function openPeople(page: Page): Promise<void> {
  // The phone's bottom bar has no "people" item: open the directory by its address.
  await appNavigate(page, '/people');
  await expect(page.getByTestId('people-page')).toBeVisible();
  await expect(page.getByTestId('person-row').first()).toBeVisible({ timeout: 30_000 });
}

test('people on a phone: card touch targets and an "add person" that survives a reload', async ({
  request,
}) => {
  test.setTimeout(8 * 60_000);
  const dir = newProfileDir('people');
  const context = await launchDevice(dir, { viewport: PHONE });
  try {
    const page = await firstPage(context);
    const seen = await observe(context, page);
    await signIn(page, request, EMAIL);
    await waitFirstSync(page);
    await appNavigate(page, '/settings');
    await page.getByTestId('lang-ar').click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    // --- the directory and its counter ------------------------------------------------
    await openPeople(page);
    const count = page.getByTestId('people-count');
    await expect(count).toHaveAttribute('data-shown', /^[1-9]\d*$/);

    // --- person card: the project link is a touch target --------------------------------
    const rows = page.getByTestId('person-row');
    const n = Math.min(await rows.count(), 12);
    let link = null;
    for (let i = 0; i < n && !link; i++) {
      await rows.nth(i).click();
      await expect(page.getByTestId('person-card')).toBeVisible();
      const candidate = page.getByTestId('person-project-link').first();
      if (await candidate.isVisible().catch(() => false)) link = candidate;
      else await page.getByTestId('person-back').click();
    }
    expect(link, 'a Pemba person with a project on this device').not.toBeNull();
    const box = await link!.boundingBox();
    expect(box, 'project link laid out').not.toBeNull();
    expect(box!.height, 'project link height (touch target)').toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
    // Still a working link to the project details.
    await link!.click();
    await expect(page.getByTestId('project-details-page')).toBeVisible();

    // --- "add person": typed details survive a reload ----------------------------------
    const tag = runTag();
    const nameAr = `حمدان المقبالي ${tag}`;
    await openPeople(page);
    await page.getByTestId('people-add').click();
    await page.getByTestId('people-add-picker-input').fill(nameAr);
    await page.getByTestId('people-add-picker-new').click();
    await expect(page.getByTestId('people-add-picker-new-name-ar')).toHaveValue(nameAr);
    await page.getByTestId('people-add-picker-new-name-latin').fill(`Hamdan Al Maqbali ${tag}`);
    await page.getByTestId('people-add-picker-new-birth-year').fill('1979');
    await page.waitForTimeout(500); // the draft is written on every change

    await page.reload();
    await unlock(page);
    await openPeople(page);
    await page.getByTestId('people-add').click();
    await expect(page.getByTestId('people-add-restored')).toBeVisible();
    await expect(page.getByTestId('people-add-picker-new-name-ar')).toHaveValue(nameAr);
    await expect(page.getByTestId('people-add-picker-new-name-latin')).toHaveValue(
      `Hamdan Al Maqbali ${tag}`,
    );
    await expect(page.getByTestId('people-add-picker-new-birth-year')).toHaveValue('1979');

    // Discarding (confirmed) forgets it: the next opening starts empty.
    await page.keyboard.press('Escape');
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('people-add-dialog')).toHaveCount(0);
    await page.getByTestId('people-add').click();
    await expect(page.getByTestId('people-add-picker-input')).toHaveValue('');
    await expect(page.getByTestId('people-add-restored')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // --- search answers from the device ------------------------------------------------
    await expect(page.getByTestId('people-add-dialog')).toHaveCount(0);
    await page.getByTestId('search-input').fill('zzzz-no-such-person');
    await expect(page.getByTestId('people-empty')).toBeVisible();

    expect(unexpectedErrors(seen.consoleErrors), 'console errors').toEqual([]);
    expect(seen.cspViolations).toEqual([]);
    expect(seen.foreignRequests).toEqual([]);
  } finally {
    await context.close().catch(() => undefined);
    removeProfile(dir);
  }
});

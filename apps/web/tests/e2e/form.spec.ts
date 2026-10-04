/**
 * The project form on a phone (brief §7.4, §7.10, §12), offline, through the real app:
 *
 *   - Esc never erases: it asks, and "add project" restores the unfinished entry at the next
 *     opening (no blank form next to it, no second draft);
 *   - text typed in the maintenance dialog survives a reload (PIN unlock) and the back button:
 *     the dialog opens again with it;
 *   - the form's small buttons — also the destructive "remove" ones — are at least 44 px high.
 *
 * Nothing is saved to the server: the entry is discarded at the end, and its autosaved draft
 * lived only in the temporary browser profile.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  countLocal,
  firstPage,
  launchDevice,
  newProfileDir,
  observe,
  removeProfile,
  signIn,
  unexpectedErrors,
  unlock,
  visible,
  waitFirstSync,
} from './helpers';

const EMAIL = 'collector2.pemba@example.org';
/** Pixel 5 (CSS pixels). */
const PHONE = { width: 393, height: 851 };
const NAME = 'مدرسة مراجعة الاتجاه';

interface StoredDraft {
  working: { project: { name_ar: string | null; status: string } };
  extras: { pendingMaintenance?: { row: { description: string } } | null };
}

/** Values of the app's `drafts` store (autosaved forms) on this device. */
async function storedDrafts(page: Page): Promise<StoredDraft[]> {
  return page.evaluate(
    () =>
      new Promise<StoredDraft[]>((resolve, reject) => {
        const open = indexedDB.open('istiqama-map');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result;
          const request = database.transaction('drafts', 'readonly').objectStore('drafts').getAll();
          request.onsuccess = () => {
            resolve((request.result as Array<{ value: StoredDraft }>).map((r) => r.value));
            database.close();
          };
          request.onerror = () => reject(request.error);
        };
      }),
  );
}

async function expectAutosaved(page: Page, description: string): Promise<void> {
  await expect
    .poll(
      async () =>
        (await storedDrafts(page)).map((d) => d.extras.pendingMaintenance?.row.description ?? ''),
      { message: 'the typed maintenance text is in the autosaved draft' },
    )
    .toEqual([description]);
}

test('form: Esc / back / reload never lose an entry; touch targets >= 44 px', async ({
  request,
}) => {
  test.setTimeout(6 * 60_000);
  const dir = newProfileDir('form');
  const context = await launchDevice(dir, { viewport: PHONE });
  try {
    const page = await firstPage(context);
    const seen = await observe(context, page);
    await signIn(page, request, EMAIL);
    await waitFirstSync(page);
    await context.setOffline(true);
    await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-state', 'offline');

    // --- 1. Esc asks, nothing is erased; the next "add project" restores the entry ----------
    await visible(page, 'add-project').click();
    await expect(page.getByTestId('project-form')).toBeVisible();
    await page.getByTestId('form-type-school').click();
    await page.getByTestId('form-name').fill(NAME);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('project-form')).toHaveCount(0);

    await visible(page, 'add-project').click();
    const resume = page.getByTestId('form-resume-dialog');
    await expect(resume).toBeVisible();
    await expect(resume).toContainText(NAME);
    await expect(page.getByTestId('project-form')).toHaveCount(0);
    await page.getByTestId('form-resume').click();
    await expect(page.getByTestId('form-name')).toHaveValue(NAME);
    await expect(page.getByTestId('form-drafts')).toHaveCount(0); // not listed twice
    expect(await countLocal(page, 'drafts'), 'one draft, not a second one').toBe(1);

    // --- 2. the maintenance dialog survives a reload ------------------------------------------
    await page.getByTestId('form-status').selectOption('maintenance');
    const dialog = page.getByTestId('form-maintenance-dialog');
    await expect(dialog).toBeVisible();
    await page.getByTestId('form-maint-description').fill('تشقق في الجدار الشرقي');
    await page.getByTestId('form-maint-cost').fill('250000');
    await expectAutosaved(page, 'تشقق في الجدار الشرقي');

    await page.reload();
    await unlock(page);
    await expect(page.getByTestId('form-name')).toHaveValue(NAME);
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('form-maint-description')).toHaveValue('تشقق في الجدار الشرقي');
    await expect(page.getByTestId('form-maint-cost')).toHaveValue('250000');
    await page.getByTestId('form-maint-save').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('form-maintenance-entry')).toHaveCount(1);

    // --- 3. … and the back button --------------------------------------------------------------
    await page.getByTestId('form-maintenance-add').click();
    await expect(dialog).toBeVisible();
    await page.getByTestId('form-maint-description').fill('باب المدخل مكسور');
    await expectAutosaved(page, 'باب المدخل مكسور');
    await page.goBack();
    await expect(page.getByTestId('project-form')).toHaveCount(0);
    await visible(page, 'add-project').click();
    await expect(resume).toBeVisible();
    await page.getByTestId('form-resume').click();
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('form-maint-description')).toHaveValue('باب المدخل مكسور');
    await page.getByTestId('form-maint-save').click();
    await expect(page.getByTestId('form-maintenance-entry')).toHaveCount(2);

    // --- 4. touch targets on the phone ---------------------------------------------------------
    for (const section of ['basics', 'donors', 'staff']) {
      await page.getByTestId(`form-section-${section}`).click();
    }
    await page.getByTestId('form-staff-add').click();
    await page.getByTestId('form-donor-add').click();
    const targets = [
      'form-staff-add',
      'form-donor-add',
      'form-maintenance-add',
      'form-build-date-add',
      'form-donor-remove',
      'form-staff-remove',
      'form-maintenance-edit',
      'form-maintenance-remove',
      'form-discard',
      'form-cancel',
      'form-save',
    ];
    const small: string[] = [];
    for (const id of targets) {
      const button = page.getByTestId(id).first();
      await button.scrollIntoViewIfNeeded();
      const box = await button.boundingBox();
      expect(box, `${id} is on screen`).toBeTruthy();
      if (box!.height < 44 || box!.width < 44)
        small.push(`${id} ${Math.round(box!.width)}×${Math.round(box!.height)}`);
    }
    expect(small, 'buttons below 44 px').toEqual([]);

    // --- clean-up: discard the entry (asks first) ---------------------------------------------
    await page.getByTestId('form-discard').click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('project-form')).toHaveCount(0);
    await expect.poll(() => countLocal(page, 'drafts')).toBe(0);

    expect(unexpectedErrors(seen.consoleErrors), 'console errors').toEqual([]);
    expect(seen.cspViolations, 'CSP violations').toEqual([]);
    expect(seen.foreignRequests, 'requests outside the loopback').toEqual([]);
  } finally {
    await context.close().catch(() => undefined);
    removeProfile(dir);
  }
});

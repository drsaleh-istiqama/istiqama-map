/**
 * Photos in the project form — leaving the form while photos are still being prepared
 * (Unit 3 review, group "photos"; brief §7.4, v2 parity 5.8):
 *
 *   1. a collector signs in, first sync, goes offline;
 *   2. opens "add project", types a name and chooses six large photos;
 *   3. while they are being compressed (CPU throttled like a 2 GB phone) taps another item
 *      of the navigation bar — the form route unmounts;
 *   4. the photos finish in the background: every one is on the device (both blobs), none is
 *      lost, none is orphaned;
 *   5. "add project" again → continue the unfinished entry: all six photos are in the form
 *      (those that finished after leaving come back by themselves) and in its autosaved draft;
 *   6. "discard" frees every blob again.
 *
 * Nothing reaches the server (the device stays offline after the first sync).
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
  visible,
  waitFirstSync,
} from './helpers';

const EMAIL = 'collector2.pemba@example.org';
const PHOTOS = 6;

/** A 12-megapixel JPEG drawn in the page (no files in the repository, no network). */
async function largeJpeg(page: Page, seed: number): Promise<Buffer> {
  const base64 = await page.evaluate(async (n) => {
    const canvas = new OffscreenCanvas(4000, 3000);
    const g = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
    const gradient = g.createLinearGradient(0, 0, 4000, 3000);
    gradient.addColorStop(0, `hsl(${(n * 47) % 360} 60% 40%)`);
    gradient.addColorStop(1, `hsl(${(n * 47 + 120) % 360} 60% 60%)`);
    g.fillStyle = gradient;
    g.fillRect(0, 0, 4000, 3000);
    let s = n * 7919;
    const rnd = (): number => (s = (s * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 400; i++) {
      g.fillStyle = `hsl(${Math.floor(rnd() * 360)} 50% ${30 + Math.floor(rnd() * 40)}%)`;
      g.fillRect(rnd() * 4000, rnd() * 3000, 40 + rnd() * 400, 40 + rnd() * 400);
    }
    g.fillStyle = '#ffffff';
    g.font = 'bold 400px sans-serif';
    g.fillText(`E2E ${n}`, 300, 1700);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }, seed);
  return Buffer.from(base64, 'base64');
}

/** Entries of the `drafts` store whose key starts with `prefix` (read inside the page). */
async function draftEntries(
  page: Page,
  prefix: string,
): Promise<Array<{ key: string; value: unknown }>> {
  return page.evaluate(
    (start) =>
      new Promise<Array<{ key: string; value: unknown }>>((resolve, reject) => {
        const open = indexedDB.open('istiqama-map');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result;
          const request = database
            .transaction('drafts', 'readonly')
            .objectStore('drafts')
            .getAll(IDBKeyRange.bound(start, start + String.fromCharCode(0xffff)));
          request.onsuccess = () => {
            resolve(
              (request.result as Array<{ key: string; value: unknown }>).map((r) => ({
                key: r.key,
                value: r.value,
              })),
            );
            database.close();
          };
          request.onerror = () => reject(request.error);
        };
      }),
    prefix,
  );
}

test('leaving the form while photos are being prepared loses none of them', async ({ request }) => {
  test.setTimeout(6 * 60_000);
  const profile = newProfileDir('photos-leave');
  const context = await launchDevice(profile, { viewport: { width: 412, height: 915 } });
  try {
    const page = await firstPage(context);
    const seen = await observe(context, page);
    await signIn(page, request, EMAIL);
    await waitFirstSync(page);
    await context.setOffline(true);
    await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-state', 'offline');

    const files = [];
    for (let i = 1; i <= PHOTOS; i++) {
      files.push({
        name: `e2e-leave-${i}.jpg`,
        mimeType: 'image/jpeg',
        buffer: await largeJpeg(page, i),
      });
    }

    // --- 2. a new project with a name and six photos ----------------------------------------
    await visible(page, 'add-project').click();
    await expect(page.getByTestId('project-form')).toBeVisible();
    await page.getByTestId('form-type-mosque').click();
    await page.getByTestId('form-name').fill('مسجد الصور المؤجلة');
    await expect(page.getByTestId('form-photo-input')).toBeAttached();

    // A low-end phone: compression takes a while.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 8 });
    await page.getByTestId('form-photo-input').setInputFiles(files);
    await expect(page.getByTestId('photo-progress')).toBeVisible({ timeout: 30_000 });

    // --- 3. the collector taps another item of the navigation bar ---------------------------
    await visible(page, 'nav-projects').click();
    await expect(page.getByTestId('project-form')).toHaveCount(0);

    // --- 4. the batch finishes in the background: every photo is on the device --------------
    await expect
      .poll(() => countLocal(page, 'photo_blobs'), {
        message: 'both blobs of every chosen photo stored',
        timeout: 180_000,
      })
      .toBe(PHOTOS * 2);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const detached = await draftEntries(page, 'photos:detached:');
    const kept = detached.reduce(
      (n, e) => n + ((e.value as { entries?: unknown[] }).entries?.length ?? 0),
      0,
    );
    // The scenario really happened: at least one photo finished after the form was gone.
    expect(kept, 'photos that finished after leaving the form').toBeGreaterThan(0);

    // --- 5. continue the unfinished entry: all six photos are back in the form --------------
    await visible(page, 'add-project').click();
    await page.getByTestId('form-resume').click();
    await expect(page.getByTestId('project-form')).toBeVisible();
    await expect(page.getByTestId('form-name')).toHaveValue('مسجد الصور المؤجلة');
    await expect(page.getByTestId('photo-card')).toHaveCount(PHOTOS, { timeout: 30_000 });
    await expect(page.getByTestId('photo-status')).not.toBeEmpty();
    await expect(page.locator('[data-testid="photo-card"][data-cover="true"]')).toHaveCount(1);
    await expect
      .poll(
        async () => {
          const forms = await draftEntries(page, 'project-form:new:');
          return forms.map(
            (f) => (f.value as { working?: { photos?: unknown[] } }).working?.photos?.length ?? 0,
          );
        },
        { message: 'the autosaved draft holds all photos', timeout: 20_000 },
      )
      .toContain(PHOTOS);

    // --- 6. discard: every blob is freed, nothing is left waiting ----------------------------
    await page.getByTestId('form-discard').click();
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('project-form')).toHaveCount(0);
    await expect.poll(() => countLocal(page, 'photo_blobs')).toBe(0);
    expect(await draftEntries(page, 'photos:detached:')).toEqual([]);
    expect(await draftEntries(page, 'project-form:new:')).toEqual([]);

    expect(unexpectedErrors(seen.consoleErrors), 'console errors').toEqual([]);
    expect(seen.cspViolations).toEqual([]);
    expect(seen.foreignRequests).toEqual([]);
  } finally {
    await context.close().catch(() => undefined);
    removeProfile(profile);
  }
});

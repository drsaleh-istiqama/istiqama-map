/**
 * Acceptance criterion 3 of the brief (§14.3) — the field scenario:
 *
 *   1. a collector signs in (e-mail OTP), chooses a PIN, first sync;
 *   2. the connection drops;
 *   3. 20 projects are created through the real form, each with a GPS fix inside Pemba and a
 *      photo (JPEG drawn on the fly);
 *   4. the browser is closed completely and reopened on the same profile (PIN unlock);
 *   5. the connection returns;
 *   6. everything is uploaded — no loss, no duplicates — checked on the server with the
 *      service role: exactly 20 new projects by that user, each with its photo rows
 *      `upload_state = 'uploaded'` and both storage objects, unique ids and names, and an
 *      empty outbox on the device.
 *
 * Clean-up: the projects and photos are soft-deleted (service role) at the end.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  countLocal,
  firstPage,
  launchDevice,
  localMetaKeys,
  makeJpeg,
  newProfileDir,
  observe,
  removeProfile,
  runTag,
  saveProjectForm,
  SCREENS_DIR,
  serviceSelect,
  signIn,
  softDeleteRows,
  storageObjectExists,
  tallScreenshot,
  unexpectedErrors,
  unlock,
  userIdOf,
  visible,
  waitFirstSync,
  waitSynced,
} from './helpers';

const EMAIL = 'collector.pemba@example.org';
/** 20 by the brief; `E2E_FIELD_COUNT` shortens a debugging run (max 28 grid points). */
const COUNT = Math.min(28, Number(process.env.E2E_FIELD_COUNT ?? 20));

/**
 * Points inside North Pemba, ~660 m apart and more than 500 m from every seeded project
 * (checked with ST_Contains / ST_DWithin against the imported geoBoundaries): no duplicate
 * by distance, and the offline geofill finds the region.
 */
function pembaPoint(i: number): { latitude: number; longitude: number } {
  const row = Math.floor(i / 7);
  const col = i % 7;
  return { latitude: -5.0 - row * 0.006, longitude: 39.74 + col * 0.006 };
}

/**
 * DIAGNOSTIC ONLY — off unless `E2E_FIX_TUS_AUTH=1`. Known defect of src/sync/tusUploader.ts:
 * the bearer token is set in tus `headers` AND again in `onBeforeRequest`; the browser's
 * XMLHttpRequest joins both values ("Bearer t, Bearer t") and the storage API answers 403
 * "Invalid Compact JWS", so no photo is ever uploaded from a browser. This route keeps the
 * first value so that a run can show whether anything ELSE blocks the scenario. The normal
 * run (and CI) must stay red until the sync module is fixed.
 */
async function repairTusAuthorization(context: BrowserContext): Promise<void> {
  await context.route('**/storage/v1/upload/resumable**', async (route) => {
    const headers = { ...route.request().headers() };
    const auth = headers.authorization;
    if (auth?.includes(',')) headers.authorization = (auth.split(',')[0] ?? '').trim();
    await route.continue({ headers });
  });
}

interface CreatedProject {
  id: string;
  name: string;
}

/** Fills and saves one project through the form; returns its id (from the details URL). */
async function createProject(
  page: Page,
  context: BrowserContext,
  i: number,
  name: string,
  screenshot: boolean,
): Promise<string> {
  const point = pembaPoint(i);
  await context.setGeolocation({ ...point, accuracy: 4 });

  await visible(page, 'add-project').click();
  await expect(page.getByTestId('project-form')).toBeVisible();
  await page.getByTestId(i % 3 === 1 ? 'form-type-school' : 'form-type-mosque').click();
  await page.getByTestId('form-name').fill(name);

  // GPS (accuracy 4 m ends the capture at once), then the offline geofill of the region.
  await page.getByTestId('form-gps').click();
  await expect
    .poll(async () => Number(await page.getByTestId('form-lat').inputValue()), {
      message: 'latitude filled from GPS',
    })
    .toBeCloseTo(point.latitude, 4);
  await expect
    .poll(async () => Number(await page.getByTestId('form-lon').inputValue()))
    .toBeCloseTo(point.longitude, 4);
  await expect(page.getByTestId('form-country')).not.toHaveValue('', { timeout: 20_000 });
  await expect(page.getByTestId('form-area')).not.toHaveValue('', { timeout: 20_000 });

  await page.getByTestId('form-status').selectOption('active');

  await page.getByTestId('form-photo-input').setInputFiles({
    name: `e2e-field-${i + 1}.jpg`,
    mimeType: 'image/jpeg',
    buffer: await makeJpeg(page, i + 1),
  });
  await expect(page.getByTestId('photo-card')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator('.photo-editor')).toHaveAttribute('data-busy', 'false');
  if (screenshot) await tallScreenshot(page, `${SCREENS_DIR}/form.png`);

  // Earlier projects of this run lie within the 1.5 km "same village" radius with a similar
  // name, so the duplicate question can come up: the collector answers "different project".
  const { id, asked } = await saveProjectForm(page, 'form-save');
  expect(asked, 'no geo-validation warning for a GPS point inside the region').not.toContain('geo');
  if (screenshot) {
    await expect(page.getByTestId('details-name')).toContainText(name);
    await tallScreenshot(page, `${SCREENS_DIR}/details.png`);
  }
  return id;
}

test('field scenario: 20 offline projects with photos survive a restart and sync once', async ({
  request,
}) => {
  test.setTimeout(30 * 60_000);
  const tag = runTag();
  const userId = await userIdOf(request, EMAIL);
  // Server-side reference point (no dependency on this machine's clock).
  const latest = await serviceSelect<{ created_at: string }>(
    request,
    `projects?select=created_at&created_by=eq.${userId}&order=created_at.desc&limit=1`,
  );
  const since = latest[0]?.created_at ?? '1970-01-01T00:00:00Z';

  const profile = newProfileDir('field');
  const created: CreatedProject[] = [];
  let context: BrowserContext | null = null;
  try {
    // --- 1. sign in, PIN, first sync ------------------------------------------------------------
    context = await launchDevice(profile, { geolocation: pembaPoint(0) });
    let page = await firstPage(context);
    let seen = await observe(context, page);
    await signIn(page, request, EMAIL);
    await waitFirstSync(page);

    // The form caches the region shapes (offline geofill) the first time it opens online.
    await visible(page, 'add-project').click();
    await expect(page.getByTestId('project-form')).toBeVisible();
    await expect
      .poll(async () => (await localMetaKeys(page, 'form.geo.shapes:')).length, {
        message: 'region shapes cached for offline geofill',
        timeout: 60_000,
      })
      .toBeGreaterThanOrEqual(2);
    await page.getByTestId('form-cancel').click();
    await expect(page.getByTestId('project-form')).toHaveCount(0);

    // --- 2. offline -----------------------------------------------------------------------------
    await context.setOffline(true);
    await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-state', 'offline');

    // --- 3. twenty projects, each with a GPS fix and a photo ------------------------------------
    for (let i = 0; i < COUNT; i++) {
      const name = `مسجد ميداني ${i + 1} ${tag}`;
      const id = await createProject(page, context, i, name, i === 0);
      created.push({ id, name });
    }
    expect(new Set(created.map((p) => p.id)).size).toBe(COUNT);
    await expect(page.getByTestId('sync-pending-photos')).toHaveText(String(COUNT));
    const pendingOps = Number(await page.getByTestId('sync-pending-ops').textContent());
    expect(pendingOps, 'operations waiting in the outbox').toBeGreaterThanOrEqual(COUNT * 2);
    expect(await countLocal(page, 'outbox')).toBeGreaterThanOrEqual(COUNT * 2);
    expect(unexpectedErrors(seen.consoleErrors), 'console errors while offline').toEqual([]);
    expect(seen.cspViolations).toEqual([]);
    expect(seen.foreignRequests).toEqual([]);

    // --- 4. close the browser completely, reopen the same profile (still offline) ---------------
    await context.close();
    context = await launchDevice(profile, { geolocation: pembaPoint(0) });
    await context.setOffline(true);
    page = await firstPage(context);
    seen = await observe(context, page);
    if (process.env.E2E_FIX_TUS_AUTH === '1') await repairTusAuthorization(context);
    await page.goto('/');
    await unlock(page);
    await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-state', 'offline');
    await expect(page.getByTestId('sync-pending-photos')).toHaveText(String(COUNT));
    expect(Number(await page.getByTestId('sync-pending-ops').textContent())).toBe(pendingOps);

    // --- 5. back online: the records go up first ------------------------------------------------
    // (Records and photos are checked one after the other, so a red run says which half failed.)
    const explain = (error: unknown, what: string): Error =>
      new Error(
        `${(error as Error).message}\n\n${what} — API answers ≥ 400 after the restart:\n` +
          [...new Set(seen.failedResponses)].slice(0, 20).join('\n'),
        { cause: error },
      );
    await context.setOffline(false);
    try {
      await waitSynced(page, 3 * 60_000, { photos: false });
    } catch (error) {
      throw explain(error, 'records not uploaded');
    }
    expect(await countLocal(page, 'outbox'), 'outbox empty').toBe(0);
    expect(await countLocal(page, 'failed_ops'), 'no rejected operation').toBe(0);

    // --- 6a. the server has exactly the records that were entered -------------------------------
    const rows = await serviceSelect<{
      id: string;
      name_ar: string;
      deleted_at: string | null;
      record_state: string;
    }>(
      request,
      `projects?select=id,name_ar,deleted_at,record_state&created_by=eq.${userId}` +
        `&created_at=gt.${encodeURIComponent(since)}`,
    );
    expect(rows.length, 'new projects of this user on the server').toBe(COUNT);
    expect(new Set(rows.map((r) => r.id)).size, 'no duplicate ids').toBe(COUNT);
    expect(new Set(rows.map((r) => r.name_ar)).size, 'no duplicate names').toBe(COUNT);
    expect(rows.map((r) => r.id).sort()).toEqual(created.map((p) => p.id).sort());
    expect(rows.map((r) => r.name_ar).sort()).toEqual(created.map((p) => p.name).sort());
    for (const row of rows) {
      expect(row.deleted_at).toBeNull();
      expect(row.record_state).toBe('submitted');
    }
    const byName = await serviceSelect<{ id: string }>(
      request,
      `projects?select=id&name_ar=like.*${encodeURIComponent(tag)}`,
    );
    expect(byName.length, 'no second copy under another user or device').toBe(COUNT);

    // --- 5b / 6b. the photos: both objects of every photo, rows flipped to "uploaded" ---------
    try {
      await waitSynced(page, 5 * 60_000);
    } catch (error) {
      throw explain(error, 'photos not uploaded');
    }
    expect(seen.failedResponses, 'no API call refused while uploading').toEqual([]);
    expect(await countLocal(page, 'outbox'), 'outbox empty after the photo flips').toBe(0);
    expect(await countLocal(page, 'failed_ops'), 'no rejected operation').toBe(0);

    const photos = await serviceSelect<{
      id: string;
      project_id: string;
      upload_state: string;
      storage_path_full: string | null;
      storage_path_thumb: string | null;
      deleted_at: string | null;
    }>(
      request,
      `project_photos?select=id,project_id,upload_state,storage_path_full,storage_path_thumb,deleted_at` +
        `&project_id=in.(${created.map((p) => p.id).join(',')})`,
    );
    expect(photos.length, 'one photo per project').toBe(COUNT);
    expect(new Set(photos.map((p) => p.project_id)).size).toBe(COUNT);
    for (const photo of photos) {
      expect(photo.deleted_at).toBeNull();
      expect(photo.upload_state, `photo ${photo.id}`).toBe('uploaded');
      expect(photo.storage_path_full).toMatch(
        new RegExp(`^projects/TZ/${photo.project_id}/${photo.id}_full\\.(webp|jpg)$`),
      );
      expect(photo.storage_path_thumb).toMatch(
        new RegExp(`^projects/TZ/${photo.project_id}/${photo.id}_thumb\\.(webp|jpg)$`),
      );
      expect(
        await storageObjectExists(request, 'photos', photo.storage_path_full as string),
        `full object of ${photo.id}`,
      ).toBe(true);
      expect(
        await storageObjectExists(request, 'photos', photo.storage_path_thumb as string),
        `thumbnail object of ${photo.id}`,
      ).toBe(true);
    }

    expect(unexpectedErrors(seen.consoleErrors), 'console errors after the restart').toEqual([]);
    expect(seen.cspViolations).toEqual([]);
    expect(seen.foreignRequests).toEqual([]);
  } finally {
    await context?.close().catch(() => undefined);
    removeProfile(profile);
    // Clean-up: everything this run created (also after a failure half-way).
    const mine = await serviceSelect<{ id: string }>(
      request,
      `projects?select=id&name_ar=like.*${encodeURIComponent(tag)}`,
    ).catch(() => []);
    const ids = [...new Set([...mine.map((p) => p.id), ...created.map((p) => p.id)])];
    await softDeleteRows(request, 'project_photos', 'project_id', ids).catch(() => 0);
    await softDeleteRows(request, 'projects', 'id', ids).catch(() => 0);
  }
});

/**
 * The supervisor's lists on the real app (brief §5, §6, §7.4), on a phone-sized screen:
 *
 *  - the register shows the cover photo's THUMBNAIL of a project (an uploaded photo is pulled,
 *    its thumbnail downloaded through storage and shown inside the fixed-height row);
 *  - the review queue is a virtual list (only the rows in view exist in the DOM);
 *  - Android Back while a typed "return to collector" note is open asks first, keeps the
 *    page and the note; after "discard" the dialog is gone and Back leaves the page normally.
 *
 * Nothing is decided: the submitted record stays submitted. The photo created for the test
 * is soft-deleted at the end.
 */
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  appNavigate,
  firstPage,
  launchDevice,
  localEnv,
  newProfileDir,
  observe,
  removeProfile,
  SCREENS_DIR,
  serviceSelect,
  signIn,
  softDeleteRows,
  SUPABASE_URL,
  unexpectedErrors,
  waitFirstSync,
} from './helpers';

const SUPERVISOR = 'supervisor.pemba@example.org';
/** Seeded approved project of the Pemba branch (reference data), given a cover for the test. */
const COVER_CODE = 'TZ-PS-000014';
const NOTE = 'Picha hazipo na idadi ya waumini si sahihi — tafadhali sahihisha.';

function serviceHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? localEnv().SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY missing (.env.local or environment)');
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

/** A small WebP drawn in the page (no image files in the repository, no network). */
async function makeWebp(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(400, 300);
    const g = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
    g.fillStyle = '#1f7a4d';
    g.fillRect(0, 0, 400, 300);
    g.fillStyle = '#c8a24a';
    g.fillRect(40, 200, 320, 60);
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  });
  return Buffer.from(base64, 'base64');
}

/** An uploaded cover photo of the project: storage object + `project_photos` row. */
async function addUploadedCover(
  request: APIRequestContext,
  project: { id: string },
  thumb: Buffer,
): Promise<string> {
  const id = randomUUID();
  const thumbPath = `projects/TZ/${project.id}/${id}_thumb.webp`;
  const upload = await request.post(`${SUPABASE_URL}/storage/v1/object/photos/${thumbPath}`, {
    headers: serviceHeaders({ 'content-type': 'image/webp', 'x-upsert': 'true' }),
    data: thumb,
  });
  expect(upload.ok(), `upload ${thumbPath}: ${upload.status()} ${await upload.text()}`).toBe(true);
  const insert = await request.post(`${SUPABASE_URL}/rest/v1/project_photos`, {
    headers: serviceHeaders({ 'content-type': 'application/json', prefer: 'return=minimal' }),
    data: {
      id,
      project_id: project.id,
      storage_path_full: `projects/TZ/${project.id}/${id}_full.webp`,
      storage_path_thumb: thumbPath,
      width: 400,
      height: 300,
      bytes: thumb.length,
      is_cover: true,
      category: 'school_front',
      upload_state: 'uploaded',
    },
  });
  expect(insert.ok(), `insert photo: ${insert.status()} ${await insert.text()}`).toBe(true);
  return id;
}

test('supervisor: cover thumbnails in the register; virtual review queue; Back keeps a typed note', async ({
  request,
}) => {
  test.setTimeout(10 * 60_000);
  const [coverProject] = await serviceSelect<{ id: string }>(
    request,
    `projects?select=id&code=eq.${COVER_CODE}&deleted_at=is.null`,
  );
  expect(coverProject, `seeded project ${COVER_CODE}`).toBeTruthy();
  const submitted = await serviceSelect<{ id: string; code: string }>(
    request,
    `projects?select=id,code,branch:branches!inner(code)&record_state=eq.submitted&deleted_at=is.null&branch.code=eq.PEMBA`,
  );
  expect(submitted.length, 'submitted records of the Pemba branch').toBeGreaterThan(0);

  const dir = newProfileDir('review');
  const context = await launchDevice(dir, { viewport: { width: 412, height: 860 } });
  let photoId: string | null = null;
  try {
    const page = await firstPage(context);
    const seen = await observe(context, page);
    await page.goto('/');
    photoId = await addUploadedCover(request, coverProject!, await makeWebp(page));

    await signIn(page, request, SUPERVISOR);
    await waitFirstSync(page);

    // --- the register: the cover thumbnail inside the row ---------------------------------------
    await appNavigate(page, '/projects');
    await expect(page.getByTestId('projects-page')).toBeVisible();
    await page.getByTestId('search-input').fill(COVER_CODE);
    const coverRow = page.getByTestId('project-row').filter({ hasText: COVER_CODE });
    await expect(coverRow).toHaveCount(1, { timeout: 30_000 });
    const img = coverRow.locator('[data-testid=project-cover] img');
    await expect(img).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth))
      .toBeGreaterThan(0);
    const box = await img.boundingBox();
    const rowBox = await coverRow.boundingBox();
    expect(box && rowBox && box.height <= rowBox.height).toBe(true);
    await page.screenshot({ path: `${SCREENS_DIR}/register-cover.png` });
    await page.getByTestId('search-input').fill('');

    // --- the review queue: a virtual list ----------------------------------------------------
    await appNavigate(page, '/review');
    await expect(page.getByTestId('review-page')).toBeVisible();
    const list = page.getByTestId('review-rows');
    await expect(list).toBeVisible({ timeout: 30_000 });
    await expect(list.getByTestId('review-row').first()).toBeVisible();
    expect(await list.getByRole('listitem').first().getAttribute('aria-setsize')).toBe(
      String(submitted.length),
    );
    await expect(page.getByTestId('review-more')).toHaveCount(0);
    await page.screenshot({ path: `${SCREENS_DIR}/review-queue.png` });

    // --- Back with a typed return note -------------------------------------------------------
    const row = list.getByTestId('review-row').first();
    const rowId = await row.getAttribute('data-id');
    await row.getByTestId('review-return').click();
    const dialog = page.getByTestId('return-dialog');
    await expect(dialog).toBeVisible();
    await page.getByTestId('return-note').fill(NOTE);

    await page.goBack();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/review');
    await expect(dialog).toBeVisible();
    await page.getByTestId('confirm-cancel').click();
    await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
    await expect(page.getByTestId('return-note')).toHaveValue(NOTE);

    await page.goBack();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await page.getByTestId('confirm-ok').click();
    await expect(dialog).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe('/review');
    await expect(list.locator(`[data-testid=review-row][data-id="${rowId}"]`)).toBeVisible();

    // The dialog left no extra history entry: Back now leaves the review page.
    await page.goBack();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/projects');
    await expect(page.getByTestId('projects-page')).toBeVisible();

    // Nothing was decided.
    const [after] = await serviceSelect<{ record_state: string }>(
      request,
      `projects?select=record_state&id=eq.${rowId}`,
    );
    expect(after?.record_state).toBe('submitted');

    expect(unexpectedErrors(seen.consoleErrors), 'console errors').toEqual([]);
    expect(seen.cspViolations).toEqual([]);
    expect(seen.foreignRequests).toEqual([]);
  } finally {
    await context.close().catch(() => undefined);
    removeProfile(dir);
    if (photoId) await softDeleteRows(request, 'project_photos', 'id', [photoId]);
  }
});

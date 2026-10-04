/**
 * Role scenarios (brief §3, §14.5) on the real app:
 *
 *  - viewer: map and lists, but no people menu, no "add project", no staff names or phones
 *    (not on screen and not even on the device);
 *  - collector of Mombasa: no Pemba (Tanzania) project anywhere — list, search, details by
 *    address, the device database — nor through the API with his own token.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  appNavigate,
  countLocal,
  firstPage,
  launchDevice,
  localEnv,
  newProfileDir,
  observe,
  removeProfile,
  SCREENS_DIR,
  serviceSelect,
  signIn,
  SUPABASE_URL,
  unexpectedErrors,
  visible,
  waitFirstSync,
} from './helpers';

/** Seeded v2 sample project 01 (North Pemba) with staff (reference-data.md §6.4). */
const PEMBA_CODE = 'TZ-PN-000001';

/** Codes of the projects stored on this device. */
function localProjectCodes(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open('istiqama-map');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result;
          const request = database
            .transaction('projects', 'readonly')
            .objectStore('projects')
            .getAll();
          request.onsuccess = () => {
            resolve((request.result as Array<{ code?: string | null }>).map((p) => p.code ?? ''));
            database.close();
          };
          request.onerror = () => reject(request.error);
        };
      }),
  );
}

test('viewer: map and lists, no people, no staff names or phones, no add button', async ({
  request,
}) => {
  test.setTimeout(8 * 60_000);
  const [project] = await serviceSelect<{ id: string; name_ar: string }>(
    request,
    `projects?select=id,name_ar&code=eq.${PEMBA_CODE}`,
  );
  expect(project, `seeded project ${PEMBA_CODE}`).toBeTruthy();
  const staff = await serviceSelect<{
    person: { name_ar: string | null; name_latin: string | null; phone_e164: string | null };
  }>(
    request,
    `project_staff?select=person:persons(name_ar,name_latin,phone_e164)&project_id=eq.${project!.id}&deleted_at=is.null`,
  );
  expect(staff.length, 'the seeded project has staff').toBeGreaterThan(0);
  const secrets = staff
    .flatMap((s) => [s.person.name_ar, s.person.name_latin, s.person.phone_e164])
    .filter((v): v is string => !!v && v.length > 3);

  const dir = newProfileDir('viewer');
  const context = await launchDevice(dir);
  try {
    const page = await firstPage(context);
    const seen = await observe(context, page);
    await signIn(page, request, 'viewer@example.org');
    await waitFirstSync(page);

    // No writing, no people directory.
    await expect(page.getByTestId('add-project')).toHaveCount(0);
    await expect(page.getByTestId('nav-people')).toHaveCount(0);
    await expect(page.getByTestId('nav-review')).toHaveCount(0);

    // The map.
    await visible(page, 'nav-map').click();
    await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('map-locate')).toBeVisible();
    await page.waitForTimeout(1_500); // let the tiles paint for the screenshot
    await page.screenshot({ path: `${SCREENS_DIR}/map-viewer.png` });

    // The register.
    await visible(page, 'nav-projects').click();
    await expect(page.getByTestId('projects-page')).toBeVisible();
    await expect(page.getByTestId('project-row').first()).toBeVisible({ timeout: 30_000 });

    // Details of a project with staff: the staff section says "hidden", no name, no phone.
    await appNavigate(page, `/projects/${project!.id}`);
    // (The title follows the interface language — English for this account — so match the code.)
    await expect(page.getByTestId('details-code')).toContainText(PEMBA_CODE);
    await expect(page.getByTestId('staff-hidden')).toBeVisible();
    await expect(page.getByTestId('staff-name')).toHaveCount(0);
    await expect(page.getByTestId('staff-phone')).toHaveCount(0);
    await expect(page.getByTestId('staff-salary')).toHaveCount(0);
    const text = (await page.locator('body').innerText()).normalize('NFC');
    for (const secret of secrets)
      expect(text, 'no staff name or phone on screen').not.toContain(secret);

    // The address of the directory: refused, and nothing about people on the device.
    await appNavigate(page, '/people');
    await expect(page.getByTestId('people-forbidden')).toBeVisible();
    expect(await countLocal(page, 'persons'), 'no person on a viewer device').toBe(0);
    expect(await countLocal(page, 'project_staff'), 'no staff row on a viewer device').toBe(0);

    expect(unexpectedErrors(seen.consoleErrors), 'console errors').toEqual([]);
    expect(seen.cspViolations).toEqual([]);
    expect(seen.foreignRequests).toEqual([]);
  } finally {
    await context.close().catch(() => undefined);
    removeProfile(dir);
  }
});

test('collector of Mombasa sees no Pemba project — not in the app, not through the API', async ({
  request,
}) => {
  test.setTimeout(8 * 60_000);
  const [pemba] = await serviceSelect<{ id: string; name_ar: string }>(
    request,
    `projects?select=id,name_ar&code=eq.${PEMBA_CODE}`,
  );
  expect(pemba).toBeTruthy();

  const dir = newProfileDir('mombasa');
  const context = await launchDevice(dir);
  try {
    const page = await firstPage(context);
    const seen = await observe(context, page);
    await signIn(page, request, 'collector.mombasa@example.org');
    await waitFirstSync(page);

    // The device holds Kenyan projects only.
    const codes = await localProjectCodes(page);
    expect(codes.length, 'the Mombasa projects arrived').toBeGreaterThan(0);
    expect(
      codes.filter((c) => !c.startsWith('KE-')),
      'non-Kenyan projects on the device',
    ).toEqual([]);

    // The register shows only them.
    await visible(page, 'nav-projects').click();
    const rows = page.getByTestId('project-row');
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
    for (const row of await rows.all()) await expect(row).not.toContainText('TZ-');

    // Searching a Pemba name (device + server search) finds nothing of Pemba.
    await page.getByTestId('search-input').fill(pemba!.name_ar);
    await page.waitForTimeout(1_500); // debounce 250 ms + server round trip
    await expect(page.getByTestId('search-hit-project').filter({ hasText: 'TZ-' })).toHaveCount(0);
    await expect(page.getByTestId('project-row').filter({ hasText: 'TZ-' })).toHaveCount(0);

    // Opening the Pemba project by its address: not on this device.
    await appNavigate(page, `/projects/${pemba!.id}`);
    await expect(page.getByTestId('details-not-found')).toBeVisible();
    await expect(page.getByTestId('details-name')).toHaveCount(0);

    expect(unexpectedErrors(seen.consoleErrors), 'console errors').toEqual([]);
    expect(seen.cspViolations).toEqual([]);
    expect(seen.foreignRequests).toEqual([]);
  } finally {
    await context.close().catch(() => undefined);
    removeProfile(dir);
  }

  // Directly through the API with the collector's own token (RLS): no Tanzanian row, no salary.
  const anon = process.env.VITE_SUPABASE_ANON_KEY ?? localEnv().SUPABASE_ANON_KEY ?? '';
  const login = await request.post(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    headers: { apikey: anon, 'Content-Type': 'application/json' },
    data: { email: 'collector.mombasa@example.org', password: 'Passw0rd!dev' },
  });
  expect(login.ok(), `password sign-in: ${login.status()}`).toBe(true);
  const token = ((await login.json()) as { access_token: string }).access_token;
  const auth = { apikey: anon, Authorization: `Bearer ${token}` };
  const tz = await request.get(`${SUPABASE_URL}/rest/v1/projects?select=code&code=like.TZ-*`, {
    headers: auth,
  });
  expect(tz.ok()).toBe(true);
  expect(await tz.json(), 'Tanzanian projects through the API').toEqual([]);
  const byId = await request.get(`${SUPABASE_URL}/rest/v1/projects?select=id&id=eq.${pemba!.id}`, {
    headers: auth,
  });
  expect(await byId.json(), 'the Pemba project by id').toEqual([]);
  const salaries = await request.get(`${SUPABASE_URL}/rest/v1/staff_compensation?select=id`, {
    headers: auth,
  });
  const body = (await salaries.json()) as unknown;
  expect(
    !salaries.ok() || (Array.isArray(body) && body.length === 0),
    'no salary through the API',
  ).toBe(true);
});

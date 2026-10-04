/**
 * The map on the real app (brief §5 map, §4.7 packs, §12 "my location"): the basemap from our
 * own storage and the server-clustered project tiles, the heat maps, "my location", search →
 * list → project card, pick mode from the project form, the packs section in Settings, and
 * the offline basemap notice. Throughout: no CSP violation, no request off the loopback (no
 * tile.openstreetmap.org), no console error.
 *
 * The second test is the field phone (Pixel 5, touch, `pointer: coarse`): the first map shows
 * the collector's projects once the first sync brought them, the search bar fits the screen in
 * Swahili, the map controls are 44 px and keep clear of the OpenStreetMap attribution, and a
 * project chosen from the list is drawn above its card, whose "View details" stays whole.
 *
 * Read-only on the server (the form is left without saving; its autosaved draft lives only in
 * the temporary browser profile).
 */
import { chromium, devices, expect, test, type Page } from '@playwright/test';
import {
  appNavigate,
  BASE_URL,
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

/** Wete, North Pemba (the collector's branch). */
const HERE = { latitude: -5.06, longitude: 39.73, accuracy: 12 };
const TILE_URL = /\/functions\/v1\/tiles\/\d+\/\d+\/\d+/;

// --- phone geometry helpers ----------------------------------------------------------------------

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}
interface ProjectPoint {
  code: string;
  lon: number;
  lat: number;
}

/** Projects of this device with a location (read in the page; IndexedDB is per profile). */
function localProjectPoints(page: Page): Promise<ProjectPoint[]> {
  return page.evaluate(
    () =>
      new Promise<ProjectPoint[]>((resolve, reject) => {
        const open = indexedDB.open('istiqama-map');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result;
          const request = database
            .transaction('projects', 'readonly')
            .objectStore('projects')
            .getAll();
          request.onsuccess = () => {
            database.close();
            const rows = request.result as Array<Record<string, unknown>>;
            resolve(
              rows
                .filter(
                  (r) => !r.deleted_at && typeof r.lon === 'number' && typeof r.lat === 'number',
                )
                .map((r) => ({
                  code: String(r.code ?? r.id),
                  lon: r.lon as number,
                  lat: r.lat as number,
                })),
            );
          };
          request.onerror = () => reject(request.error);
        };
      }),
  );
}

/** Boxes of the map page's pieces and the remembered camera (the centre of the whole canvas). */
function mapGeometry(page: Page) {
  return page.evaluate(() => {
    const box = (el: Element | null): Box | null => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) return null;
      return {
        top: b.top,
        bottom: b.bottom,
        left: b.left,
        right: b.right,
        width: b.width,
        height: b.height,
      };
    };
    const q = (selector: string) => box(document.querySelector(selector));
    let camera: { lon: number; lat: number; zoom: number } | null;
    try {
      camera = JSON.parse(localStorage.getItem('istiqama.pref.map.camera') ?? 'null');
    } catch {
      camera = null;
    }
    return {
      camera,
      viewport: { width: innerWidth, height: innerHeight },
      canvas: q('[data-testid="map-view"] .maplibregl-canvas'),
      heat: q('.mapview__heat'),
      card: q('[data-testid="map-project-card"]'),
      open: q('[data-testid="map-project-open"]'),
      legend: q('[data-testid="map-legend"]'),
      locate: q('[data-testid="map-locate"]'),
      attribution: q('[data-testid="map-view"] .maplibregl-ctrl-attrib'),
      cardAttribution: q('[data-testid="map-card-attribution"]'),
      cardAttributionText:
        document.querySelector('[data-testid="map-card-attribution"]')?.textContent ?? '',
      targets: [
        '[data-testid="map-legend-toggle"]',
        '[data-testid="map-locate"]',
        '[data-testid="map-view"] .maplibregl-ctrl-attrib-button',
        '[data-testid="map-view"] .maplibregl-ctrl-group button',
        '[data-testid^="map-heat-"]',
      ].flatMap((selector) =>
        [...document.querySelectorAll(selector)].map((el) => ({ selector, box: box(el) })),
      ),
    };
  });
}

/** Where a point is drawn, from the remembered camera (Web Mercator, 512 px tiles). */
function onScreen(
  canvas: Box,
  camera: { lon: number; lat: number; zoom: number },
  p: ProjectPoint,
) {
  const world = 512 * 2 ** camera.zoom;
  const mx = (lon: number) => ((lon + 180) / 360) * world;
  const my = (lat: number) => {
    const s = Math.sin((lat * Math.PI) / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world;
  };
  return {
    x: canvas.left + canvas.width / 2 + mx(p.lon) - mx(camera.lon),
    y: canvas.top + canvas.height / 2 + my(p.lat) - my(camera.lat),
  };
}

const overlap = (a: Box | null, b: Box | null): boolean =>
  !!a &&
  !!b &&
  a.left < b.right - 0.5 &&
  b.left < a.right - 0.5 &&
  a.top < b.bottom - 0.5 &&
  b.top < a.bottom - 0.5;

/** Problems of the start fit: projects drawn outside the visible part of the map. */
async function startFitProblems(page: Page, projects: ProjectPoint[]): Promise<string[]> {
  const g = await mapGeometry(page);
  if (!g.camera || !g.canvas || !g.heat) return ['map not measured yet'];
  const top = Math.max(g.canvas.top, g.heat.bottom);
  return projects
    .map((p) => ({ p, at: onScreen(g.canvas!, g.camera!, p) }))
    .filter(
      ({ at }) =>
        at.x < g.canvas!.left + 2 ||
        at.x > g.canvas!.right - 2 ||
        at.y < top + 2 ||
        at.y > g.canvas!.bottom - 2,
    )
    .map(({ p, at }) => `${p.code} at ${Math.round(at.x)},${Math.round(at.y)}`);
}

/** Problems of the map controls on a phone: targets under 44 px, controls on the attribution. */
async function controlProblems(page: Page): Promise<string[]> {
  const g = await mapGeometry(page);
  const problems: string[] = [];
  for (const { selector, box } of g.targets) {
    if (box && (box.width < 43.5 || box.height < 43.5))
      problems.push(`${selector} ${Math.round(box.width)}×${Math.round(box.height)}`);
  }
  if (!g.attribution) problems.push('no attribution');
  if (overlap(g.attribution, g.legend)) problems.push('legend covers the attribution');
  if (overlap(g.attribution, g.locate)) problems.push('"my location" covers the attribution');
  if (overlap(g.legend, g.locate)) problems.push('legend and "my location" overlap');
  return problems;
}

/** Problems with the selected project's card: project hidden, action clipped, attribution covered. */
async function cardProblems(page: Page, project: ProjectPoint): Promise<string[]> {
  const g = await mapGeometry(page);
  if (!g.camera || !g.canvas || !g.heat || !g.card || !g.open) return ['card not measured yet'];
  const problems: string[] = [];
  if (Math.abs(g.camera.zoom - 16) > 0.05)
    problems.push(`camera still moving (zoom ${g.camera.zoom})`);
  const at = onScreen(g.canvas, g.camera, project);
  if (at.y <= g.heat.bottom || at.y >= g.card.top)
    problems.push(
      `project drawn at y=${Math.round(at.y)}, visible part ${Math.round(g.heat.bottom)}–${Math.round(g.card.top)}`,
    );
  if (at.x <= g.canvas.left || at.x >= g.canvas.right)
    problems.push(`project drawn at x=${Math.round(at.x)}`);
  if (g.open.bottom > g.card.bottom + 0.5 || g.open.top < g.card.top - 0.5)
    problems.push('"View details" clipped');
  if (g.card.bottom > g.canvas.bottom + 0.5) problems.push('card below the map');
  // Over the map's attribution control the card carries the attribution itself, readable.
  if (
    overlap(g.attribution, g.card) &&
    (!g.cardAttribution ||
      !/OpenStreetMap/.test(g.cardAttributionText) ||
      g.cardAttribution.bottom > g.card.bottom + 0.5)
  )
    problems.push('card covers the attribution and does not show it');
  // Legend and "my location" float above the card, beside the project — never on it.
  const dot = {
    left: at.x - 6,
    right: at.x + 6,
    top: at.y - 6,
    bottom: at.y + 6,
    width: 12,
    height: 12,
  };
  if (overlap(g.legend, g.card) || overlap(g.locate, g.card))
    problems.push('controls under the card');
  if (overlap(g.legend, dot) || overlap(g.locate, dot))
    problems.push('a control covers the project');
  return problems;
}

/** Elements of the map page sticking out of the screen (clipped controls). */
function overflowing(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const width = document.documentElement.clientWidth;
    for (const el of document.querySelectorAll<HTMLElement>(
      '[data-testid="map-page"] :is(button, input, select, label, a, [data-testid="projects-counter"])',
    )) {
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0 || el.closest('.mappage__map--hidden')) continue;
      if (b.left < -1 || b.right > width + 1)
        out.push(
          `${el.dataset.testid ?? el.tagName.toLowerCase()} ${Math.round(b.left)}–${Math.round(b.right)}`,
        );
    }
    if (document.documentElement.scrollWidth > width + 1)
      out.push(`page scrolls sideways (${document.documentElement.scrollWidth})`);
    return out;
  });
}

test('map: basemap, clusters, heat, locate, card, pick mode, packs, offline notice', async ({
  request,
}) => {
  test.setTimeout(8 * 60_000);
  const dir = newProfileDir('map');
  const context = await launchDevice(dir, { geolocation: HERE });
  try {
    const page = await firstPage(context);
    const seen = await observe(context, page);
    // Project tiles: the GETs only — a CORS preflight (OPTIONS 204) is answered even when the
    // GET after it is refused, and a refused GET never reaches 'response' (it is 'requestfailed').
    const tileStatuses: number[] = [];
    const tileFailures: string[] = [];
    let offlinePhase = false;
    context.on('response', (response) => {
      if (TILE_URL.test(response.url()) && response.request().method() === 'GET')
        tileStatuses.push(response.status());
    });
    context.on('requestfailed', (req) => {
      const error = req.failure()?.errorText ?? '';
      // MapLibre cancels the tiles it no longer needs while the map moves (ERR_ABORTED).
      if (offlinePhase || !TILE_URL.test(req.url()) || /ERR_ABORTED/.test(error)) return;
      tileFailures.push(`${req.method()} ${req.url()} ${error}`);
    });
    await signIn(page, request, 'collector.pemba@example.org');
    await waitFirstSync(page);

    // --- basemap + server clusters ------------------------------------------------------------
    await visible(page, 'nav-map').click();
    const view = page.getByTestId('map-view');
    await expect(view).toHaveAttribute('data-state', 'ready', { timeout: 45_000 });
    await expect(view).toHaveAttribute('data-basemap', /^(online|pack)$/, { timeout: 30_000 });
    await expect(page.getByTestId('map-legend')).toBeVisible();
    await expect.poll(() => tileStatuses.length, { timeout: 30_000 }).toBeGreaterThan(0);
    expect(
      tileStatuses.filter((s) => s !== 200 && s !== 204 && s !== 304),
      'project tile GETs answered 200 / 204 (empty) / 304',
    ).toEqual([]);
    expect(tileFailures, 'project tile requests that failed (CORS, network)').toEqual([]);

    // --- heat map toggle ----------------------------------------------------------------------
    const heat = page.getByTestId('map-heat-maintenance');
    await heat.click();
    await expect(heat).toHaveAttribute('aria-pressed', 'true');
    await heat.click();
    await expect(heat).toHaveAttribute('aria-pressed', 'false');

    // --- "my location" twice (one marker, moved in place: unit-tested in src/map/locate) ------
    await page.getByTestId('map-locate').click();
    await page.waitForTimeout(1_500);
    await page.getByTestId('map-locate').click();
    await page.waitForTimeout(1_500);
    await expect(view).toHaveAttribute('data-state', 'ready');

    // --- search → list row → fly to the project → card ---------------------------------------
    await page.getByTestId('search-input').fill('النور');
    const row = page.getByTestId('project-row').filter({ hasText: 'TZ-PN-000001' });
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    await row.click();
    const card = page.getByTestId('map-project-card');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText('TZ-PN-000001');
    await page.getByTestId('map-project-close').click();
    await expect(card).toHaveCount(0);
    await page.getByTestId('search-input').fill('');

    // --- pick mode from the project form fills the coordinates --------------------------------
    await visible(page, 'add-project').click();
    await expect(page.getByTestId('project-form')).toBeVisible();
    await page.getByTestId('form-pick-map').click();
    await expect(page.getByTestId('map-pick')).toBeVisible({ timeout: 30_000 });
    const pickView = page.getByTestId('map-pick-view');
    await expect(pickView).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
    await expect(page.getByTestId('map-pick-confirm')).toBeDisabled();
    const box = await pickView.boundingBox();
    expect(box).toBeTruthy();
    await page.mouse.click(box!.x + box!.width / 2 + 40, box!.y + box!.height / 2 + 20);
    await expect(page.getByTestId('map-pick-coords')).toContainText(/\d/);
    await page.getByTestId('map-pick-confirm').click();
    await expect(page.getByTestId('map-pick')).toHaveCount(0);
    expect(Number(await page.getByTestId('form-lat').inputValue())).not.toBeNaN();
    expect(Number(await page.getByTestId('form-lon').inputValue())).not.toBeNaN();
    expect(await page.getByTestId('form-lat').inputValue()).not.toBe('');
    // "Return without change" closes pick mode and keeps the form's point (v2 parity 1.8),
    // after a tap as well; Esc with nothing chosen closes it too.
    const picked = {
      lat: await page.getByTestId('form-lat').inputValue(),
      lon: await page.getByTestId('form-lon').inputValue(),
    };
    await page.getByTestId('form-pick-map').click();
    await expect(pickView).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
    const again = await pickView.boundingBox();
    await page.mouse.click(again!.x + again!.width / 2 - 60, again!.y + again!.height / 2 - 40);
    await expect(page.getByTestId('map-pick-confirm')).toBeEnabled();
    await page.getByTestId('map-pick-cancel').click();
    await expect(page.getByTestId('map-pick')).toHaveCount(0);
    await page.getByTestId('form-pick-map').click();
    await expect(page.getByTestId('map-pick')).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('map-pick')).toHaveCount(0);
    expect(await page.getByTestId('form-lat').inputValue()).toBe(picked.lat);
    expect(await page.getByTestId('form-lon').inputValue()).toBe(picked.lon);
    // Leave without saving (Esc / cancel ask first; the draft stays on this device).
    await page.getByTestId('form-cancel').click();
    // The picked point makes the draft worth keeping, so the form asks before leaving.
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('project-form')).toHaveCount(0);

    // --- the packs section in Settings --------------------------------------------------------
    await visible(page, 'nav-settings').click();
    const packs = page.getByTestId('settings-map-packs');
    await expect(packs).toBeVisible();
    await expect(
      packs.locator('[data-testid="map-packs-empty"], [data-testid^="map-pack-"]').first(),
    ).toBeVisible({ timeout: 15_000 });

    // --- offline: the map still opens, the basemap notice explains the missing background ----
    offlinePhase = true;
    await context.setOffline(true);
    await appNavigate(page, '/map');
    await expect(view).toHaveAttribute('data-state', 'ready', { timeout: 45_000 });
    const mbox = await view.boundingBox();
    await page.mouse.move(mbox!.x + mbox!.width / 2, mbox!.y + mbox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(mbox!.x + mbox!.width / 2 - 120, mbox!.y + mbox!.height / 2 - 60, {
      steps: 8,
    });
    await page.mouse.up();
    await expect(view).not.toHaveAttribute('data-basemap', 'online', { timeout: 15_000 });
    await context.setOffline(false);

    expect(unexpectedErrors(seen.consoleErrors), 'console errors').toEqual([]);
    expect(seen.cspViolations, 'CSP violations').toEqual([]);
    expect(seen.foreignRequests, 'requests outside the loopback').toEqual([]);
  } finally {
    await context.close().catch(() => undefined);
    removeProfile(dir);
  }
});

test('map on a phone: start fit, Swahili bar, 44 px controls, attribution, project card', async ({
  request,
}) => {
  test.setTimeout(8 * 60_000);
  const dir = newProfileDir('map-phone');
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 5'];
  const context = await chromium.launchPersistentContext(dir, {
    channel: 'chrome',
    headless: !process.env.E2E_HEADED,
    baseURL: BASE_URL,
    locale: 'en-US',
    serviceWorkers: 'allow',
    viewport,
    userAgent,
    deviceScaleFactor,
    isMobile,
    hasTouch,
    geolocation: HERE,
    permissions: ['geolocation'],
  });
  try {
    await context.grantPermissions(['geolocation'], { origin: BASE_URL });
    const page = await firstPage(context);
    const seen = await observe(context, page);
    await signIn(page, request, 'collector.pemba@example.org');
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await waitFirstSync(page);

    // --- the first map of the session shows the collector's projects (v2 parity 1.5) ----------
    // A fresh device opens the map before its first sync: the start fit waits for the projects.
    await visible(page, 'nav-map').click();
    const view = page.getByTestId('map-view');
    await expect(view).toHaveAttribute('data-state', 'ready', { timeout: 45_000 });
    const projects = await localProjectPoints(page);
    expect(projects.length, 'projects of the collector on the device').toBeGreaterThan(1);
    await expect
      .poll(() => startFitProblems(page, projects), { timeout: 30_000, message: 'start fit' })
      .toEqual([]);
    const target = projects.find((p) => p.code === 'TZ-PN-000001');
    expect(target, 'seeded project TZ-PN-000001 on the device').toBeTruthy();

    for (const lang of ['ar', 'sw'] as const) {
      await appNavigate(page, '/settings');
      await page.getByTestId(`lang-${lang}`).click();
      await page.waitForFunction((l) => document.documentElement.lang === l, lang);
      await appNavigate(page, '/map');
      await expect(view).toHaveAttribute('data-state', 'ready', { timeout: 45_000 });

      // --- the search and filter bar fits the screen (long Swahili labels) --------------------
      await expect
        .poll(() => overflowing(page), { message: `${lang}: clipped controls` })
        .toEqual([]);

      // --- 44 px touch targets; legend and "my location" keep clear of the attribution --------
      await expect
        .poll(() => controlProblems(page), { message: `${lang}: map controls` })
        .toEqual([]);

      // --- a project chosen from the list is drawn above its card; "View details" is whole ----
      await page.getByTestId('map-show-list').click();
      await page.getByTestId('search-input').fill('TZ-PN-000001');
      const row = page.getByTestId('project-row').filter({ hasText: 'TZ-PN-000001' });
      await expect(row).toHaveCount(1, { timeout: 15_000 });
      await row.click();
      await expect(page.getByTestId('map-project-card')).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(() => cardProblems(page, target!), { timeout: 20_000, message: `${lang}: card` })
        .toEqual([]);
      await expect
        .poll(() => controlProblems(page), { message: `${lang}: controls with the card` })
        .toEqual([]);
      await page.getByTestId('map-project-close').click();
      await expect(page.getByTestId('map-project-card')).toHaveCount(0);
      await page.getByTestId('search-input').fill('');
    }

    expect(unexpectedErrors(seen.consoleErrors), 'console errors').toEqual([]);
    expect(seen.cspViolations, 'CSP violations').toEqual([]);
    expect(seen.foreignRequests, 'requests outside the loopback').toEqual([]);
  } finally {
    await context.close().catch(() => undefined);
    removeProfile(dir);
  }
});

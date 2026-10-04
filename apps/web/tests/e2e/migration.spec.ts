/**
 * Acceptance criterion 6 of the brief (§14.6, §10) — v2 → v3 migration:
 *
 *   A. a device that ran v2: before the app loads, localStorage holds `istiqama-projects-v2`
 *      (v2's five sample projects, a staff list with a salary, a data-URL photo, a legacy
 *      `photo`, an external photo URL that must be rejected) and `istiqama-people-v1`;
 *      collector.pemba signs in, accepts the offer (`v2-migrate-accept`), sees the summary,
 *      starts the upload and waits for the sync. Checked on the server with the service role:
 *      every project exists as a DRAFT of that user with its staff / persons / photos /
 *      maintenance / donor, the v2 entry time is kept, persons are new (no merging), and the
 *      two v2 keys are gone from the device.
 *   B. a v2 backup file (JSON) chosen in `v2-import-file`: a broken file is refused, the real
 *      file is migrated as drafts.
 *
 * The offer is the shell's first-run prompt; while the shell does not mount it yet the test
 * uses the same panel on the import page (annotated in the report).
 *
 * Clean-up: the migrated projects and the persons created for them are soft-deleted
 * (service role). Every run uses its own v2 ids, so runs never collide.
 */
import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import {
  appNavigate,
  observe,
  runTag,
  SCREENS_DIR,
  serviceSelect,
  signIn,
  softDeleteRows,
  unexpectedErrors,
  userIdOf,
  visible,
  waitFirstSync,
} from './helpers';

const EMAIL = 'collector.pemba@example.org';
const PROJECTS_KEY = 'istiqama-projects-v2';
const PEOPLE_KEY = 'istiqama-people-v1';

// ---------------------------------------------------------------------------------------------
// v2 data
// ---------------------------------------------------------------------------------------------

/** A small RGB PNG as v2 stored photos: `data:image/png;base64,…`. */
function pngDataUrl(width: number, height: number, rgb: [number, number, number]): string {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const stripe = y > height * 0.7;
      raw[row + 1 + x * 3] = stripe ? 255 : rgb[0];
      raw[row + 2 + x * 3] = stripe ? 255 : rgb[1];
      raw[row + 3 + x * 3] = stripe ? 255 : rgb[2];
    }
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

/** reference/v2/src/app.js SAMPLE_PROJECTS (ids made unique per run). */
function sampleProjects(tag: string): Array<Record<string, unknown>> {
  const id = (n: number) => `e2e-${tag}-demo-${n}`;
  return [
    {
      id: id(1),
      name: 'مسجد النور',
      type: 'mosque',
      country: 'تنزانيا',
      region: 'بيمبا',
      locality: 'ويتي',
      lat: -5.055,
      lng: 39.729,
      capacity: 350,
      status: 'active',
      manager: 'عبدالله سالم',
      phone: '',
      builder: 'الاستقامة',
      donor: '',
      buildDate: '2019-01-01',
      maintenanceNotes: '',
      createdBy: 'المشرف العام',
    },
    {
      id: id(2),
      name: 'مدرسة الفلاح للقرآن',
      type: 'school',
      country: 'تنزانيا',
      region: 'بيمبا',
      locality: 'ويتي',
      lat: -5.066,
      lng: 39.714,
      capacity: 120,
      status: 'active',
      manager: 'محمد علي',
      phone: '',
      builder: 'الاستقامة',
      donor: 'متبرع كريم',
      buildDate: '2021-01-01',
      maintenanceNotes: '',
      createdBy: 'المشرف العام',
    },
    {
      id: id(3),
      name: 'مسجد ومدرسة الرحمة',
      type: 'combined',
      country: 'تنزانيا',
      region: 'بيمبا',
      locality: 'مكواني',
      lat: -5.357,
      lng: 39.648,
      capacity: 280,
      status: 'active',
      manager: 'خالد حسن',
      phone: '',
      builder: 'الاستقامة',
      donor: '',
      buildDate: '2020-01-01',
      maintenanceNotes: '',
      createdBy: 'المشرف العام',
    },
    {
      id: id(4),
      name: 'مسجد الهدى',
      type: 'mosque',
      country: 'تنزانيا',
      region: 'زنجبار',
      locality: 'مدينة زنجبار',
      lat: -6.165,
      lng: 39.199,
      capacity: 420,
      status: 'maintenance',
      manager: 'سعيد عمر',
      phone: '',
      builder: 'الاستقامة',
      donor: '',
      buildDate: '2017-01-01',
      maintenanceNotes: 'مثال تجريبي: يحتاج إلى فحص وصيانة السقف.',
      createdBy: 'المشرف العام',
    },
    {
      id: id(5),
      name: 'مدرسة البيان',
      type: 'school',
      country: 'تنزانيا',
      region: 'بيمبا',
      locality: 'مكواني',
      lat: -5.37,
      lng: 39.66,
      capacity: 85,
      status: 'building',
      manager: 'يوسف عبدالله',
      phone: '',
      builder: 'الاستقامة',
      donor: 'متبرع كريم',
      buildDate: '2023-01-01',
      maintenanceNotes: '',
      createdBy: 'المشرف العام',
    },
  ];
}

interface V2Set {
  projects: Array<Record<string, unknown>>;
  people: Array<Record<string, unknown>>;
  imam: string;
  teacher: string;
}

function v2DataSet(tag: string): V2Set {
  const imam = `إمام الاختبار ${tag}`;
  const teacher = `معلمة الاختبار ${tag}`;
  const projects = sampleProjects(tag);
  // A v2 device that was used: staff, photos (one rejected), the legacy photo, entry times.
  Object.assign(projects[0]!, {
    createdAt: '2025-03-01T08:00:00.000Z',
    updatedAt: '2025-04-01T08:00:00.000Z',
    staff: [
      {
        name: imam,
        role: 'imam',
        birthDate: '1980-05-01',
        region: 'ويتي',
        education: 'ثانوي',
        graduationInstitution: 'معهد ويتي',
        salary: 150000,
      },
      { name: teacher, role: 'teacher', salary: 0 },
    ],
    photos: [
      {
        id: 'ph-1',
        data: pngDataUrl(64, 48, [15, 37, 69]),
        category: 'mosque_front',
        caption: 'الواجهة',
        source: 'gallery',
      },
      { id: 'ph-2', data: 'https://tracker.invalid/pixel.png', category: 'land', caption: '' },
    ],
    land: {
      ownership: 'waqf',
      ownerName: '',
      area: '900',
      utilization: '60',
      expandable: 'yes',
      notes: '',
    },
    facilities: {
      teacherHousing: 'no',
      imamHousing: 'yes',
      library: 'no',
      quranCount: '40',
      quranNeed: '60',
    },
    community: {
      livelihoods: ['الصيد', 'تربية النحل'],
      population: '1200',
      muslimPercentage: '95',
    },
  });
  Object.assign(projects[2]!, { photo: pngDataUrl(48, 48, [200, 162, 74]) });
  const people = [
    { id: 'p-1', name: imam, normalizedName: imam, roles: ['imam'], phone: '', education: 'ثانوي' },
    { id: 'p-2', name: 'عبدالله سالم', normalizedName: 'عبدالله سالم', roles: ['manager'] },
  ];
  return { projects, people, imam, teacher };
}

// ---------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------

/** The offer: the shell's first-run prompt, or the same panel on the import page. */
async function openOffer(page: Page): Promise<'prompt' | 'import-page'> {
  const prompt = page.getByTestId('v2-migrate-prompt');
  try {
    await expect(prompt).toBeVisible({ timeout: 8_000 });
    return 'prompt';
  } catch {
    await appNavigate(page, '/import');
    await expect(page.getByTestId('import-v2')).toBeVisible({ timeout: 30_000 });
    return 'import-page';
  }
}

/** Screenshots for the lead and the user guide (git-ignored folder). */
async function shot(page: Page, name: string): Promise<void> {
  await page
    .screenshot({ path: `${SCREENS_DIR}/${name}.png`, fullPage: true })
    .catch(() => undefined);
}

/** Summary → start → report, then waits until the upload is confirmed (sync now if needed). */
async function runToReport(page: Page, expectedProjects: number, label: string): Promise<void> {
  const summary = page.getByTestId('v2-migrate-summary');
  await expect(summary).toBeVisible({ timeout: 90_000 });
  await expect(
    summary.getByTestId('v2-migrate-counts').locator('[data-count="projects"] dd'),
  ).toHaveText(String(expectedProjects));
  await shot(page, `migration-${label}-summary`);
  await page.getByTestId('v2-migrate-start').click();
  const report = page.getByTestId('v2-migrate-report');
  await expect(report).toBeVisible({ timeout: 180_000 });
  await expect
    .poll(
      async () => {
        const pushed = await report.getAttribute('data-pushed');
        if (pushed !== 'true') {
          const sync = page.getByTestId('v2-migrate-sync');
          if (await sync.isEnabled().catch(() => false)) await sync.click().catch(() => undefined);
        }
        return pushed;
      },
      { timeout: 180_000, intervals: [2_000, 3_000, 5_000] },
    )
    .toBe('true');
  await expect(page.getByTestId('v2-migrate-saved')).toHaveText(String(expectedProjects));
  await shot(page, `migration-${label}-report`);
}

interface ServerProject {
  id: string;
  external_id: string;
  record_state: string;
  created_by: string;
  created_at: string;
  name_ar: string;
  type: string;
  status: string;
  capacity: number | null;
  location_source: string | null;
  build_year: number | null;
  branch_id: string | null;
  deleted_at: string | null;
}

async function serverProjects(
  request: Parameters<typeof serviceSelect>[0],
  keys: string[],
): Promise<ServerProject[]> {
  const list = keys.map((k) => `"${k}"`).join(',');
  return serviceSelect<ServerProject>(
    request,
    `projects?select=id,external_id,record_state,created_by,created_at,name_ar,type,status,capacity,location_source,build_year,branch_id,deleted_at&external_id=in.(${encodeURIComponent(list)})`,
  );
}

async function cleanUp(
  request: Parameters<typeof serviceSelect>[0],
  keys: string[],
): Promise<void> {
  const projects = await serverProjects(request, keys).catch(() => [] as ServerProject[]);
  const ids = projects.map((p) => p.id);
  if (ids.length === 0) return;
  const staff = await serviceSelect<{ person_id: string }>(
    request,
    `project_staff?select=person_id&project_id=in.(${ids.join(',')})`,
  ).catch(() => []);
  const localityIds = await serviceSelect<{ locality_id: string | null }>(
    request,
    `projects?select=locality_id&id=in.(${ids.join(',')})`,
  )
    .then((rows) => [...new Set(rows.map((r) => r.locality_id).filter((x): x is string => !!x))])
    .catch(() => [] as string[]);
  await softDeleteRows(request, 'projects', 'id', ids).catch(() => 0);
  await softDeleteRows(request, 'persons', 'id', [...new Set(staff.map((s) => s.person_id))]).catch(
    () => 0,
  );
  // Villages the run proposed (never the approved ones of the seed) once nothing uses them.
  if (localityIds.length > 0) {
    const proposed = await serviceSelect<{ id: string }>(
      request,
      `localities?select=id&status=eq.proposed&deleted_at=is.null&id=in.(${localityIds.join(',')})`,
    ).catch(() => []);
    for (const { id } of proposed) {
      const users = await serviceSelect<{ id: string }>(
        request,
        `projects?select=id&locality_id=eq.${id}&deleted_at=is.null&limit=1`,
      ).catch(() => [{ id: 'unknown' }]);
      if (users.length === 0)
        await softDeleteRows(request, 'localities', 'id', [id]).catch(() => 0);
    }
  }
}

// ---------------------------------------------------------------------------------------------

test.describe.configure({ mode: 'serial' });

test('criterion 6A: the v2 data of this device becomes drafts; the old keys go after the upload', async ({
  page,
  context,
  request,
}, testInfo) => {
  test.setTimeout(10 * 60_000);
  const tag = runTag();
  const data = v2DataSet(tag);
  const keys = data.projects.map((p) => `v2:${String(p.id)}`);
  const userId = await userIdOf(request, EMAIL);

  // The v2 keys exist BEFORE the app loads (once: the marker stops the re-seeding on reloads).
  await context.addInitScript(
    ({ projects, people, pk, ppk }) => {
      if (localStorage.getItem('e2e.v2.seeded')) return;
      localStorage.setItem(pk, JSON.stringify(projects));
      localStorage.setItem(ppk, JSON.stringify(people));
      localStorage.setItem('e2e.v2.seeded', '1');
    },
    { projects: data.projects, people: data.people, pk: PROJECTS_KEY, ppk: PEOPLE_KEY },
  );
  const seen = await observe(context, page);

  try {
    await signIn(page, request, EMAIL);
    await waitFirstSync(page);
    expect(await page.evaluate((k) => localStorage.getItem(k) !== null, PROJECTS_KEY)).toBe(true);

    const where = await openOffer(page);
    testInfo.annotations.push({ type: 'offer', description: where });
    await expect(
      page.getByTestId('v2-local-offer').or(page.getByTestId('v2-migrate-prompt')).first(),
    ).toContainText('5');
    await shot(page, 'migration-local-offer');
    await visible(page, 'v2-migrate-accept').click();
    await runToReport(page, 5, 'local');

    // The v2 keys are removed only now (everything acknowledged by the server).
    await expect
      .poll(() =>
        page.evaluate(
          ([a, b]) => [localStorage.getItem(a!), localStorage.getItem(b!)],
          [PROJECTS_KEY, PEOPLE_KEY],
        ),
      )
      .toEqual([null, null]);
    await expect(page.getByTestId('v2-migrate-report')).toHaveAttribute(
      'data-keys-removed',
      'true',
    );

    // --- server: every project is a draft of this user --------------------------------------
    const projects = await serverProjects(request, keys);
    expect(projects.map((p) => p.external_id).sort()).toEqual([...keys].sort());
    for (const p of projects) {
      expect(p.record_state, p.external_id).toBe('draft');
      expect(p.created_by, p.external_id).toBe(userId);
      expect(p.deleted_at).toBeNull();
      expect(p.location_source).toBe('import');
      expect(p.branch_id).not.toBeNull();
    }
    const byKey = new Map(projects.map((p) => [p.external_id, p]));
    const p1 = byKey.get(keys[0]!)!;
    expect(p1).toMatchObject({
      name_ar: 'مسجد النور',
      type: 'mosque',
      status: 'active',
      capacity: 350,
      build_year: 2019,
    });
    expect(new Date(p1.created_at).toISOString()).toBe('2025-03-01T08:00:00.000Z'); // v2 entry time
    expect(byKey.get(keys[3]!)!.status).toBe('maintenance');
    const ids = projects.map((p) => p.id);

    // --- staff and persons (new persons, roles kept, never merged) -------------------------
    const staff = await serviceSelect<{ project_id: string; person_id: string; role: string }>(
      request,
      `project_staff?select=project_id,person_id,role&deleted_at=is.null&project_id=in.(${ids.join(',')})`,
    );
    const rolesOf = (id: string) =>
      staff
        .filter((s) => s.project_id === id)
        .map((s) => s.role)
        .sort();
    expect(rolesOf(p1.id)).toEqual(['imam', 'manager', 'teacher']);
    for (const p of projects.filter((x) => x.id !== p1.id))
      expect(rolesOf(p.id)).toEqual(['manager']);
    const personIds = [...new Set(staff.map((s) => s.person_id))];
    const persons = await serviceSelect<{
      id: string;
      name_ar: string;
      created_by: string;
      birth_year: number | null;
      created_at: string;
    }>(
      request,
      `persons?select=id,name_ar,created_by,birth_year,created_at&id=in.(${personIds.join(',')})`,
    );
    expect(persons).toHaveLength(personIds.length);
    expect(persons.every((p) => p.created_by === userId)).toBe(true);
    const imam = persons.find((p) => p.name_ar === data.imam);
    expect(imam?.birth_year).toBe(1980);
    expect(persons.some((p) => p.name_ar === data.teacher)).toBe(true);
    // "عبدالله سالم" already exists in the staging seed: the migration created a NEW person.
    const seeded = await serviceSelect<{ id: string }>(
      request,
      `persons?select=id&name_ar=eq.${encodeURIComponent('عبدالله سالم')}&created_by=neq.${userId}`,
    );
    const migratedManager = persons.find((p) => p.name_ar === 'عبدالله سالم');
    expect(migratedManager).toBeTruthy();
    expect(seeded.map((s) => s.id)).not.toContain(migratedManager!.id);

    // --- photos: the data-URL photo and the legacy photo; the external URL was rejected ----
    const photos = await serviceSelect<{
      project_id: string;
      category: string;
      caption: string | null;
    }>(
      request,
      `project_photos?select=project_id,category,caption&deleted_at=is.null&project_id=in.(${ids.join(',')})`,
    );
    expect(photos.filter((p) => p.project_id === p1.id)).toEqual([
      expect.objectContaining({ category: 'mosque_front', caption: 'الواجهة' }),
    ]);
    expect(photos.filter((p) => p.project_id === byKey.get(keys[2]!)!.id)).toHaveLength(1);
    expect(photos).toHaveLength(2);

    // --- maintenance notes, donor, land / facilities / community ----------------------------
    const maintenance = await serviceSelect<{
      project_id: string;
      state: string;
      description: string;
    }>(
      request,
      `project_maintenance?select=project_id,state,description&deleted_at=is.null&project_id=in.(${ids.join(',')})`,
    );
    expect(maintenance).toEqual([
      {
        project_id: byKey.get(keys[3]!)!.id,
        state: 'open',
        description: 'مثال تجريبي: يحتاج إلى فحص وصيانة السقف.',
      },
    ]);
    const links = await serviceSelect<{ project_id: string; donor_id: string }>(
      request,
      `project_donors?select=project_id,donor_id&deleted_at=is.null&project_id=in.(${ids.join(',')})`,
    );
    expect(links.map((l) => l.project_id).sort()).toEqual(
      [byKey.get(keys[1]!)!.id, byKey.get(keys[4]!)!.id].sort(),
    );
    expect(new Set(links.map((l) => l.donor_id)).size).toBe(1);
    const land = await serviceSelect<{ ownership: string; area_m2: number; expandable: boolean }>(
      request,
      `project_land?select=ownership,area_m2,expandable&project_id=eq.${p1.id}&deleted_at=is.null`,
    );
    expect(land).toEqual([{ ownership: 'waqf', area_m2: 900, expandable: true }]);
    const community = await serviceSelect<{
      population: number;
      livelihoods: string[];
      livelihoods_other: string | null;
    }>(
      request,
      `community_profiles?select=population,livelihoods,livelihoods_other&project_id=eq.${p1.id}&deleted_at=is.null`,
    );
    expect(community[0]?.population).toBe(1200);
    expect(community[0]?.livelihoods.length).toBeGreaterThanOrEqual(1);
    expect(community[0]?.livelihoods_other).toContain('تربية النحل');

    expect(unexpectedErrors(seen.consoleErrors), 'console errors').toEqual([]);
    expect(seen.cspViolations).toEqual([]);
    expect(seen.foreignRequests.filter((u) => !u.includes('tracker.invalid'))).toEqual([]);
  } finally {
    await cleanUp(request, keys);
  }
});

test('criterion 6B: a v2 backup file (JSON) is migrated as drafts; a broken file is refused', async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(8 * 60_000);
  const tag = runTag();
  const projects = sampleProjects(tag).slice(0, 2);
  Object.assign(projects[0]!, {
    staff: [{ name: `وكيل الاختبار ${tag}`, role: 'agent', salary: 0 }],
    photos: [
      {
        id: 'f-1',
        data: pngDataUrl(40, 30, [31, 122, 77]),
        category: 'facilities',
        caption: 'المرافق',
      },
    ],
  });
  const keys = projects.map((p) => `v2:${String(p.id)}`);
  const userId = await userIdOf(request, EMAIL);
  const seen = await observe(context, page);

  try {
    await signIn(page, request, EMAIL);
    await waitFirstSync(page);
    await appNavigate(page, '/import');
    const input = page.getByTestId('v2-import-file');
    await expect(input).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('import-history')).toBeVisible();
    await shot(page, 'import-page');
    const size = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, 'import-page-phone');
    if (size) await page.setViewportSize(size);

    // A truncated file: refused inline, nothing opens.
    await input.setInputFiles({
      name: 'istiqama-backup-broken.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(projects).slice(0, 80), 'utf8'),
    });
    await expect(page.getByTestId('v2-import-file-error')).toBeVisible();
    await expect(page.getByTestId('v2-migrate-dialog')).toHaveCount(0);

    // The real v2 backup ("نسخة احتياطية" = JSON.stringify(projects, null, 2)).
    await input.setInputFiles({
      name: `istiqama-backup-${tag}.json`,
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(projects, null, 2), 'utf8'),
    });
    await runToReport(page, 2, 'file');

    const rows = await serverProjects(request, keys);
    expect(rows.map((p) => p.external_id).sort()).toEqual([...keys].sort());
    expect(rows.every((p) => p.record_state === 'draft' && p.created_by === userId)).toBe(true);
    const first = rows.find((p) => p.external_id === keys[0])!;
    const staff = await serviceSelect<{ role: string }>(
      request,
      `project_staff?select=role&deleted_at=is.null&project_id=eq.${first.id}`,
    );
    expect(staff.map((s) => s.role).sort()).toEqual(['agent', 'manager']);
    const photos = await serviceSelect<{ category: string }>(
      request,
      `project_photos?select=category&deleted_at=is.null&project_id=eq.${first.id}`,
    );
    expect(photos).toEqual([{ category: 'facilities' }]);

    // The same file again: nothing new (idempotent by external_id).
    await page.getByTestId('v2-migrate-close').click();
    await input.setInputFiles({
      name: `istiqama-backup-${tag}.json`,
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(projects, null, 2), 'utf8'),
    });
    await expect(page.getByTestId('v2-migrate-summary')).toBeVisible({ timeout: 90_000 });
    await expect(
      page.getByTestId('v2-migrate-counts').locator('[data-count="projects"] dd'),
    ).toHaveText('0');
    await page.getByTestId('v2-migrate-cancel').click();
    expect(await serverProjects(request, keys)).toHaveLength(2);

    expect(unexpectedErrors(seen.consoleErrors), 'console errors').toEqual([]);
    expect(seen.cspViolations).toEqual([]);
  } finally {
    await cleanUp(request, keys);
  }
});

test('bulk import (brief §10): upload → review → commit as a merge → rollback', async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(8 * 60_000);
  const tag = runTag();
  const externalId = `e2e-imp-${tag}`;
  const name = `مسجد الاستيراد ${tag}`;
  // A point inside Pemba, away from the seeded projects (jittered per run).
  const jitter = (parseInt(tag.slice(0, 3), 36) % 50) / 10_000;
  const lat = (-5.15 - jitter).toFixed(5);
  const lon = (39.77 + jitter).toFixed(5);
  const csv =
    'external_id,name_ar,type,status,capacity,lat,lon,country,maintenance_note\n' +
    `${externalId},${name},mosque,active,150,${lat},${lon},TZ,سقف يحتاج إصلاحًا\n` +
    ',,bogus,,abc,abc,39.7,TZ,\n' +
    ',مسجد النور,mosque,active,,-5.055,39.729,TZ,\n';
  const userId = await userIdOf(request, EMAIL);
  const seen = await observe(context, page);

  try {
    await signIn(page, request, EMAIL);
    await waitFirstSync(page);
    await appNavigate(page, '/import');
    await expect(page.getByTestId('import-upload')).toBeVisible({ timeout: 30_000 });

    // The official template downloads (CSV with a BOM).
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('import-template-csv').click(),
    ]);
    const template = await download.createReadStream().then(async (s) => {
      const parts: Buffer[] = [];
      for await (const chunk of s) parts.push(chunk as Buffer);
      return Buffer.concat(parts);
    });
    expect([...template.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);

    // Upload → the server parses and validates; nothing is written yet.
    await page.getByTestId('import-file').setInputFiles({
      name: `istiqama-import-${tag}.csv`,
      mimeType: 'text/csv',
      buffer: Buffer.from(csv, 'utf8'),
    });
    await page.getByTestId('import-upload-submit').click();
    const preview = page.getByTestId('import-preview');
    await expect(preview).toBeVisible({ timeout: 60_000 });
    await expect(preview.getByTestId('import-count-valid')).toHaveText('1');
    await expect(preview.getByTestId('import-count-invalid')).toHaveText('1');
    await expect(preview.getByTestId('import-count-duplicate')).toHaveText('1');
    const rows = preview.getByTestId('import-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(1)).toHaveAttribute('data-state', 'invalid');
    await expect(rows.nth(1).getByTestId('import-error').first()).toBeVisible();
    await expect(rows.nth(2)).toHaveAttribute('data-state', 'duplicate');
    await expect(rows.nth(2)).toHaveAttribute('data-action', 'skip');
    await expect(rows.nth(2).getByTestId('import-candidate').first()).toContainText('TZ-PN-000001');
    expect(await serviceSelect(request, `projects?select=id&external_id=eq.${externalId}`)).toEqual(
      [],
    );
    await shot(page, 'import-preview');

    // Commit (create 1, skip the duplicate, leave the invalid row out).
    await page.getByTestId('import-commit').click();
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('import-done')).toBeVisible({ timeout: 60_000 });
    const created = await serviceSelect<{
      id: string;
      record_state: string;
      location_source: string;
      created_by: string;
      capacity: number;
    }>(
      request,
      `projects?select=id,record_state,location_source,created_by,capacity&external_id=eq.${externalId}&deleted_at=is.null`,
    );
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      record_state: 'draft',
      location_source: 'import',
      created_by: userId,
      capacity: 150,
    });
    const maintenance = await serviceSelect<{ description: string }>(
      request,
      `project_maintenance?select=description&project_id=eq.${created[0]!.id}&deleted_at=is.null`,
    );
    expect(maintenance).toEqual([{ description: 'سقف يحتاج إصلاحًا' }]);

    // History → rollback: the draft created by the batch is removed again.
    const batch = page
      .getByTestId('import-batch')
      .filter({ hasText: `istiqama-import-${tag}.csv` });
    await expect(batch).toHaveAttribute('data-state', 'committed', { timeout: 30_000 });
    await batch.getByTestId('import-batch-rollback').click();
    await page.getByTestId('confirm-ok').click();
    await expect(batch.getByTestId('import-rollback-result')).toBeVisible({ timeout: 60_000 });
    await expect(batch).toHaveAttribute('data-state', 'rolled_back');
    const after = await serviceSelect<{ deleted_at: string | null }>(
      request,
      `projects?select=deleted_at&id=eq.${created[0]!.id}`,
    );
    expect(after[0]?.deleted_at).toBeTruthy();

    expect(unexpectedErrors(seen.consoleErrors), 'console errors').toEqual([]);
    expect(seen.cspViolations).toEqual([]);
  } finally {
    const left = await serviceSelect<{ id: string }>(
      request,
      `projects?select=id&external_id=eq.${externalId}&deleted_at=is.null`,
    ).catch(() => []);
    await softDeleteRows(
      request,
      'projects',
      'id',
      left.map((p) => p.id),
    ).catch(() => 0);
  }
});

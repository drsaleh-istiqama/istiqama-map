import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  pick: vi.fn(),
  save: vi.fn(async (_bundle: unknown) => undefined),
  queue: vi.fn(async (_rows: unknown) => undefined),
  editor: null as unknown,
}));

vi.mock('../../auth', async () => {
  const { signal } = await import('@preact/signals');
  return {
    me: signal({
      user_id: 'u1',
      profile: { full_name: 'Amina' },
      scopes: { write: { branches: [], countries: [] } },
    }),
    session: signal({ user: { id: 'u1' } }),
    can: {
      write: signal(true),
      review: signal(false),
      seeRestricted: signal(false),
      seePeople: signal(true),
      admin: signal(false),
    },
    supabase: { from: () => ({ select: () => ({ eq: async () => ({ data: [], error: null }) }) }) },
  };
});

vi.mock('../../sync', async () => {
  const { signal } = await import('@preact/signals');
  return {
    transport: { rpc: mocks.rpc },
    syncStatus: signal({
      online: true,
      state: 'idle',
      pendingOps: 0,
      pendingPhotos: 0,
      failedOps: 0,
      lastSyncAt: null,
      lastError: null,
    }),
    syncNow: vi.fn(async () => undefined),
  };
});

vi.mock('./peers', () => ({
  loadPhotoEditor: async () => mocks.editor,
  loadPersonPicker: async () => null,
  loadPickLocation: async () => mocks.pick,
  queuePhotoUploads: mocks.queue,
  discardStagedPhotos: async () => undefined,
}));

vi.mock('../../db', async (original) => ({
  ...((await original()) as Record<string, unknown>),
  saveProjectBundle: mocks.save,
}));

import { db, drafts, newRow, type ProjectBundle, type Row } from '../../db';
import { fmt, t } from '../../i18n';
import { projectCompleteness } from '../../lib/completeness';
import { gridCell } from '../../lib/geo';
import type { FormAccess } from './access';
import { putCachedShapes, resetShapeMemory, toCachedShapes } from './geoCache';
import { draftKey, newDraft, type FormDraft } from './model';
import { previewBundle, ProjectForm } from './ProjectForm';
import { listLocalities, LOCALITY_SCAN_LIMIT } from './queries';

const TZ = '01900000-0000-7000-8000-00000000c0tz'.replace('c0tz', '00a1');
const R1 = '01900000-0000-7000-8000-0000000000r1'.replace('r1', 'b1');
const R2 = '01900000-0000-7000-8000-0000000000r2'.replace('r2', 'b2');
const D1 = '01900000-0000-7000-8000-0000000000d1'.replace('d1', 'c1');

const ACCESS: FormAccess = {
  userId: 'u1',
  fullName: 'Amina',
  write: true,
  review: false,
  restrictedWrite: true,
  restrictedRead: false,
  branches: [],
  countries: [],
};

const sq = (x0: number, y0: number, x1: number, y1: number) => ({
  type: 'MultiPolygon' as const,
  coordinates: [
    [
      [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
        [x0, y0],
      ],
    ],
  ],
});

let online = false;

async function seed(): Promise<void> {
  await db.countries.put(
    newRow('countries', {
      iso2: 'TZ',
      name_ar: 'تنزانيا',
      name_en: 'Tanzania',
      active: true,
      default_currency: 'TZS',
      id: TZ,
    } as Partial<Row<'countries'>>),
  );
  await db.admin_areas.bulkPut([
    newRow('admin_areas', {
      id: R1,
      country_id: TZ,
      level: 1,
      code: 'R1',
      name_ar: 'بيمبا الشمالية',
      name_en: 'North Pemba',
    } as Partial<Row<'admin_areas'>>),
    newRow('admin_areas', {
      id: R2,
      country_id: TZ,
      level: 1,
      code: 'R2',
      name_ar: 'تانغا',
      name_en: 'Tanga',
    } as Partial<Row<'admin_areas'>>),
    newRow('admin_areas', {
      id: D1,
      country_id: TZ,
      level: 2,
      code: 'D1',
      parent_id: R1,
      name_en: 'Wete',
    } as Partial<Row<'admin_areas'>>),
  ]);
  await putCachedShapes(
    toCachedShapes(TZ, 1, {
      features: [
        { geometry: sq(39, -6, 40, -5), properties: { id: R1, parent_id: null, level: 1 } },
        { geometry: sq(40, -6, 41, -5), properties: { id: R2, parent_id: null, level: 1 } },
      ],
    }),
  );
  await putCachedShapes(
    toCachedShapes(TZ, 2, {
      features: [
        { geometry: sq(39, -6, 39.5, -5.5), properties: { id: D1, parent_id: R1, level: 2 } },
      ],
    }),
  );
}

function setup(opts: { access?: Partial<FormAccess>; draft?: FormDraft } = {}) {
  const onSaved = vi.fn();
  const onLeave = vi.fn();
  const onOpenProject = vi.fn();
  const draft = opts.draft ?? newDraft({ userId: 'u1', countryId: TZ });
  render(
    <ProjectForm
      initial={draft}
      access={{ ...ACCESS, ...opts.access }}
      onSaved={onSaved}
      onLeave={onLeave}
      onOpenProject={onOpenProject}
    />,
  );
  return { draft, onSaved, onLeave, onOpenProject };
}

const input = (testId: string, value: string): void => {
  fireEvent.input(screen.getByTestId(testId), { target: { value } });
};
const choose = (testId: string, value: string): void => {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
};

/** Type, name and a point inside region R1 / district D1, then wait for the offline geofill. */
async function fillEssentials(): Promise<void> {
  fireEvent.click(screen.getByTestId('form-type-mosque'));
  input('form-name', 'مسجد النور');
  input('form-lat', '-5.8');
  input('form-lon', '39.2');
  await waitFor(
    () => expect((screen.getByTestId('form-area') as HTMLSelectElement).value).toBe(R1),
    { timeout: 3000 },
  );
}

beforeEach(async () => {
  online = false;
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
  mocks.rpc.mockReset();
  mocks.rpc.mockImplementation(async (fn: string) => {
    if (fn === 'project_duplicates') return [];
    if (fn === 'admin_area_shapes') return { features: [] };
    throw new Error(`unexpected rpc ${fn}`);
  });
  mocks.save.mockClear();
  mocks.queue.mockClear();
  mocks.editor = null;
  mocks.pick.mockReset();
  resetShapeMemory();
  await Promise.all(db.tables.map((table) => table.clear()));
  await seed();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('ProjectForm — order and folding (brief §7.1)', () => {
  it('shows type → name → location → country/area → status → photos, then folded optional sections', async () => {
    setup();
    const order = [
      'form-type-mosque',
      'form-name',
      'form-gps',
      'form-lat',
      'form-country',
      'form-status',
      'form-photos-unavailable',
      'form-section-basics',
      'form-section-donors',
      'form-section-staff',
      'form-section-land',
      'form-section-facilities',
      'form-section-community',
      'form-section-sensitive',
      'form-completeness',
      'form-save',
    ];
    await screen.findByTestId('form-photos-unavailable');
    const els = order.map((id) => screen.getByTestId(id));
    for (let i = 1; i < els.length; i++) {
      expect(
        els[i - 1]!.compareDocumentPosition(els[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    for (const key of ['basics', 'donors', 'staff', 'land', 'facilities', 'community']) {
      expect(screen.getByTestId(`form-section-${key}`).getAttribute('aria-expanded')).toBe('false');
    }
    expect(screen.queryByTestId('form-capacity')).toBeNull(); // folded sections render nothing
    fireEvent.click(screen.getByTestId('form-section-basics'));
    expect(await screen.findByTestId('form-capacity')).toBeTruthy();
    expect((screen.getByTestId('form-builder') as HTMLInputElement).value).toBe('الاستقامة');
  });

  it('shows who enters the record (signed-in user)', () => {
    setup();
    expect(screen.getByTestId('form-entered-by').textContent).toBe(
      t('form.enteredBy', { name: 'Amina' }),
    );
  });
});

describe('location', () => {
  it('shows the GPS accuracy in metres and warns above 30 m', async () => {
    let accuracy = 45;
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        watchPosition: (ok: PositionCallback) => {
          ok({ coords: { latitude: -5.8, longitude: 39.2, accuracy } } as GeolocationPosition);
          return 1;
        },
        clearWatch: vi.fn(),
      },
    });
    setup();
    fireEvent.click(screen.getByTestId('form-gps'));
    const badge = await screen.findByTestId('form-gps-accuracy');
    expect(badge.getAttribute('data-warn')).toBe('true');
    expect(badge.textContent).toContain(t('form.gpsAccuracy', { m: fmt.number(45) }));
    expect(badge.textContent).toContain(t('form.gpsWeak', { limit: fmt.number(30) }));
    expect((screen.getByTestId('form-lat') as HTMLInputElement).value).toBe('-5.8');
    accuracy = 8;
    // Still improving the fix: stop, then capture again.
    fireEvent.click(screen.getByTestId('form-gps-stop'));
    fireEvent.click(screen.getByTestId('form-gps'));
    await waitFor(() =>
      expect(screen.getByTestId('form-gps-accuracy').getAttribute('data-warn')).toBe('false'),
    );
    expect(screen.getByTestId('form-location-source').textContent).toContain(
      t('enum.location_source.gps'),
    );
  });

  it('picks the point on the map', async () => {
    mocks.pick.mockResolvedValue({ lon: 40.5, lat: -5.5, source: 'map' });
    setup();
    fireEvent.click(screen.getByTestId('form-pick-map'));
    await waitFor(() =>
      expect((screen.getByTestId('form-lon') as HTMLInputElement).value).toBe('40.5'),
    );
    expect(mocks.pick).toHaveBeenCalledWith(null);
    await waitFor(
      () => expect((screen.getByTestId('form-area') as HTMLSelectElement).value).toBe(R2),
      { timeout: 3000 },
    );
  });

  it('offline: fills country, region and district from the cached shapes', async () => {
    setup({ draft: newDraft({ userId: 'u1', countryId: null }) });
    await fillEssentials();
    expect((screen.getByTestId('form-country') as HTMLSelectElement).value).toBe(TZ);
    await waitFor(() =>
      expect((screen.getByTestId('form-area-2') as HTMLSelectElement).value).toBe(D1),
    );
    expect(screen.getByTestId('form-area-auto')).toBeTruthy();
    expect(mocks.rpc).not.toHaveBeenCalled(); // offline: no request at all
  });

  it('online: uses locate_point', async () => {
    online = true;
    mocks.rpc.mockImplementation(async (fn: string) => {
      if (fn === 'locate_point')
        return {
          country: { id: TZ },
          admin_area_id: R2,
          areas: [{ id: R2, level: 1 }],
          localities: [],
        };
      return fn === 'project_duplicates' ? [] : { features: [] };
    });
    setup();
    input('form-lat', '-5.8');
    input('form-lon', '39.2');
    await waitFor(
      () => expect((screen.getByTestId('form-area') as HTMLSelectElement).value).toBe(R2),
      { timeout: 3000 },
    );
    expect(mocks.rpc).toHaveBeenCalledWith('locate_point', { p_lon: 39.2, p_lat: -5.8 });
  });

  it('warns when the point is outside the chosen area, and asks before saving', async () => {
    const { onSaved } = setup();
    await fillEssentials();
    choose('form-area', R2); // corrected by hand to another region
    expect(await screen.findByTestId('form-geo-warning')).toBeTruthy();
    fireEvent.click(screen.getByTestId('form-save'));
    const dialog = await screen.findByTestId('confirm-dialog');
    expect(dialog.textContent).toContain(t('form.geoOutsideArea'));
    fireEvent.click(within(dialog).getByTestId('confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
    expect(mocks.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('form-save'));
    fireEvent.click(within(await screen.findByTestId('confirm-dialog')).getByTestId('confirm-ok'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });
});

describe('localities: bounded, indexed reads (brief §5, §12.2)', () => {
  const NEAR = '01900000-0000-7000-8000-00000000e001';
  const IN_D1 = '01900000-0000-7000-8000-00000000e002';

  /** `n` localities spread over the country, all > 30 km from (39.2, -5.81), plus two that count. */
  async function seedLocalities(n: number): Promise<Set<string>> {
    const rows: Row<'localities'>[] = [];
    const loc = (values: Partial<Row<'localities'>> & { lon: number; lat: number }) =>
      ({
        ...newRow('localities', {
          country_id: TZ,
          status: 'approved',
          ...values,
        } as Partial<Row<'localities'>>),
        _cell: gridCell(values),
      }) as Row<'localities'>;
    for (let i = 0; i < n; i++) {
      rows.push(
        loc({
          name_ar: `قرية ${i}`,
          admin_area_id: R2,
          lon: 30 + (i % 60) * 0.15,
          lat: -10 + Math.floor(i / 60) * 0.15,
        }),
      );
    }
    rows.push(
      loc({ id: NEAR, name_ar: 'قرية قريبة', admin_area_id: null, lon: 39.21, lat: -5.81 }),
    );
    rows.push(loc({ id: IN_D1, name_ar: 'قرية في المقاطعة', admin_area_id: D1, lon: 30, lat: -1 }));
    await db.localities.bulkPut(rows);
    return new Set(rows.map((r) => r.id));
  }

  /** Counts the rows of `ids` that any Dexie collection hands out while `fn` runs. */
  async function rowsRead(ids: Set<string>, fn: () => Promise<void>): Promise<number> {
    const proto = Object.getPrototypeOf(db.localities.toCollection()) as {
      toArray: (...args: unknown[]) => Promise<unknown[]>;
    };
    let count = 0;
    const original = proto.toArray;
    const spy = vi.spyOn(proto, 'toArray').mockImplementation(async function (
      this: unknown,
      ...args: unknown[]
    ) {
      const out = await original.apply(this, args);
      if (Array.isArray(out))
        count += out.filter((r) => ids.has((r as { id?: string } | undefined)?.id ?? '')).length;
      return out;
    });
    try {
      await fn();
    } finally {
      spy.mockRestore();
    }
    return count;
  }

  it('listLocalities reads the chosen areas and the box around the point, never the country', async () => {
    const ids = await seedLocalities(3000);
    const where = vi.spyOn(db.localities, 'where');
    let rows: Awaited<ReturnType<typeof listLocalities>> = [];
    const read = await rowsRead(ids, async () => {
      rows = await listLocalities({
        countryId: TZ,
        areaIds: [R1, D1, null],
        point: { lon: 39.2, lat: -5.81 },
      });
    });
    expect(where.mock.calls.map((c) => c[0])).toEqual(['admin_area_id', '_cell']);
    where.mockRestore();
    expect(rows.map((r) => r.id)).toEqual([NEAR, IN_D1]); // nearest first
    expect(rows[0]!.distance_m).toBe(1106);
    expect(read).toBeLessThanOrEqual(2);
    expect(LOCALITY_SCAN_LIMIT).toBeLessThanOrEqual(1000);
  });

  it('regression: typing the latitude digit by digit reads the localities once the point settles', async () => {
    const ids = await seedLocalities(3000);
    setup();
    fireEvent.click(screen.getByTestId('form-type-mosque'));
    input('form-lon', '39.2');
    await new Promise((r) => setTimeout(r, 700)); // initial reads done
    const where = vi.spyOn(db.localities, 'where');
    const read = await rowsRead(ids, async () => {
      for (const v of ['-', '-5', '-5.', '-5.8', '-5.81', '-5.812', '-5.8123']) {
        input('form-lat', v);
        await new Promise((r) => setTimeout(r, 60));
      }
      // The point settles; the geofill then fills region + district (one more area read).
      await waitFor(
        () => expect((screen.getByTestId('form-area-2') as HTMLSelectElement).value).toBe(D1),
        { timeout: 3000 },
      );
      await new Promise((r) => setTimeout(r, 700));
    });
    const indexes = where.mock.calls.map((c) => String(c[0]));
    where.mockRestore();
    expect(indexes).not.toContain('country_id');
    expect(indexes.filter((i) => i === '_cell').length).toBeLessThanOrEqual(2);
    expect(indexes.length).toBeLessThanOrEqual(4);
    expect(read).toBeLessThanOrEqual(6);
    const options = [...(screen.getByTestId('form-locality') as HTMLSelectElement).options].map(
      (o) => o.value,
    );
    expect(options).toContain(NEAR);
    expect(options).toContain(IN_D1);
    expect(options.length).toBeLessThanOrEqual(4); // placeholder, the two, "add new"
  });
});

describe('duplicates (brief §7.3)', () => {
  const hit = {
    id: '01900000-0000-7000-8000-0000000000aa',
    code: 'TZ-PN-000001',
    name_ar: 'مسجد النور',
    name_latin: null,
    type: 'mosque',
    status: 'active',
    record_state: 'approved',
    lon: 39.2001,
    lat: -5.8001,
    locality_id: null,
    admin_area_id: D1,
    created_by_me: true,
    distance_m: 14.2,
    similarity: 1,
    reason: 'both',
  };

  beforeEach(() => {
    online = true;
    mocks.rpc.mockImplementation(async (fn: string) => {
      if (fn === 'project_duplicates') return [hit];
      if (fn === 'locate_point')
        return {
          country: { id: TZ },
          admin_area_id: D1,
          areas: [
            { id: R1, level: 1 },
            { id: D1, level: 2 },
          ],
          localities: [],
        };
      return { features: [] };
    });
  });

  it('"different project" saves', async () => {
    const { onSaved } = setup();
    await fillEssentials();
    fireEvent.click(screen.getByTestId('form-save'));
    const dialog = await screen.findByTestId('form-dup-dialog');
    expect(within(dialog).getAllByTestId('form-dup-row')).toHaveLength(1);
    expect(dialog.textContent).toContain('TZ-PN-000001');
    fireEvent.click(within(dialog).getByTestId('form-dup-different'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });

  it('"same project — open for editing" opens it and keeps this entry as a draft', async () => {
    const { onOpenProject, draft } = setup();
    await fillEssentials();
    fireEvent.click(screen.getByTestId('form-save'));
    fireEvent.click(
      within(await screen.findByTestId('form-dup-dialog')).getByTestId('form-dup-open'),
    );
    await waitFor(() =>
      expect(onOpenProject).toHaveBeenCalledWith(expect.objectContaining({ id: hit.id })),
    );
    expect(mocks.save).not.toHaveBeenCalled();
    const stored = (await drafts.get(draftKey('new', draft.projectId))) as FormDraft;
    expect(stored.working.project.name_ar).toBe('مسجد النور');
  });
});

describe('autosave and leaving (brief §7.4)', () => {
  it('saves the draft on change; Esc asks and never drops anything', async () => {
    const { draft, onLeave } = setup();
    input('form-name', 'مدرسة الفرقان');
    await waitFor(async () => {
      const stored = (await drafts.get(draftKey('new', draft.projectId))) as FormDraft | undefined;
      expect(stored?.working.project.name_ar).toBe('مدرسة الفرقان');
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    const dialog = await screen.findByTestId('confirm-dialog');
    expect(dialog.textContent).toContain(t('form.leaveBody'));
    fireEvent.click(within(dialog).getByTestId('confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
    expect(onLeave).not.toHaveBeenCalled();
    expect((screen.getByTestId('form-name') as HTMLInputElement).value).toBe('مدرسة الفرقان');

    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(within(await screen.findByTestId('confirm-dialog')).getByTestId('confirm-ok'));
    await waitFor(() => expect(onLeave).toHaveBeenCalled());
    cleanup(); // unmount = route change
    await new Promise((r) => setTimeout(r, 20));
    const kept = (await drafts.get(draftKey('new', draft.projectId))) as FormDraft;
    expect(kept.working.project.name_ar).toBe('مدرسة الفرقان');
  });

  it('cancel on an untouched form leaves at once and stores nothing', async () => {
    const { onLeave, draft } = setup();
    fireEvent.click(screen.getByTestId('form-cancel'));
    await waitFor(() => expect(onLeave).toHaveBeenCalled());
    expect(await drafts.get(draftKey('new', draft.projectId))).toBeUndefined();
  });

  it('restores the stored draft content when reopened with it', async () => {
    const d = newDraft({ userId: 'u1', countryId: TZ });
    d.working.project.name_ar = 'مسجد مستعاد';
    setup({ draft: d });
    expect((screen.getByTestId('form-name') as HTMLInputElement).value).toBe('مسجد مستعاد');
  });
});

describe('completeness (brief §7.5)', () => {
  it('shows the same number as lib/completeness and the missing items', async () => {
    setup();
    expect(screen.getByTestId('form-completeness').getAttribute('data-value')).toBe('0');
    await fillEssentials();
    await waitFor(() =>
      expect(screen.getByTestId('form-completeness').getAttribute('data-value')).toBe('30'),
    );
    // name_ar 10 + location 15 + admin_area 5 — the SQL twin agrees:
    const project = newRow('projects', {
      name_ar: 'x',
      lon: 1,
      lat: 1,
      admin_area_id: D1,
    } as Partial<Row<'projects'>>);
    expect(
      projectCompleteness({ project, maintenance: [], photos: [], donors: [], staff: [] }),
    ).toBe(30);
    const missing = screen.getByTestId('form-missing');
    expect(missing.querySelectorAll('li').length).toBe(8);
    expect(missing.textContent).toContain(t('form.missing_photos'));
    expect(screen.getByTestId('form-completeness').textContent).toContain(
      t('form.completeness', { pct: fmt.number(30) }),
    );
  });

  it('an opened but empty section does not count; a filled one does', () => {
    const d = newDraft({ userId: 'u1' });
    d.working.land = newRow('project_land', { project_id: d.projectId } as Partial<
      Row<'project_land'>
    >);
    expect(projectCompleteness(previewBundle(d))).toBe(0);
    d.working.land.area_m2 = 300;
    expect(projectCompleteness(previewBundle(d))).toBe(10);
  });
});

describe('validation (brief §7.6)', () => {
  it('shows errors next to each field, links them and focuses the first', async () => {
    setup({ draft: newDraft({ userId: 'u1', countryId: null }) });
    fireEvent.click(screen.getByTestId('form-save'));
    await waitFor(() => expect(document.getElementById('pf-name_ar-error')).toBeTruthy());
    const name = screen.getByTestId('form-name');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(name.getAttribute('aria-describedby')).toContain('pf-name_ar-error');
    expect(document.getElementById('pf-name_ar-error')!.textContent).toBe(
      t('form.errNameRequired'),
    );
    expect(document.getElementById('pf-type-error')!.textContent).toBe(t('form.errTypeRequired'));
    expect(document.getElementById('pf-location-error')!.textContent).toBe(
      t('form.errLocationRequired'),
    );
    expect(document.getElementById('pf-country-error')!.textContent).toBe(
      t('form.errCountryRequired'),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('form-type-mosque')),
    );
    expect(mocks.save).not.toHaveBeenCalled();
    // Fixing a field clears its error.
    input('form-name', 'x');
    await waitFor(() => expect(document.getElementById('pf-name_ar-error')).toBeNull());
  });

  it('errors inside a folded section open it', async () => {
    setup();
    await fillEssentials();
    fireEvent.click(screen.getByTestId('form-section-basics'));
    input(await screen.findByTestId('form-capacity').then(() => 'form-capacity'), '-3');
    fireEvent.click(screen.getByTestId('form-section-basics')); // fold it again
    fireEvent.click(screen.getByTestId('form-save'));
    await waitFor(() =>
      expect(screen.getByTestId('form-section-basics').getAttribute('aria-expanded')).toBe('true'),
    );
    await waitFor(() =>
      expect(document.getElementById('pf-capacity-error')?.textContent).toBe(
        t('form.errNonNegativeInt'),
      ),
    );
  });
});

describe('status and maintenance (brief §7.10)', () => {
  it('"needs maintenance" opens a new maintenance entry that is saved with the bundle', async () => {
    const { onSaved } = setup();
    await fillEssentials();
    choose('form-status', 'maintenance');
    const dialog = await screen.findByTestId('form-maintenance-dialog');
    // Esc with typed text asks first (nothing is dropped silently).
    fireEvent.input(within(dialog).getByTestId('form-maint-description'), {
      target: { value: 'تسرب في السقف' },
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    const ask = await screen.findByTestId('confirm-dialog');
    fireEvent.click(within(ask).getByTestId('confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
    expect(screen.getByTestId('form-maintenance-dialog')).toBeTruthy();
    choose('form-maint-priority', 'urgent');
    input('form-maint-cost', '1500000');
    expect((screen.getByTestId('form-maint-currency') as HTMLSelectElement).value).toBe('TZS');
    fireEvent.click(screen.getByTestId('form-maint-save'));
    await waitFor(() => expect(screen.queryByTestId('form-maintenance-dialog')).toBeNull());
    expect(screen.getAllByTestId('form-maintenance-entry')).toHaveLength(1);

    fireEvent.click(screen.getByTestId('form-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const bundle = mocks.save.mock.calls[0]![0] as ProjectBundle;
    expect(bundle.project.status).toBe('maintenance');
    expect(bundle.maintenance).toHaveLength(1);
    expect(bundle.maintenance[0]).toMatchObject({
      description: 'تسرب في السقف',
      priority: 'urgent',
      estimated_cost: 1500000,
      currency: 'TZS',
      state: 'open',
      project_id: bundle.project.id,
    });
  });

  it('regression: text typed in the maintenance dialog survives back / reload and the dialog reopens', async () => {
    const { draft } = setup();
    choose('form-status', 'maintenance');
    const dialog = await screen.findByTestId('form-maintenance-dialog');
    fireEvent.input(within(dialog).getByTestId('form-maint-description'), {
      target: { value: 'تشقق في الجدار الشرقي' },
    });
    input('form-maint-cost', '250000');
    // Autosaved while the dialog is still open (nothing else in the form was typed).
    await waitFor(async () => {
      const stored = (await drafts.get(draftKey('new', draft.projectId))) as FormDraft | undefined;
      expect(stored?.extras.pendingMaintenance?.row).toMatchObject({
        description: 'تشقق في الجدار الشرقي',
        estimated_cost: 250000,
      });
    });
    cleanup(); // the back button / a reload: the form unmounts
    await new Promise((r) => setTimeout(r, 20));

    const stored = (await drafts.get(draftKey('new', draft.projectId))) as FormDraft;
    expect(stored.working.project.status).toBe('maintenance');
    setup({ draft: stored }); // the next opening restores the draft
    const again = await screen.findByTestId('form-maintenance-dialog');
    expect((within(again).getByTestId('form-maint-description') as HTMLTextAreaElement).value).toBe(
      'تشقق في الجدار الشرقي',
    );
    expect((screen.getByTestId('form-maint-cost') as HTMLInputElement).value).toBe('250000');
    // Still guarded: Esc asks before dropping the restored text.
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(
      within(await screen.findByTestId('confirm-dialog')).getByTestId('confirm-cancel'),
    );
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
    fireEvent.click(screen.getByTestId('form-maint-save'));
    await waitFor(() => expect(screen.queryByTestId('form-maintenance-dialog')).toBeNull());
    expect(screen.getAllByTestId('form-maintenance-entry')).toHaveLength(1);
    await waitFor(async () => {
      const saved = (await drafts.get(draftKey('new', draft.projectId))) as FormDraft;
      expect(saved.extras.pendingMaintenance ?? null).toBeNull();
      expect(saved.working.maintenance).toHaveLength(1);
      expect(saved.working.maintenance[0]!.description).toBe('تشقق في الجدار الشرقي');
    });
  });

  it('an untouched maintenance dialog stores nothing; cancelling it forgets its text', async () => {
    const { draft } = setup();
    fireEvent.click(screen.getByTestId('form-type-mosque')); // something worth keeping
    choose('form-status', 'maintenance');
    await screen.findByTestId('form-maintenance-dialog');
    fireEvent.click(screen.getByTestId('form-maint-cancel')); // nothing typed: closes at once
    await waitFor(() => expect(screen.queryByTestId('form-maintenance-dialog')).toBeNull());
    await waitFor(async () => {
      const stored = (await drafts.get(draftKey('new', draft.projectId))) as FormDraft | undefined;
      expect(stored).toBeTruthy();
      expect(stored!.extras.pendingMaintenance ?? null).toBeNull();
    });
  });
});

describe('restricted data', () => {
  it('is hidden from users who may not write it', async () => {
    setup({ access: { restrictedWrite: false } });
    expect(screen.queryByTestId('form-section-sensitive')).toBeNull();
    fireEvent.click(screen.getByTestId('form-section-staff'));
    fireEvent.click(await screen.findByTestId('form-staff-add'));
    await screen.findByTestId('form-staff-entry');
    expect(screen.queryByTestId('form-staff-salary')).toBeNull();
  });

  it('is offered (with the blind-write note) to writers', async () => {
    setup();
    fireEvent.click(screen.getByTestId('form-section-sensitive'));
    const section = await screen.findByTestId('form-sensitive');
    expect(section.textContent).toContain(t('form.sensitiveNoteBlind'));
    fireEvent.click(screen.getByTestId('form-section-staff'));
    fireEvent.click(await screen.findByTestId('form-staff-add'));
    expect(await screen.findByTestId('form-staff-salary')).toBeTruthy();
  });
});

describe('save (brief §7.9)', () => {
  it('calls saveProjectBundle once with the whole bundle, then removes the draft', async () => {
    const { onSaved, draft } = setup();
    await fillEssentials();
    fireEvent.click(screen.getByTestId('form-section-land'));
    // Opening a section without typing adds nothing; typing adds the land row.
    input(await screen.findByTestId('form-land-area').then(() => 'form-land-area'), '450');
    await waitFor(async () =>
      expect(await drafts.get(draftKey('new', draft.projectId))).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId('form-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(draft.projectId));
    expect(mocks.save).toHaveBeenCalledTimes(1);
    const bundle = mocks.save.mock.calls[0]![0] as ProjectBundle;
    expect(bundle.project).toMatchObject({
      id: draft.projectId,
      type: 'mosque',
      name_ar: 'مسجد النور',
      lon: 39.2,
      lat: -5.8,
      country_id: TZ,
      admin_area_id: D1,
      status: 'active',
      record_state: 'submitted',
      builder: 'الاستقامة',
    });
    expect(bundle.land).toMatchObject({ area_m2: 450, project_id: draft.projectId });
    expect(bundle.facilities).toBeUndefined();
    expect(bundle.sensitive).toBeUndefined();
    await waitFor(async () =>
      expect(await drafts.get(draftKey('new', draft.projectId))).toBeUndefined(),
    );
  });

  it('saves staged photos with the bundle, queues their upload, and blocks saving while busy', async () => {
    let busy: ((b: boolean) => void) | null = null;
    mocks.editor = (props: {
      projectId: string;
      photos: Row<'project_photos'>[];
      onChange: (p: Row<'project_photos'>[]) => void;
      onBusyChange?: (b: boolean) => void;
    }) => {
      busy = props.onBusyChange ?? null;
      return (
        <button
          type="button"
          data-testid="fake-add-photo"
          onClick={() =>
            props.onChange([
              ...props.photos,
              newRow('project_photos', { project_id: props.projectId, is_cover: true } as Partial<
                Row<'project_photos'>
              >),
            ])
          }
        >
          +
        </button>
      );
    };
    const { onSaved } = setup();
    await fillEssentials();
    fireEvent.click(await screen.findByTestId('fake-add-photo'));
    busy!(true);
    await waitFor(() =>
      expect((screen.getByTestId('form-save') as HTMLButtonElement).disabled).toBe(true),
    );
    busy!(false);
    await waitFor(() =>
      expect((screen.getByTestId('form-save') as HTMLButtonElement).disabled).toBe(false),
    );
    await waitFor(() =>
      expect(screen.getByTestId('form-completeness').getAttribute('data-value')).toBe('45'),
    );
    fireEvent.click(screen.getByTestId('form-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const bundle = mocks.save.mock.calls[0]![0] as ProjectBundle;
    expect(bundle.photos).toHaveLength(1);
    expect(mocks.queue).toHaveBeenCalledWith(bundle.photos);
  });

  it('"save as draft" keeps record_state draft and allows a missing location', async () => {
    const { onSaved } = setup();
    fireEvent.click(screen.getByTestId('form-type-school'));
    input('form-name', 'مدرسة');
    fireEvent.click(screen.getByTestId('form-save-draft'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const bundle = mocks.save.mock.calls[0]![0] as ProjectBundle;
    expect(bundle.project).toMatchObject({
      type: 'school',
      record_state: 'draft',
      lon: null,
      lat: null,
    });
  });

  it('a collector editing an approved record is told it returns to review', () => {
    const project = newRow('projects', {
      name_ar: 'مسجد',
      type: 'mosque',
      status: 'active',
      record_state: 'approved',
      created_by: 'u1',
      country_id: TZ,
      lon: 39.2,
      lat: -5.8,
      version: 3,
    } as Partial<Row<'projects'>>);
    const bundle: ProjectBundle = { project, maintenance: [], photos: [], donors: [], staff: [] };
    const draft: FormDraft = {
      v: 1,
      userId: 'u1',
      mode: 'edit',
      projectId: project.id,
      original: structuredClone(bundle),
      working: structuredClone(bundle),
      extras: {
        areaPath: [R1, null, null],
        newLocality: null,
        newDonorIds: [],
        newPersonIds: [],
        seenPhotoIds: [],
        geofillFor: { lon: 39.2, lat: -5.8 },
        manualArea: false,
      },
    };
    setup({ draft });
    expect(screen.getByTestId('form-returns-to-review').textContent).toBe(
      t('form.returnsToReview'),
    );
    expect(screen.queryByTestId('form-save-draft')).toBeNull();
    expect(screen.getByTestId('form-save').textContent).toBe(t('form.saveAndReview'));
  });
});

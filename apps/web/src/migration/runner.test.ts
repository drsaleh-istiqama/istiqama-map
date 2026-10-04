import { beforeEach, describe, expect, it } from 'vitest';
import {
  ackOp,
  db,
  dropPhotoBlob,
  markInflight,
  mutate,
  newRow,
  pendingOps,
  putPhotoBlob,
  type OutboxOp,
  type PushResult,
} from '../db';
import { freshDb, serverRow } from '../db/testing/factory';
import { uuidv7 } from '../lib/uuidv7';
import {
  dataUrlToBlob,
  executeMigration,
  finalizeMigration,
  prepareMigration,
  type RunnerDeps,
} from './runner';
import { loadRunState } from './state';
import { JPEG_DATA, PNG_1PX, SAMPLE_PROJECTS } from './testing/fixtures';
import { readV2Local } from './v2read';
import type { GeoHint } from './v2map';
import type { V2Person, V2Project } from './v2types';
import { V2_PEOPLE_KEY, V2_PROJECTS_KEY } from './v2types';

// --- reference rows as sync_pull delivers them ------------------------------------------
const TZ = '10000000-0000-4000-8000-0000000000a1';
const PN = '10000000-0000-4000-8000-0000000000b1';
const ZW = '10000000-0000-4000-8000-0000000000b2';
const PEMBA = '10000000-0000-4000-8000-0000000000c1';
const WETE = '10000000-0000-4000-8000-0000000000d1';

async function seedReference(): Promise<void> {
  await db.countries.bulkPut([
    serverRow('countries', {
      id: TZ,
      iso2: 'TZ',
      iso3: 'TZA',
      name_ar: 'تنزانيا',
      name_en: 'Tanzania',
      name_sw: 'Tanzania',
      default_currency: 'TZS',
      active: true,
    }),
  ]);
  await db.admin_areas.bulkPut([
    serverRow('admin_areas', {
      id: PN,
      country_id: TZ,
      level: 1,
      code: 'PN',
      name_ar: 'بيمبا الشمالية',
      name_en: 'North Pemba',
    }),
    serverRow('admin_areas', {
      id: ZW,
      country_id: TZ,
      level: 1,
      code: 'ZW',
      name_ar: 'زنجبار الحضرية والغربية',
      name_en: 'Zanzibar Urban/West',
    }),
  ]);
  await db.branches.bulkPut([
    serverRow('branches', {
      id: PEMBA,
      country_id: TZ,
      code: 'PEMBA',
      name_ar: 'فرع بيمبا',
      admin_area_ids: [PN],
      active: true,
    }),
  ]);
  await db.localities.bulkPut([
    serverRow('localities', {
      id: WETE,
      country_id: TZ,
      admin_area_id: PN,
      name_ar: 'ويتي',
      name_latin: 'Wete',
      status: 'approved',
      name_norm: 'ويتي wete',
    }),
  ]);
  await db.option_values.bulkPut([
    serverRow('option_values', {
      list_key: 'livelihoods',
      code: 'fishing',
      name_ar: 'الصيد',
      sort_order: 20,
      active: true,
    }),
    serverRow('option_values', {
      list_key: 'livelihoods',
      code: 'other',
      name_ar: 'أخرى',
      sort_order: 990,
      active: true,
    }),
  ]);
}

// --- a v2 device ---------------------------------------------------------------------------
const STAFF_PROJECT: V2Project = {
  id: 'v2-staff-1',
  name: 'مسجد الصفا',
  type: 'mosque',
  country: 'تنزانيا',
  region: 'بيمبا',
  locality: 'قرية جديدة',
  lat: -5.06,
  lng: 39.72,
  capacity: 200,
  status: 'active',
  manager: 'عبدالله سالم',
  phone: '0712345678',
  builder: 'الاستقامة',
  donor: 'متبرع كريم',
  buildDate: '2018-03-04',
  createdAt: '2025-02-03T04:05:06.000Z',
  updatedAt: '2025-06-01T00:00:00.000Z',
  staff: [
    { name: 'محمد علي', role: 'imam', salary: 150000, birthDate: '1980-01-01' },
    { name: 'مريم سالم', role: 'teacher', salary: 0 },
  ],
  photos: [
    { id: 'ph1', data: PNG_1PX, category: 'mosque_front', caption: 'الواجهة' },
    { id: 'ph2', data: JPEG_DATA, category: 'facilities', caption: '' },
    { id: 'ph3', data: 'https://tracker.invalid/p.png', category: 'land' },
  ],
  land: { ownership: 'waqf', area: 900 },
  community: { livelihoods: ['الصيد', 'تربية النحل'], ibadiFamilies: 2 },
};

const PEOPLE: V2Person[] = [
  { name: 'عبدالله سالم', roles: ['manager'], phone: '0712345678' },
  { name: 'محمد علي', roles: ['imam'], education: 'ثانوي' },
  { name: 'زينب', roles: ['teacher'] },
];

function fakeStorage(projects: unknown[], people: unknown[] = PEOPLE) {
  const map = new Map<string, string>([
    [V2_PROJECTS_KEY, JSON.stringify(projects)],
    [V2_PEOPLE_KEY, JSON.stringify(people)],
  ]);
  return {
    map,
    read: (k: string) => map.get(k) ?? null,
    remove: (k: string) => void map.delete(k),
  };
}

interface FakeSync {
  calls: number;
  /** What the "server" answers per op (default: applied). */
  answer: (op: OutboxOp) => PushResult;
  acks: boolean;
}

function makeDeps(storage: ReturnType<typeof fakeStorage>, over: Partial<RunnerDeps> = {}) {
  const sync: FakeSync = {
    calls: 0,
    acks: false,
    answer: (op) => ({
      op_id: op.op_id,
      status: 'applied',
      version: op.table === 'staff_compensation' || op.table === 'community_sensitive' ? null : 1,
    }),
  };
  const photos: Array<{ projectId: string; type: string; meta: unknown }> = [];
  let failPhotoOnce: { index: number; code: string } | null = null;
  let photoCalls = 0;
  const deps: RunnerDeps = {
    userId: () => '0a000000-0000-4000-8000-00000000000a',
    online: () => true,
    async syncNow() {
      sync.calls++;
      if (!sync.acks) return;
      const ops = await pendingOps();
      await markInflight(ops);
      for (const op of ops) await ackOp(sync.answer(op));
    },
    serverExternalIds: async () => new Set(),
    locate: async () =>
      ({ countryId: TZ, areaPath: [PN, null, null], adminAreaId: PN }) satisfies GeoHint,
    async addPhoto(projectId, file, meta) {
      const n = photoCalls++;
      if (failPhotoOnce && failPhotoOnce.index === n) {
        const code = failPhotoOnce.code;
        failPhotoOnce = null;
        throw Object.assign(new Error('photo failed'), { code });
      }
      photos.push({ projectId, type: file.type, meta });
      const row = newRow('project_photos', {
        project_id: projectId,
        storage_path_full: 'f',
        storage_path_thumb: 't',
        category: (meta as { category: 'unspecified' }).category,
        caption: (meta as { caption?: string }).caption ?? null,
      });
      await mutate('project_photos', row.id, row, { insert: true });
      return row;
    },
    writeScope: () => ({ countries: [], branches: [PEMBA] }),
    phone: (raw) => (/^0\d{9}$/.test(raw) ? `+255${raw.slice(1)}` : null),
    texts: {
      fallbackName: (id) => `v2 ${id}`,
      salaryReviewNote: (c) => `salary currency ${c.join(',')} assumed`,
    },
    readLegacy: storage.read,
    removeLegacy: storage.remove,
    newId: () => uuidv7(),
    today: () => '2026-10-04',
    preSyncTimeoutMs: 1000,
    ...over,
  };
  return {
    deps,
    sync,
    photos,
    failPhoto(index: number, code: string) {
      failPhotoOnce = { index, code };
    },
  };
}

async function projectsByExternalId(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await db.projects.each((p) => {
    if (p.external_id) out.set(p.external_id, p.id);
  });
  return out;
}

beforeEach(async () => {
  await freshDb({ canSeeRestricted: false });
  await seedReference();
});

describe('migration runner — local v2 data', () => {
  it('stores every project as a draft with staff, persons, donor, locality, photos', async () => {
    const storage = fakeStorage([...SAMPLE_PROJECTS, STAFF_PROJECT]);
    const { deps, photos } = makeDeps(storage);
    const local = readV2Local(storage.read);
    const prepared = await prepareMigration(local.data!, deps);
    expect(prepared.resumed).toBe(false);
    expect(prepared.plan.counts).toMatchObject({ projects: 6, photos: 2, photosRejected: 1 });

    const progress: string[] = [];
    const report = await executeMigration(prepared, deps, (p) => progress.push(p.phase));
    expect(report.saved).toBe(6);
    expect(report.failed).toEqual([]);
    expect(report.photosAdded).toBe(2);
    expect(report.personsSaved).toBe(1); // "زينب" belongs to no project
    expect(progress[0]).toBe('saving');
    expect(progress.at(-1)).toBe('waiting');

    const byKey = await projectsByExternalId();
    expect([...byKey.keys()].sort()).toEqual(
      ['v2:demo-1', 'v2:demo-2', 'v2:demo-3', 'v2:demo-4', 'v2:demo-5', 'v2:v2-staff-1'].sort(),
    );
    const pid = byKey.get('v2:v2-staff-1')!;
    const project = await db.projects.get(pid);
    expect(project).toMatchObject({
      name_ar: 'مسجد الصفا',
      record_state: 'draft',
      location_source: 'import',
      country_id: TZ,
      admin_area_id: PN,
      branch_id: PEMBA,
      build_year: 2018,
      created_at: '2025-02-03T04:05:06.000Z',
      review_note: 'salary currency TZS assumed',
    });
    // offline entry time travels with the insert
    const insert = (
      await db.outbox.where('[table+row_id]').equals(['projects', pid]).toArray()
    )[0]!;
    expect(insert.fields.created_at).toBe('2025-02-03T04:05:06.000Z');
    expect(insert.fields.external_id).toBe('v2:v2-staff-1');

    // locality "قرية جديدة" was proposed and queued BEFORE the project
    const locality = await db.localities.get(project!.locality_id!);
    expect(locality).toMatchObject({ name_ar: 'قرية جديدة', status: 'proposed', country_id: TZ });
    const seqLocality = (await db.outbox
      .where('[table+row_id]')
      .equals(['localities', locality!.id])
      .first())!.seq!;
    expect(seqLocality).toBeLessThan(insert.seq!);

    // staff → persons + assignments; salary only on the device, restricted
    const staff = await db.project_staff.where('project_id').equals(pid).toArray();
    expect(staff.map((s) => s.role).sort()).toEqual(['imam', 'manager', 'teacher']);
    const persons = await db.persons.bulkGet(staff.map((s) => s.person_id));
    expect(persons.map((p) => p!.name_ar).sort()).toEqual([
      'عبدالله سالم',
      'محمد علي',
      'مريم سالم',
    ]);
    expect(persons.find((p) => p!.name_ar === 'عبدالله سالم')!.phone_e164).toBe('+255712345678');
    // "محمد علي" is also the manager of demo-2: the v2 directory (keyed by name) may describe
    // either of them, so its details go to neither (brief §2.4)
    expect(persons.find((p) => p!.name_ar === 'محمد علي')!.education_level).toBeNull();
    expect(report.warnings.map((w) => w.code)).toContain('person_directory_ambiguous');
    expect(await db.staff_compensation.count()).toBe(0);
    const restricted = await db.restricted_local.toArray();
    expect(restricted.map((r) => r.table).sort()).toEqual([
      'community_sensitive',
      'staff_compensation',
    ]);
    expect(restricted.find((r) => r.table === 'staff_compensation')!.row).toMatchObject({
      monthly_amount: 150000,
      currency: 'TZS',
      effective_from: '2025-06-01',
    });

    // donor shared by demo-2, demo-5 and this project: one donor
    const donors = await db.donors.toArray();
    expect(donors.map((d) => d.name_ar)).toEqual(['متبرع كريم']);
    expect(await db.project_donors.count()).toBe(3);

    // community: known option + "other" text
    const community = await db.community_profiles.where('project_id').equals(pid).first();
    expect(community!.livelihoods_other).toBe('تربية النحل');
    expect(community!.livelihoods).toHaveLength(2);

    // photos went through addPhoto with category and caption, the URL one was rejected
    expect(photos.map((p) => [p.type, p.meta])).toEqual([
      ['image/png', { category: 'mosque_front', caption: 'الواجهة' }],
      ['image/jpeg', { category: 'facilities' }],
    ]);

    // nothing acknowledged yet → the v2 keys stay
    expect(report.push.done).toBe(false);
    expect(report.push.pending).toBeGreaterThan(0);
    expect(report.keysRemoved).toBe(false);
    expect(storage.map.has(V2_PROJECTS_KEY)).toBe(true);
    expect(storage.map.has(V2_PEOPLE_KEY)).toBe(true);
    const state = await loadRunState('v2_local', local.data!.fingerprint);
    expect(state).toMatchObject({ pushedAt: null, keysRemovedAt: null });
    expect(state!.savedAt).not.toBeNull();
  });

  it('removes the keys only once the server acknowledged every operation', async () => {
    const storage = fakeStorage([...SAMPLE_PROJECTS, STAFF_PROJECT]);
    const { deps, sync } = makeDeps(storage);
    const local = readV2Local(storage.read);
    const report = await executeMigration(await prepareMigration(local.data!, deps), deps);
    expect(report.keysRemoved).toBe(false);
    expect(storage.map.size).toBe(2);

    // the server now answers: everything applied
    sync.acks = true;
    const state = (await loadRunState('v2_local', local.data!.fingerprint))!;
    const fin = await finalizeMigration(state, deps, { sync: true });
    expect(fin.push).toMatchObject({ pending: 0, failed: 0, done: true });
    expect(fin.keysRemoved).toBe(true);
    expect(storage.map.size).toBe(0);
    expect(await db.outbox.count()).toBe(0);
    // restricted rows leave the device once acknowledged (brief §3)
    expect(await db.restricted_local.count()).toBe(0);
    const after = (await loadRunState('v2_local', local.data!.fingerprint))!;
    expect(after.pushedAt).not.toBeNull();
    expect(after.keysRemovedAt).not.toBeNull();
  });

  it('acknowledged during the run itself → keys removed at the end of the run', async () => {
    const storage = fakeStorage([STAFF_PROJECT]);
    const { deps, sync } = makeDeps(storage);
    sync.acks = true;
    const report = await executeMigration(
      await prepareMigration(readV2Local(storage.read).data!, deps),
      deps,
    );
    expect(report.push.done).toBe(true);
    expect(report.keysRemoved).toBe(true);
    expect(storage.map.size).toBe(0);
  });

  it('a rejected operation keeps the keys (and is reported)', async () => {
    const storage = fakeStorage([STAFF_PROJECT]);
    const { deps, sync } = makeDeps(storage);
    sync.acks = true;
    sync.answer = (op) =>
      op.table === 'projects'
        ? { op_id: op.op_id, status: 'rejected', error: { code: 'out_of_scope' } }
        : {
            op_id: op.op_id,
            status: 'applied',
            version:
              op.table === 'staff_compensation' || op.table === 'community_sensitive' ? null : 1,
          };
    const report = await executeMigration(
      await prepareMigration(readV2Local(storage.read).data!, deps),
      deps,
    );
    expect(report.push.done).toBe(false);
    expect(report.push.failures.map((f) => f.code)).toContain('out_of_scope');
    expect(report.keysRemoved).toBe(false);
    expect(storage.map.size).toBe(2);
  });

  it('offline: everything is stored, nothing is synced, the keys stay', async () => {
    const storage = fakeStorage([STAFF_PROJECT]);
    const { deps, sync } = makeDeps(storage, { online: () => false });
    let located = 0;
    deps.locate = async () => {
      located++;
      return null;
    };
    const report = await executeMigration(
      await prepareMigration(readV2Local(storage.read).data!, deps),
      deps,
    );
    expect(sync.calls).toBe(0);
    expect(report.saved).toBe(1);
    expect(report.keysRemoved).toBe(false);
    expect(located).toBe(1); // the device cache is still asked (offline geofill)
  });

  it('never merges with existing persons: a same-named person on the device stays separate', async () => {
    const existing = serverRow('persons', {
      name_ar: 'محمد علي',
      name_normalized: 'محمد علي',
      country_id: TZ,
      branch_id: PEMBA,
    });
    await db.persons.put(existing);
    const storage = fakeStorage([STAFF_PROJECT], []);
    const { deps } = makeDeps(storage);
    await executeMigration(await prepareMigration(readV2Local(storage.read).data!, deps), deps);
    const named = (await db.persons.toArray()).filter((p) => p.name_ar === 'محمد علي');
    expect(named).toHaveLength(2);
    expect(named.find((p) => p.id === existing.id)!.version).toBe(1);
    const staff = await db.project_staff.toArray();
    expect(staff.some((s) => s.person_id === existing.id)).toBe(false);
  });

  it('keeps the keys when the stored data changed since the run', async () => {
    const storage = fakeStorage([STAFF_PROJECT]);
    const { deps, sync } = makeDeps(storage);
    const local = readV2Local(storage.read);
    await executeMigration(await prepareMigration(local.data!, deps), deps);
    storage.map.set(
      V2_PROJECTS_KEY,
      JSON.stringify([STAFF_PROJECT, { id: 'new', name: 'جديد', type: 'mosque' }]),
    );
    sync.acks = true;
    const state = (await loadRunState('v2_local', local.data!.fingerprint))!;
    const fin = await finalizeMigration(state, deps, { sync: true });
    expect(fin.push.done).toBe(true);
    expect(fin.keysRemoved).toBe(false);
    expect(storage.map.has(V2_PROJECTS_KEY)).toBe(true);
  });

  it('regression: keeps the keys while a migrated image is not uploaded yet (photo_blobs)', async () => {
    const storage = fakeStorage([STAFF_PROJECT]);
    const { deps, sync } = makeDeps(storage);
    const photoIds: string[] = [];
    const plain = deps.addPhoto;
    // like src/photos persist: both blobs are stored, then the row is queued
    deps.addPhoto = async (projectId, file, meta) => {
      const row = (await plain(projectId, file, meta)) as { id: string };
      await putPhotoBlob(row.id, 'thumb', file, { projectId });
      await putPhotoBlob(row.id, 'full', file, { projectId });
      photoIds.push(row.id);
      return row;
    };
    sync.acks = true; // every outbox operation is acknowledged…
    const local = readV2Local(storage.read);
    const report = await executeMigration(await prepareMigration(local.data!, deps), deps);
    expect(await db.outbox.count()).toBe(0);
    // … but the images are only on this device: the v2 data URLs must stay
    expect(report.push).toMatchObject({ pending: 0, failed: 0, photos: 2, done: false });
    expect(report.keysRemoved).toBe(false);
    expect(storage.map.size).toBe(2);

    // the upload queue stored one image (frees its full blob; the thumbnail stays cached)
    await dropPhotoBlob(photoIds[0]!, 'full');
    let state = (await loadRunState('v2_local', local.data!.fingerprint))!;
    let fin = await finalizeMigration(state, deps, { sync: true });
    expect(fin.push).toMatchObject({ photos: 1, done: false });
    expect(fin.keysRemoved).toBe(false);

    await dropPhotoBlob(photoIds[1]!, 'full');
    state = (await loadRunState('v2_local', local.data!.fingerprint))!;
    fin = await finalizeMigration(state, deps, { sync: true });
    expect(fin.push).toMatchObject({ photos: 0, done: true });
    expect(fin.keysRemoved).toBe(true);
    expect(storage.map.size).toBe(0);
  });

  it('same-name persons of one country are filed as merge requests only after the upload', async () => {
    const storage = fakeStorage([...SAMPLE_PROJECTS, STAFF_PROJECT]);
    const calls: Array<[string, string, string]> = [];
    let answer = false; // first attempt: a passing failure (retried later)
    const { deps, sync } = makeDeps(storage, {
      async requestMerge(source, target, name) {
        calls.push([source, target, name]);
        return answer;
      },
    });
    const local = readV2Local(storage.read);
    const prepared = await prepareMigration(local.data!, deps);
    // demo-1's manager vs the staffed project's manager, demo-2's manager vs its imam
    expect(prepared.plan.mergeSuggestions.map((s) => s.name).sort()).toEqual([
      'عبدالله سالم',
      'محمد علي',
    ]);
    await executeMigration(prepared, deps);
    expect(calls).toEqual([]); // nothing on the server yet: nothing filed

    sync.acks = true;
    let state = (await loadRunState('v2_local', local.data!.fingerprint))!;
    await finalizeMigration(state, deps, { sync: true });
    expect(calls).toHaveLength(2);
    for (const [source, target] of calls) {
      expect(source).not.toBe(target);
      expect(await db.persons.get(source)).toBeDefined();
      expect(await db.persons.get(target)).toBeDefined();
    }
    // still two persons each: nothing was merged on the device
    const names = (await db.persons.toArray()).map((p) => p.name_ar);
    expect(names.filter((n) => n === 'محمد علي')).toHaveLength(2);

    // retried after the passing failure, then never again
    answer = true;
    state = (await loadRunState('v2_local', local.data!.fingerprint))!;
    expect(state.mergeFiled ?? []).toEqual([]);
    await finalizeMigration(state, deps, { sync: false });
    expect(calls).toHaveLength(4);
    state = (await loadRunState('v2_local', local.data!.fingerprint))!;
    expect(state.mergeFiled).toHaveLength(2);
    await finalizeMigration(state, deps, { sync: false });
    expect(calls).toHaveLength(4);
  });
});

describe('migration runner — resumable and idempotent', () => {
  it('an interrupted run resumes with the same ids and creates nothing twice', async () => {
    const storage = fakeStorage([...SAMPLE_PROJECTS, STAFF_PROJECT]);
    const { deps } = makeDeps(storage);
    const data = readV2Local(storage.read).data!;
    const first = await prepareMigration(data, deps);
    let saved = 0;
    await expect(
      executeMigration(first, deps, (p) => {
        if (p.phase === 'saving' && p.done >= 2 && ++saved > 2) throw new Error('tab closed');
      }),
    ).rejects.toThrow('tab closed');
    const partly = await projectsByExternalId();
    expect(partly.size).toBeGreaterThan(0);
    expect(partly.size).toBeLessThan(6);

    const second = await prepareMigration(data, deps);
    expect(second.resumed).toBe(true);
    expect(second.plan.projects.map((p) => p.projectId)).toEqual(
      first.plan.projects.map((p) => p.projectId),
    );
    const report = await executeMigration(second, deps);
    expect(report.resumedSaved + report.saved).toBe(6);
    expect(report.resumedSaved).toBe(partly.size);

    const all = await projectsByExternalId();
    expect(all.size).toBe(6);
    expect(await db.projects.count()).toBe(6);
    // exactly one person per v2 entry — none created twice by the resumed run: 5 demo managers
    // + the staffed project's manager, imam and teacher + the directory entry "زينب"
    expect(await db.persons.count()).toBe(9);
    const planned = new Set(second.plan.persons.map((p) => p.id));
    expect(planned).toEqual(new Set(first.plan.persons.map((p) => p.id)));
    expect(await db.donors.count()).toBe(1);
  });

  it('a photo that failed for a passing reason is retried by the next run, and blocks the keys', async () => {
    const storage = fakeStorage([STAFF_PROJECT]);
    const { deps, sync, photos, failPhoto } = makeDeps(storage);
    sync.acks = true;
    failPhoto(1, 'storage_full');
    const data = readV2Local(storage.read).data!;
    const report = await executeMigration(await prepareMigration(data, deps), deps);
    expect(report.photosAdded).toBe(1);
    expect(report.photosFailed).toEqual([
      expect.objectContaining({
        index: 1,
        permanent: false,
        message: expect.stringContaining('storage_full'),
      }),
    ]);
    expect(report.push.done).toBe(true);
    expect(report.keysRemoved).toBe(false);
    expect(storage.map.size).toBe(2);

    const again = await executeMigration(await prepareMigration(data, deps), deps);
    expect(again.saved).toBe(0);
    expect(again.resumedSaved).toBe(1);
    expect(again.photosAdded).toBe(1);
    expect(photos).toHaveLength(2);
    expect(again.keysRemoved).toBe(true);
    expect(await db.project_photos.count()).toBe(2);
  });

  it('a damaged photo is given up for good and does not block the keys', async () => {
    const storage = fakeStorage([STAFF_PROJECT]);
    const { deps, sync, failPhoto } = makeDeps(storage);
    sync.acks = true;
    failPhoto(0, 'decode_failed');
    const report = await executeMigration(
      await prepareMigration(readV2Local(storage.read).data!, deps),
      deps,
    );
    expect(report.photosFailed[0]!.permanent).toBe(true);
    expect(report.keysRemoved).toBe(true);
  });

  it('a second run of the same backup file creates nothing', async () => {
    const storage = fakeStorage([], []);
    const { deps, sync } = makeDeps(storage);
    sync.acks = true;
    const file = {
      source: 'v2_json' as const,
      projects: [...SAMPLE_PROJECTS, STAFF_PROJECT],
      people: [],
      fingerprint: 'file-1',
      fileName: 'istiqama-backup-2025-06-01.json',
    };
    const one = await executeMigration(await prepareMigration(file, deps), deps);
    expect(one.saved).toBe(6);
    expect(one.push.done).toBe(true);
    const projects = await db.projects.count();
    const persons = await db.persons.count();

    // the same content under a new fingerprint (e.g. the file was saved again)
    const two = await prepareMigration({ ...file, fingerprint: 'file-2' }, deps);
    expect(two.plan.projects).toHaveLength(0);
    expect(two.plan.skipped).toHaveLength(6);
    const report = await executeMigration(two, deps);
    expect(report.saved).toBe(0);
    expect(await db.projects.count()).toBe(projects);
    expect(await db.persons.count()).toBe(persons);
  });

  it('projects the server already has (another device migrated them) are skipped', async () => {
    const storage = fakeStorage([...SAMPLE_PROJECTS]);
    const { deps } = makeDeps(storage, {
      serverExternalIds: async (keys) => new Set(keys.filter((k) => k !== 'v2:demo-3')),
    });
    const prepared = await prepareMigration(readV2Local(storage.read).data!, deps);
    expect(prepared.plan.projects.map((p) => p.key)).toEqual(['v2:demo-3']);
    expect(prepared.plan.skipped).toHaveLength(4);
  });

  it('two runs at the same time are refused', async () => {
    const storage = fakeStorage([STAFF_PROJECT]);
    const { deps } = makeDeps(storage);
    const prepared = await prepareMigration(readV2Local(storage.read).data!, deps);
    const a = executeMigration(prepared, deps);
    await expect(executeMigration(prepared, deps)).rejects.toThrow('migration_running');
    await a;
  });
});

describe('dataUrlToBlob', () => {
  it('decodes a base64 data URL into a typed Blob', async () => {
    const blob = dataUrlToBlob(PNG_1PX);
    expect(blob.type).toBe('image/png');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect([...bytes.slice(1, 4)].map((b) => String.fromCharCode(b)).join('')).toBe('PNG');
  });
});

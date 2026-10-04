/**
 * Offline global search: project names (Arabic / Latin), code, locality, staff names, donors.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { applyServerRows } from './apply';
import { searchLocal, type SearchHit } from './search';
import { freshDb, serverProject, serverRow } from './testing/factory';
import type { Row } from './types';

let nour: Row<'projects'>;
let falah: Row<'projects'>;
let wete: Row<'localities'>;
let salim: Row<'persons'>;
let khair: Row<'donors'>;

async function seed(withPeople: boolean): Promise<void> {
  wete = serverRow('localities', {
    name_ar: 'ويتي',
    name_latin: 'Wete',
    country_id: 'c',
    status: 'approved',
    lon: 39.7,
    lat: -5,
  });
  nour = serverProject({
    name_ar: 'مَسْجِد النُّور',
    name_latin: 'Masjid An-Nur',
    code: 'TZ-PN-000123',
    locality_id: wete.id,
  });
  falah = serverProject({
    name_ar: 'مدرسة الفلاح',
    name_latin: 'Shule ya Falah',
    code: 'TZ-PN-000124',
    type: 'school',
  });
  const other = serverProject({ name_ar: 'مسجد الرحمة', code: 'KE-XX-000007' });
  khair = serverRow('donors', { name_ar: 'مؤسسة الخير', name_latin: 'Al Khair Foundation' });
  salim = serverRow('persons', { name_ar: 'سالم بن علي الحارثي', name_latin: 'Salim Ali' });
  await applyServerRows('localities', [wete]);
  await applyServerRows('donors', [khair]);
  await applyServerRows('projects', [nour, falah, other]);
  await applyServerRows('project_donors', [
    serverRow('project_donors', { project_id: nour.id, donor_id: khair.id }),
    serverRow('project_donors', { project_id: falah.id, donor_id: khair.id }),
  ]);
  if (withPeople) {
    await applyServerRows('persons', [salim]);
    await applyServerRows('project_staff', [
      serverRow('project_staff', {
        project_id: falah.id,
        person_id: salim.id,
        role: 'teacher',
        end_date: '2024-01-01',
      }),
      serverRow('project_staff', { project_id: nour.id, person_id: salim.id, role: 'imam' }),
    ]);
  }
}

const kinds = (hits: SearchHit[]): string[] => hits.map((h) => `${h.kind}:${h.id}`);

beforeEach(async () => {
  await freshDb();
  await seed(true);
});

describe('searchLocal', () => {
  it('finds a project by its Arabic name, without tashkeel or article, any word order', async () => {
    for (const q of ['مسجد النور', 'النور', 'نور مسجد', 'مسج نو', 'مَسْجِدُ']) {
      expect(kinds(await searchLocal(q))).toContain(`project:${nour.id}`);
    }
    expect((await searchLocal('مسجد النور'))[0]).toMatchObject({
      kind: 'project',
      id: nour.id,
      score: 1,
    });
  });

  it('folds alef / teh marbuta / alef maksura like the server (مدرسه = مدرسة)', async () => {
    expect(kinds(await searchLocal('مدرسه الفلاح'))[0]).toBe(`project:${falah.id}`);
  });

  it('finds a project by its Latin name, case-insensitively', async () => {
    expect(kinds(await searchLocal('masjid an'))).toContain(`project:${nour.id}`);
    expect(kinds(await searchLocal('SHULE'))).toEqual([`project:${falah.id}`]);
  });

  it('finds a project by its code, also by the bare number', async () => {
    expect((await searchLocal('TZ-PN-000123'))[0]).toMatchObject({
      id: nour.id,
      score: 1,
      code: 'TZ-PN-000123',
    });
    expect(kinds(await searchLocal('123'))).toEqual([`project:${nour.id}`]);
    expect(kinds(await searchLocal('ke-xx'))).toHaveLength(1);
  });

  it('finds a project through its locality, and the locality itself', async () => {
    const hits = kinds(await searchLocal('wete'));
    expect(hits).toContain(`project:${nour.id}`);
    expect(hits).toContain(`locality:${wete.id}`);
  });

  it('finds staff by name with their projects (current assignment first)', async () => {
    const hit = (await searchLocal('الحارثي')).find((h) => h.kind === 'staff');
    expect(hit).toMatchObject({ kind: 'staff', id: salim.id, projects_count: 2 });
    if (hit?.kind !== 'staff') throw new Error('no staff hit');
    expect(hit.projects.map((p) => [p.id, p.role])).toEqual([
      [nour.id, 'imam'],
      [falah.id, 'teacher'],
    ]);
    expect(kinds(await searchLocal('salim'))).toContain(`staff:${salim.id}`);
  });

  it('finds donors with the projects they support', async () => {
    const hit = (await searchLocal('الخير')).find((h) => h.kind === 'donor');
    expect(hit).toMatchObject({ id: khair.id, projects_count: 2 });
    if (hit?.kind !== 'donor') throw new Error('no donor hit');
    expect(hit.projects.map((p) => p.id).sort()).toEqual([nour.id, falah.id].sort());
    expect(kinds(await searchLocal('khair foundation'))).toEqual([`donor:${khair.id}`]);
  });

  it('a viewer has no persons on the device, so no staff hit can appear', async () => {
    await freshDb();
    await seed(false);
    expect((await searchLocal('سالم')).filter((h) => h.kind === 'staff')).toEqual([]);
    expect(await searchLocal('salim')).toEqual([]);
  });

  it('queries shorter than two characters or made of punctuation return nothing', async () => {
    expect(await searchLocal('')).toEqual([]);
    expect(await searchLocal('م')).toEqual([]);
    expect(await searchLocal(' ؟! ')).toEqual([]);
  });

  it('ranks exact matches first; equal scores in kind order; respects limit and kinds', async () => {
    const hits = await searchLocal('مسجد');
    for (let i = 1; i < hits.length; i++)
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    expect(await searchLocal('مسجد', 1)).toHaveLength(1);
    expect((await searchLocal('wete', 20, ['locality'])).map((h) => h.kind)).toEqual(['locality']);
  });

  it('every word must match: no hit when one word is missing', async () => {
    expect(await searchLocal('مسجد الفلاح')).toEqual([]);
  });
});

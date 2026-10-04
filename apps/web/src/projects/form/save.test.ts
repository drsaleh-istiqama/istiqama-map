import { describe, expect, it, vi } from 'vitest';
import { newRow, type ProjectBundle, type Row } from '../../db';
import { clone, editDraft, newDraft } from './model';
import { FormSaveError, saveChoices, saveDraft, targetRecordState, type SaveDeps } from './save';

function deps(
  current: ProjectBundle | undefined,
  calls: string[] = [],
): Partial<SaveDeps> & {
  save: ReturnType<typeof vi.fn>;
  mutate: ReturnType<typeof vi.fn>;
} {
  const save = vi.fn(async () => {
    calls.push('save');
  });
  const mutate = vi.fn(async (table: string) => {
    calls.push(`mutate:${table}`);
  });
  return {
    load: async () => current,
    save,
    mutate: mutate as unknown as SaveDeps['mutate'],
    getLocality: async () => undefined,
    transaction: async (fn: () => Promise<void>) => fn(),
  } as unknown as Partial<SaveDeps> & { save: typeof save; mutate: typeof mutate };
}

function stored(state: Row<'projects'>['record_state']): ProjectBundle {
  const project = newRow('projects', {
    name_ar: 'مدرسة',
    type: 'school',
    status: 'active',
    record_state: state,
    lon: 39.7,
    lat: -5.0,
    country_id: 'c1',
    version: 2,
  } as Partial<Row<'projects'>>);
  return { project, maintenance: [], photos: [], donors: [], staff: [] };
}

describe('record state rules (sync.md §4.3)', () => {
  it('maps the stored state and the intent to the target', () => {
    expect(targetRecordState(null, 'draft', false)).toBe('draft');
    expect(targetRecordState(null, 'submit', false)).toBe('submitted');
    expect(targetRecordState('draft', 'submit', false)).toBe('submitted');
    expect(targetRecordState('returned', 'draft', false)).toBe('returned');
    expect(targetRecordState('returned', 'submit', false)).toBe('submitted');
    expect(targetRecordState('submitted', 'draft', false)).toBe('submitted');
    expect(targetRecordState('approved', 'submit', false)).toBe('submitted');
    expect(targetRecordState('approved', 'submit', true)).toBe('approved');
  });
  it('offers "save as draft" only where it is a valid transition', () => {
    expect(saveChoices(null, false)).toEqual({ draft: true, submit: true, returnsToReview: false });
    expect(saveChoices('approved', false)).toEqual({
      draft: false,
      submit: true,
      returnsToReview: true,
    });
    expect(saveChoices('approved', true).returnsToReview).toBe(false);
    expect(saveChoices('submitted', false).draft).toBe(false);
  });
});

describe('saveDraft', () => {
  it('new project: one saveProjectBundle call with the whole bundle, submitted', async () => {
    const d = newDraft({ userId: 'u1', countryId: 'c1', branchId: 'b1' });
    d.working.project = {
      ...d.working.project,
      type: 'mosque',
      name_ar: 'مسجد',
      lon: 39.7,
      lat: -5.05,
    };
    const m = newRow('project_maintenance', {
      project_id: d.projectId,
      description: 'تسرب',
    } as Partial<Row<'project_maintenance'>>);
    d.working.maintenance = [m];
    const dep = deps(undefined);
    const bundle = await saveDraft(d, 'submit', { isReviewer: false, deps: dep });
    expect(dep.save).toHaveBeenCalledTimes(1);
    const arg = dep.save.mock.calls[0]![0] as ProjectBundle;
    expect(arg).toBe(bundle);
    expect(arg.project).toMatchObject({
      id: d.projectId,
      type: 'mosque',
      name_ar: 'مسجد',
      record_state: 'submitted',
      builder: 'الاستقامة',
      branch_id: 'b1',
      country_id: 'c1',
    });
    expect(arg.maintenance.map((x) => x.id)).toEqual([m.id]);
  });

  it('creates a typed locality as "proposed" before the project, in one transaction', async () => {
    const calls: string[] = [];
    const d = newDraft({ userId: 'u1', countryId: 'c1' });
    d.working.project = {
      ...d.working.project,
      type: 'mosque',
      name_ar: 'مسجد',
      lon: 39.7,
      lat: -5.05,
      admin_area_id: 'a3',
    };
    d.extras.newLocality = {
      id: '01900000-0000-7000-8000-000000000001',
      name_ar: ' كيجيجي ',
      name_latin: '',
    };
    d.working.project.locality_id = d.extras.newLocality.id;
    const dep = deps(undefined, calls);
    const tx = vi.fn(async (fn: () => Promise<void>) => fn());
    await saveDraft(d, 'draft', { isReviewer: false, deps: { ...dep, transaction: tx } });
    expect(tx).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['mutate:localities', 'save']);
    expect(dep.mutate).toHaveBeenCalledWith(
      'localities',
      d.extras.newLocality.id,
      expect.objectContaining({
        name_ar: 'كيجيجي',
        name_latin: null,
        status: 'proposed',
        country_id: 'c1',
        admin_area_id: 'a3',
        lon: 39.7,
        lat: -5.05,
      }),
      { insert: true },
    );
  });

  it('edit: applies only the user changes on top of what is stored now', async () => {
    const original = stored('approved');
    const d = editDraft(original, 'u1');
    d.working.project.capacity = 250;
    const current = clone(original);
    current.project.status = 'inactive'; // changed elsewhere
    const dep = deps(current);
    await saveDraft(d, 'submit', { isReviewer: false, deps: dep });
    const arg = dep.save.mock.calls[0]![0] as ProjectBundle;
    expect(arg.project).toMatchObject({
      capacity: 250,
      status: 'inactive',
      record_state: 'submitted',
    });
  });

  it('edit of a project that left the device fails with "gone"', async () => {
    const d = editDraft(stored('draft'), 'u1');
    await expect(
      saveDraft(d, 'draft', { isReviewer: false, deps: deps(undefined) }),
    ).rejects.toMatchObject({
      code: 'gone',
    });
  });

  it('wraps write errors', async () => {
    const d = newDraft({ userId: 'u1', countryId: 'c1' });
    d.working.project = { ...d.working.project, type: 'mosque', name_ar: 'x' };
    const dep = deps(undefined);
    dep.save.mockRejectedValueOnce(new Error('quota'));
    const err = await saveDraft(d, 'draft', { isReviewer: false, deps: dep }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FormSaveError);
    expect((err as FormSaveError).code).toBe('write_failed');
  });
});

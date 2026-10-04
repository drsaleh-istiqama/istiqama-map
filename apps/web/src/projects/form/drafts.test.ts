import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newRow, type Row } from '../../db';
import {
  createAutosave,
  discardStoredDraft,
  draftWorthKeeping,
  listUserDrafts,
  readDraft,
  type DraftStore,
} from './drafts';
import { draftKey, editDraft, newDraft, type FormDraft } from './model';

function memoryStore(): DraftStore & { map: Map<string, { value: unknown; updatedAt: number }> } {
  const map = new Map<string, { value: unknown; updatedAt: number }>();
  return {
    map,
    get: async (k) => map.get(k)?.value,
    put: vi.fn(async (k: string, value: unknown) => {
      map.set(k, { value: structuredClone(value), updatedAt: Date.now() });
    }),
    remove: vi.fn(async (k: string) => {
      map.delete(k);
    }),
    list: async () =>
      [...map.entries()]
        .map(([key, v]) => ({ key, updatedAt: v.updatedAt }))
        .sort((a, b) => b.updatedAt - a.updatedAt),
  };
}

function typed(d: FormDraft, name: string): FormDraft {
  return { ...d, working: { ...d.working, project: { ...d.working.project, name_ar: name } } };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('autosave (brief §7.4)', () => {
  it('writes shortly after a field change, then every interval while changing', async () => {
    const store = memoryStore();
    let d = newDraft({ userId: 'u1', countryId: 'c1' });
    const a = createAutosave({ read: () => d, store, intervalMs: 5000, changeDelayMs: 300 });
    d = typed(d, 'م');
    a.changed();
    await vi.advanceTimersByTimeAsync(299);
    expect(store.put).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(store.put).toHaveBeenCalledTimes(1);
    const saved = store.map.get(draftKey('new', d.projectId))!.value as FormDraft;
    expect(saved.working.project.name_ar).toBe('م');
    expect(typeof saved.savedAt).toBe('number');
    await a.stop();
  });

  it('the 5-second timer saves a change even when the change timer was cancelled', async () => {
    const store = memoryStore();
    let d = newDraft({ userId: 'u1' });
    const a = createAutosave({ read: () => d, store, intervalMs: 5000, changeDelayMs: 60_000 });
    d = typed(d, 'مسجد');
    a.changed();
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.put).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.put).toHaveBeenCalledTimes(1); // nothing new: no rewrite
    await a.stop({ flush: false });
  });

  it('an untouched new form stores nothing; clearing everything removes the draft', async () => {
    const store = memoryStore();
    let d = newDraft({ userId: 'u1' });
    const a = createAutosave({ read: () => d, store, intervalMs: 1000, changeDelayMs: 10 });
    await a.flush();
    expect(store.map.size).toBe(0);
    d = typed(d, 'x');
    await a.flush();
    expect(store.map.size).toBe(1);
    d = typed(d, '');
    await a.flush();
    expect(store.map.size).toBe(0);
    await a.stop({ flush: false });
  });

  it('stop() flushes the latest state (route change / unmount loses nothing)', async () => {
    const store = memoryStore();
    let d = newDraft({ userId: 'u1' });
    const a = createAutosave({ read: () => d, store, intervalMs: 5000, changeDelayMs: 5000 });
    d = typed(d, 'آخر حرف');
    a.changed();
    await a.stop();
    expect(
      (store.map.get(draftKey('new', d.projectId))!.value as FormDraft).working.project.name_ar,
    ).toBe('آخر حرف');
  });

  it('a hidden page flushes immediately', async () => {
    const store = memoryStore();
    let d = newDraft({ userId: 'u1' });
    const a = createAutosave({ read: () => d, store, intervalMs: 60_000, changeDelayMs: 60_000 });
    d = typed(d, 'x');
    a.changed();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.put).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await a.stop({ flush: false });
  });
});

describe('restore and the unfinished-entries list', () => {
  it('restores only valid drafts of the same user', async () => {
    const store = memoryStore();
    const mine = typed(newDraft({ userId: 'u1' }), 'لي');
    const theirs = typed(newDraft({ userId: 'u2' }), 'لغيري');
    await store.put(draftKey('new', mine.projectId), mine);
    await store.put(draftKey('new', theirs.projectId), theirs);
    await store.put('project-form:new:not-a-uuid', { junk: true });
    expect((await readDraft('new', mine.projectId, 'u1', store))?.working.project.name_ar).toBe(
      'لي',
    );
    expect(await readDraft('new', theirs.projectId, 'u1', store)).toBeNull();
    const list = await listUserDrafts('u1', { store });
    expect(list.map((d) => d.draft.projectId)).toEqual([mine.projectId]);
  });

  it('an edit draft is worth keeping only when something changed', () => {
    const project = newRow('projects', { name_ar: 'x', type: 'mosque' } as Partial<
      Row<'projects'>
    >);
    const d = editDraft({ project, maintenance: [], photos: [], donors: [], staff: [] }, 'u1');
    expect(draftWorthKeeping(d)).toBe(false);
    expect(draftWorthKeeping(typed(d, 'y'))).toBe(true);
  });

  it('text typed in an open maintenance dialog makes the draft worth keeping (and it is saved)', async () => {
    const project = newRow('projects', {
      name_ar: 'x',
      type: 'mosque',
      status: 'maintenance',
    } as Partial<Row<'projects'>>);
    let d = editDraft({ project, maintenance: [], photos: [], donors: [], staff: [] }, 'u1');
    const blank = newRow('project_maintenance', { project_id: project.id } as Partial<
      Row<'project_maintenance'>
    >);
    d = { ...d, extras: { ...d.extras, pendingMaintenance: { base: blank, row: blank } } };
    expect(draftWorthKeeping(d)).toBe(false); // opened, nothing typed
    d = {
      ...d,
      extras: {
        ...d.extras,
        pendingMaintenance: { base: blank, row: { ...blank, description: 'سقف' } },
      },
    };
    expect(draftWorthKeeping(d)).toBe(true);
    const store = memoryStore();
    const a = createAutosave({ read: () => d, store, changeDelayMs: 10 });
    a.changed();
    await vi.advanceTimersByTimeAsync(10);
    const saved = store.map.get(draftKey('edit', project.id))!.value as FormDraft;
    expect(saved.extras.pendingMaintenance?.row.description).toBe('سقف');
    await a.stop();
  });

  it('text typed in a person picker alone makes an edit draft worth keeping (and it is saved)', async () => {
    const project = newRow('projects', { name_ar: 'x', type: 'mosque' } as Partial<
      Row<'projects'>
    >);
    const staff = newRow('project_staff', { project_id: project.id, role: 'imam' } as Partial<
      Row<'project_staff'>
    >);
    let d = editDraft({ project, maintenance: [], photos: [], donors: [], staff: [staff] }, 'u1');
    d = { ...d, extras: { ...d.extras, pickerDrafts: {} } };
    expect(draftWorthKeeping(d)).toBe(false); // picker opened, nothing typed
    d = {
      ...d,
      extras: { ...d.extras, pickerDrafts: { [staff.id]: { mode: 'search', query: 'حمدان' } } },
    };
    expect(draftWorthKeeping(d)).toBe(true);
    const store = memoryStore();
    const a = createAutosave({ read: () => d, store, changeDelayMs: 10 });
    a.changed();
    await vi.advanceTimersByTimeAsync(10);
    const saved = store.map.get(draftKey('edit', project.id))!.value as FormDraft;
    expect(saved.extras.pickerDrafts?.[staff.id]).toEqual({ mode: 'search', query: 'حمدان' });
    // A draft stored before the field existed is read as "nothing typed".
    const { pickerDrafts: _none, ...older } = d.extras;
    expect(draftWorthKeeping({ ...d, extras: older })).toBe(false);
    await a.stop();
  });

  it('discarding a draft frees the photos staged in it', async () => {
    const store = memoryStore();
    const d = typed(newDraft({ userId: 'u1' }), 'x');
    const photo = newRow('project_photos', { project_id: d.projectId } as Partial<
      Row<'project_photos'>
    >);
    d.working.photos = [photo];
    await store.put(draftKey('new', d.projectId), d);
    const freed: string[] = [];
    await discardStoredDraft(d, {
      store,
      discardPhotos: async (rows) => {
        freed.push(...rows.map((r) => r.id));
      },
    });
    expect(store.map.size).toBe(0);
    expect(freed).toEqual([photo.id]);
  });
});

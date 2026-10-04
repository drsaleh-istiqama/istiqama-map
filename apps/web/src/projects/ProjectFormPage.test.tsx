import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ write: true, userId: 'u1' }));

vi.mock('../auth', async () => {
  const { signal } = await import('@preact/signals');
  return {
    me: signal({
      user_id: 'u1',
      profile: { full_name: 'Amina' },
      scopes: { write: { branches: [], countries: [] } },
    }),
    session: signal({ user: { id: 'u1' } }),
    can: {
      get write() {
        return { value: mocks.write };
      },
      review: signal(false),
      seeRestricted: signal(false),
      seePeople: signal(true),
      admin: signal(false),
    },
    supabase: { from: () => ({ select: () => ({ eq: async () => ({ data: [], error: null }) }) }) },
  };
});

vi.mock('../sync', async () => {
  const { signal } = await import('@preact/signals');
  return {
    transport: { rpc: vi.fn(async () => ({ features: [] })) },
    syncStatus: signal({
      online: false,
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

vi.mock('./form/peers', () => ({
  loadPhotoEditor: async () => null,
  loadPersonPicker: async () => null,
  loadPickLocation: async () => null,
  queuePhotoUploads: async () => undefined,
  discardStagedPhotos: async () => undefined,
}));

import { db, drafts, newRow, type Row } from '../db';
import { t } from '../i18n';
import { navigate } from '../routes';
import { draftKey, editDraft, newDraft } from './form/model';
import ProjectFormPage from './ProjectFormPage';

function storedProject(createdBy = 'u1'): Row<'projects'> {
  return newRow('projects', {
    name_ar: 'مسجد قديم',
    type: 'mosque',
    status: 'active',
    record_state: 'draft',
    created_by: createdBy,
    version: 2,
  } as Partial<Row<'projects'>>);
}

beforeEach(async () => {
  mocks.write = true;
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => false });
  await Promise.all(db.tables.map((table) => table.clear()));
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

const storedDraftKeys = async (): Promise<string[]> => (await drafts.list()).map((d) => d.key);

describe('ProjectFormPage', () => {
  it('opens a blank form for /projects/new when nothing new is unfinished, and lists edit drafts', async () => {
    const project = storedProject();
    await db.projects.put(project);
    const edit = editDraft({ project, maintenance: [], photos: [], donors: [], staff: [] }, 'u1');
    edit.working.project.name_ar = 'تعديل سابق';
    await drafts.put(draftKey('edit', project.id), edit);
    navigate('/projects/new');
    render(<ProjectFormPage />);
    expect(await screen.findByTestId('project-form')).toBeTruthy();
    expect(screen.queryByTestId('form-resume-dialog')).toBeNull();
    expect((screen.getByTestId('form-name') as HTMLInputElement).value).toBe('');
    const rows = await screen.findAllByTestId('form-draft-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('تعديل سابق');
  });

  it('/projects/new offers the newest unfinished new entry first (brief §7.4) and continues it', async () => {
    const older = newDraft({ userId: 'u1' });
    older.working.project.name_ar = 'إدخال أقدم';
    await drafts.put(draftKey('new', older.projectId), older);
    await new Promise((r) => setTimeout(r, 5));
    const newest = newDraft({ userId: 'u1' });
    newest.working.project.name_ar = 'إدخال أحدث';
    await drafts.put(draftKey('new', newest.projectId), newest);
    navigate('/projects/new');
    render(<ProjectFormPage />);
    const dialog = await screen.findByTestId('form-resume-dialog');
    expect(dialog.textContent).toContain(t('form.resumeBody', { name: 'إدخال أحدث' }));
    expect(screen.queryByTestId('project-form')).toBeNull(); // no blank form behind it
    expect(document.activeElement).toBe(screen.getByTestId('form-resume'));
    fireEvent.click(screen.getByTestId('form-resume'));
    await waitFor(() =>
      expect((screen.getByTestId('form-name') as HTMLInputElement).value).toBe('إدخال أحدث'),
    );
    expect(window.location.search).toBe(`?draft=${newest.projectId}`);
    // The older one stays listed; the restored one is not listed twice.
    const rows = screen.getAllByTestId('form-draft-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('إدخال أقدم');
  });

  it('closing the offer without a choice (Esc) continues the entry — nothing is dropped', async () => {
    const d = newDraft({ userId: 'u1' });
    d.working.project.name_ar = 'مدرسة الاتجاه';
    await drafts.put(draftKey('new', d.projectId), d);
    navigate('/projects/new');
    render(<ProjectFormPage />);
    await screen.findByTestId('form-resume-dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect((screen.getByTestId('form-name') as HTMLInputElement).value).toBe('مدرسة الاتجاه'),
    );
  });

  it('"start a new project" opens a blank form and keeps the unfinished entry listed', async () => {
    const d = newDraft({ userId: 'u1' });
    d.working.project.name_ar = 'إدخال سابق';
    await drafts.put(draftKey('new', d.projectId), d);
    navigate('/projects/new');
    render(<ProjectFormPage />);
    fireEvent.click(await screen.findByTestId('form-resume-new'));
    expect(await screen.findByTestId('project-form')).toBeTruthy();
    expect((screen.getByTestId('form-name') as HTMLInputElement).value).toBe('');
    const rows = screen.getAllByTestId('form-draft-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('إدخال سابق');
    expect(await drafts.get(draftKey('new', d.projectId))).toBeTruthy();
  });

  it('regression: type → Esc → leave → "add project" again restores the same entry, no second draft', async () => {
    navigate('/projects/new');
    render(<ProjectFormPage />);
    fireEvent.click(await screen.findByTestId('form-type-school'));
    fireEvent.input(screen.getByTestId('form-name'), { target: { value: 'مدرسة مراجعة الاتجاه' } });
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(within(await screen.findByTestId('confirm-dialog')).getByTestId('confirm-ok'));
    await waitFor(() => expect(window.location.pathname).toBe('/projects'));
    cleanup(); // the route changed: the form unmounts (and flushes its autosave)
    await waitFor(async () => expect(await storedDraftKeys()).toHaveLength(1));
    const [key] = await storedDraftKeys();

    navigate('/projects/new');
    render(<ProjectFormPage />);
    expect((await screen.findByTestId('form-resume-dialog')).textContent).toContain(
      'مدرسة مراجعة الاتجاه',
    );
    fireEvent.click(screen.getByTestId('form-resume'));
    await waitFor(() =>
      expect((screen.getByTestId('form-name') as HTMLInputElement).value).toBe(
        'مدرسة مراجعة الاتجاه',
      ),
    );
    expect(screen.getByTestId('form-type-school').closest('.pf-card--on')).toBeTruthy();
    fireEvent.input(screen.getByTestId('form-name'), {
      target: { value: 'مدرسة مراجعة الاتجاه الثانية' },
    });
    await waitFor(async () => {
      const stored = (await drafts.get(key!)) as { working: { project: { name_ar: string } } };
      expect(stored.working.project.name_ar).toBe('مدرسة مراجعة الاتجاه الثانية');
    });
    expect(await storedDraftKeys()).toEqual([key]);
  });

  it('does not offer an entry whose project was saved meanwhile, nor drafts of another user', async () => {
    const saved = newDraft({ userId: 'u1' });
    saved.working.project.name_ar = 'محفوظ';
    await drafts.put(draftKey('new', saved.projectId), saved);
    await db.projects.put({ ...saved.working.project, type: 'mosque' } as Row<'projects'>);
    const theirs = newDraft({ userId: 'someone-else' });
    theirs.working.project.name_ar = 'لغيري';
    await drafts.put(draftKey('new', theirs.projectId), theirs);
    navigate('/projects/new');
    render(<ProjectFormPage />);
    expect(await screen.findByTestId('project-form')).toBeTruthy();
    expect(screen.queryByTestId('form-resume-dialog')).toBeNull();
    expect((screen.getByTestId('form-name') as HTMLInputElement).value).toBe('');
  });

  it('resumes an unfinished new entry (?draft=<id>)', async () => {
    const d = newDraft({ userId: 'u1' });
    d.working.project.name_ar = 'مستعاد';
    await drafts.put(draftKey('new', d.projectId), d);
    navigate(`/projects/new?draft=${d.projectId}`);
    render(<ProjectFormPage />);
    await waitFor(() =>
      expect((screen.getByTestId('form-name') as HTMLInputElement).value).toBe('مستعاد'),
    );
  });

  it('edit: offers to restore autosaved changes, and closing the offer keeps them', async () => {
    const project = storedProject();
    await db.projects.put(project);
    const autosaved = editDraft(
      { project, maintenance: [], photos: [], donors: [], staff: [] },
      'u1',
    );
    autosaved.working.project.name_ar = 'تعديل لم يُحفظ';
    await drafts.put(draftKey('edit', project.id), autosaved);
    navigate(`/projects/${project.id}/edit`);
    render(<ProjectFormPage />);
    expect(await screen.findByTestId('form-restore-dialog')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' }); // no choice = keep the changes
    await waitFor(() =>
      expect((screen.getByTestId('form-name') as HTMLInputElement).value).toBe('تعديل لم يُحفظ'),
    );
  });

  it('edit: "discard them" opens the stored record and deletes the autosave', async () => {
    const project = storedProject();
    await db.projects.put(project);
    const autosaved = editDraft(
      { project, maintenance: [], photos: [], donors: [], staff: [] },
      'u1',
    );
    autosaved.working.project.name_ar = 'تعديل لم يُحفظ';
    await drafts.put(draftKey('edit', project.id), autosaved);
    navigate(`/projects/${project.id}/edit`);
    render(<ProjectFormPage />);
    fireEvent.click(await screen.findByTestId('form-restore-discard'));
    await waitFor(() =>
      expect((screen.getByTestId('form-name') as HTMLInputElement).value).toBe('مسجد قديم'),
    );
    expect(await drafts.get(draftKey('edit', project.id))).toBeUndefined();
  });

  it('shows the server problems of rejected operations next to the fields', async () => {
    const project = storedProject();
    await db.projects.put(project);
    await db.failed_ops.add({
      op_id: '01900000-0000-7000-8000-0000000000f1',
      table: 'projects',
      row_id: project.id,
      kind: 'upsert',
      base_version: 2,
      fields: { capacity: -1 },
      attempts: 1,
      created_at: '2026-10-04T08:00:00Z',
      project_id: project.id,
      user_id: 'u1',
      seq: 1,
      error: { code: 'check_violation', constraint: 'projects_capacity_ck' },
      failed_at: 1,
    });
    navigate(`/projects/${project.id}/edit`);
    render(<ProjectFormPage />);
    expect(await screen.findByTestId('form-server-errors')).toBeTruthy();
    fireEvent.click(screen.getByTestId('form-section-basics'));
    await waitFor(() =>
      expect(document.getElementById('pf-capacity-error')?.textContent).toBe(
        t('form.srvInvalidValue'),
      ),
    );
  });

  it("refuses users without write access and other users' records", async () => {
    mocks.write = false;
    navigate('/projects/new');
    render(<ProjectFormPage />);
    expect(await screen.findByTestId('form-forbidden')).toBeTruthy();
    cleanup();

    mocks.write = true;
    const theirs = storedProject('someone-else');
    await db.projects.put(theirs);
    navigate(`/projects/${theirs.id}/edit`);
    render(<ProjectFormPage />);
    expect((await screen.findByTestId('form-forbidden')).textContent).toContain(
      t('form.cannotEdit'),
    );
  });

  it('a record entered on this device is editable before the server stamped its creator', async () => {
    const offline = { ...storedProject(), created_by: null, version: 0 } as Row<'projects'>;
    await db.projects.put(offline);
    navigate(`/projects/${offline.id}/edit`);
    render(<ProjectFormPage />);
    expect(await screen.findByTestId('project-form')).toBeTruthy();
  });

  it('looks again when the pull brings the creator of a record shown as "not yours"', async () => {
    const pushed = { ...storedProject(), created_by: null, version: 1 } as Row<'projects'>;
    await db.projects.put(pushed);
    navigate(`/projects/${pushed.id}/edit`);
    render(<ProjectFormPage />);
    expect(await screen.findByTestId('form-forbidden')).toBeTruthy();
    await db.projects.put({ ...pushed, created_by: 'u1', version: 2 });
    expect(await screen.findByTestId('project-form')).toBeTruthy();
  });

  it('says so when the project is not on the device', async () => {
    navigate('/projects/01900000-0000-7000-8000-00000000dead/edit');
    render(<ProjectFormPage />);
    expect(await screen.findByTestId('form-missing')).toBeTruthy();
  });
});

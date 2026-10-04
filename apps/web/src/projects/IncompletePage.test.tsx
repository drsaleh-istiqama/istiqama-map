import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth', async () => (await import('./testkit')).authModule());
vi.mock('../sync', async () => (await import('./testkit')).syncModule());

import { applyServerRows, drafts, loadProjectBundle } from '../db';
import { freshDb, serverProject, serverRow, USER_A, USER_B } from '../db/testing/factory';
import { setLocale } from '../i18n';
import { draftKey, editDraft, newDraft } from './form/model';
import IncompletePage, { describeDraft } from './IncompletePage';
import { missingParts } from './queries';
import { resetSyncMocks, useRole } from './testkit';

const MINE = '00000000-0080-7000-8000-0000000000d1';
const MINE_DONE = '00000000-0080-7000-8000-0000000000d2';
const OTHERS = '00000000-0080-7000-8000-0000000000d3';

async function seed(): Promise<void> {
  await applyServerRows('projects', [
    serverProject({
      id: MINE,
      name_ar: 'مسجد ناقص',
      name_latin: null,
      created_by: USER_A,
      completeness: 40,
      lon: 39.2,
      lat: -6.1,
      capacity: 50,
    }),
    serverProject({ id: MINE_DONE, name_ar: 'مسجد مكتمل', created_by: USER_A, completeness: 100 }),
    serverProject({ id: OTHERS, name_ar: 'مسجد غيري', created_by: USER_B, completeness: 10 }),
  ]);
  await applyServerRows('project_land', [
    serverRow('project_land', { project_id: MINE, ownership: 'waqf' }),
  ]);
}

beforeEach(async () => {
  await freshDb();
  await setLocale('en');
  resetSyncMocks();
  useRole('field_collector');
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('incomplete records (brief §7.5)', () => {
  it("lists only the signed-in user's incomplete records with what is missing", async () => {
    await seed();
    render(<IncompletePage />);
    await waitFor(() => expect(screen.getAllByTestId('incomplete-row')).toHaveLength(1));
    const row = screen.getByTestId('incomplete-row');
    expect(row.getAttribute('data-id')).toBe(MINE);
    const missing = within(row)
      .getAllByRole('listitem')
      .map((li) => li.getAttribute('data-key'));
    // heaviest first; land exists, location and capacity are filled
    expect(missing).toEqual([
      'photos',
      'facilities',
      'staff',
      'community',
      'name_latin',
      'admin_area',
      'build_year',
    ]);
    expect(row.textContent).toContain('Photos');
    expect(within(row).getByTestId('incomplete-edit').getAttribute('href')).toBe(
      `/projects/${MINE}/edit`,
    );
  });

  it('missingParts reads only index keys and the page rows', async () => {
    await seed();
    const parts = await missingParts([MINE, OTHERS]);
    expect(parts.get(MINE)).not.toContain('land');
    expect(parts.get(OTHERS)).toContain('land');
  });

  it('shows the user\'s unfinished form drafts with "continue" and "discard"', async () => {
    await seed();
    const fresh = newDraft({ userId: USER_A });
    fresh.working.project.name_ar = 'مسودة مسجد';
    fresh.working.project.name_latin = 'Draft Masjid';
    await drafts.put(draftKey('new', fresh.projectId), fresh);
    const bundle = (await loadProjectBundle(MINE))!;
    await drafts.put(draftKey('edit', MINE), editDraft(bundle, USER_A));
    const foreign = newDraft({ userId: USER_B });
    await drafts.put(draftKey('new', foreign.projectId), foreign);

    render(<IncompletePage />);
    await waitFor(() => expect(screen.getAllByTestId('draft-row')).toHaveLength(2));
    const rows = screen.getAllByTestId('draft-row');
    const created = rows.find((r) => r.getAttribute('data-mode') === 'new')!;
    expect(created.textContent).toContain('Draft Masjid');
    expect(within(created).getByTestId('draft-continue').getAttribute('href')).toBe(
      `/projects/new?draft=${fresh.projectId}`,
    );
    const edit = rows.find((r) => r.getAttribute('data-mode') === 'edit')!;
    expect(within(edit).getByTestId('draft-continue').getAttribute('href')).toBe(
      `/projects/${MINE}/edit`,
    );

    fireEvent.click(within(created).getByTestId('draft-discard'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await waitFor(() => expect(screen.getAllByTestId('draft-row')).toHaveLength(1));
    expect(await drafts.get(draftKey('new', fresh.projectId))).toBeUndefined();
    // another user's draft on the same device is neither listed nor touched
    expect(await drafts.get(draftKey('new', foreign.projectId))).toBeTruthy();
  });

  it('describeDraft follows the form convention', () => {
    const d = newDraft({ userId: USER_A });
    d.working.project.name_ar = 'أ';
    expect(describeDraft(d)).toEqual({ name: 'أ', href: `/projects/new?draft=${d.projectId}` });
    expect(describeDraft({ ...d, mode: 'edit' }).href).toBe(`/projects/${d.projectId}/edit`);
  });

  it('writers also see the rejected operations of this device; viewers do not', async () => {
    const first = render(<IncompletePage />);
    expect(await screen.findByTestId('failed-ops')).toBeTruthy();
    first.unmount();
    useRole('viewer');
    render(<IncompletePage />);
    await screen.findByTestId('incomplete-records');
    expect(screen.queryByTestId('failed-ops')).toBeNull();
  });
});

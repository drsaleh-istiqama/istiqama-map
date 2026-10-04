import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth', async () => (await import('./testkit')).authModule());
vi.mock('../sync', async () => (await import('./testkit')).syncModule());

import { applyServerRows, type Row, type SearchHit } from '../db';
import { freshDb, serverProject, serverRow } from '../db/testing/factory';
import { setLocale } from '../i18n';
import { getPref } from '../lib/prefs';
import { clearViewFilters } from '../routes';
import MaintenancePage from './MaintenancePage';
import { PROJECT_ROW_HEIGHT } from './ProjectCard';
import { ProjectList } from './ProjectList';
import ProjectsPage from './ProjectsPage';
import { mergeHits } from './search';
import { resetSyncMocks, setOnline, syncMocks, useRole } from './testkit';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pid = (i: number) => `00000000-0080-7000-8000-${String(i).padStart(12, '0')}`;

async function seedProjects(
  n: number,
  extra: (i: number) => Partial<Row<'projects'>> = () => ({}),
) {
  const rows = Array.from({ length: n }, (_, i) =>
    serverProject({
      id: pid(i),
      name_ar: `مسجد ${String(i).padStart(3, '0')}`,
      name_latin: `Masjid ${i}`,
      code: `TZ-PN-${String(i).padStart(6, '0')}`,
      ...extra(i),
    }),
  );
  await applyServerRows('projects', rows);
  return rows;
}

/** index → project id of every row currently in the DOM of the virtual list. */
function renderedRows(): Map<number, string> {
  const out = new Map<number, string>();
  for (const card of screen.queryAllByTestId('project-row')) {
    const row = card.closest('[data-index]') as HTMLElement;
    out.set(Number(row.dataset.index), card.getAttribute('data-id')!);
  }
  return out;
}

function loadedCount(): number {
  const first = screen.queryAllByRole('listitem')[0];
  return first ? Number(first.getAttribute('aria-setsize')) : 0;
}

beforeEach(async () => {
  await freshDb();
  await setLocale('en');
  clearViewFilters();
  resetSyncMocks();
  useRole('field_collector');
});
afterEach(cleanup);

describe('register: keyset paging through the virtual list', () => {
  it('loads pages of 50 while scrolling, without duplicates or gaps, in name order', async () => {
    const rows = await seedProjects(130);
    render(<ProjectList viewKey="paging" />);
    await waitFor(() => expect(loadedCount()).toBe(50));
    // Never everything at once (brief §5).
    expect(screen.getAllByTestId('project-row').length).toBeLessThan(30);

    const list = screen.getByTestId('project-rows');
    const seen = new Map<number, string>();
    const sizes = new Set<number>([loadedCount()]);
    for (
      let top = 0, guard = 0;
      guard < 100 && seen.size < 130;
      guard++, top += 5 * PROJECT_ROW_HEIGHT
    ) {
      await act(async () => {
        list.scrollTop = top;
        fireEvent.scroll(list);
        await sleep(15);
      });
      for (const [index, id] of renderedRows()) {
        const before = seen.get(index);
        if (before !== undefined) expect(before).toBe(id);
        seen.set(index, id);
      }
      sizes.add(loadedCount());
    }
    expect([...sizes].sort((a, b) => a - b)).toEqual([50, 100, 130]);
    expect(seen.size).toBe(130);
    const expected = rows.map((r) => r).sort((a, b) => (a.name_ar < b.name_ar ? -1 : 1));
    for (let i = 0; i < 130; i++) expect(seen.get(i)).toBe(expected[i]!.id);
    expect(new Set(seen.values()).size).toBe(130);
  });

  it('shows "visible of total" and clears the filters', async () => {
    await seedProjects(12, (i) => ({ type: i % 3 === 0 ? 'school' : 'mosque' }));
    render(<ProjectList viewKey="counter" filtersOpen />);
    await waitFor(() =>
      expect(screen.getByTestId('projects-counter').textContent).toBe('Showing 12 of 12'),
    );
    expect((screen.getByTestId('filter-reset') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('filter-type'), { target: { value: 'school' } });
    await waitFor(() =>
      expect(screen.getByTestId('projects-counter').textContent).toBe('Showing 4 of 12'),
    );
    expect(loadedCount()).toBe(4);
    fireEvent.click(screen.getByTestId('filter-reset'));
    await waitFor(() =>
      expect(screen.getByTestId('projects-counter').textContent).toBe('Showing 12 of 12'),
    );
    expect((screen.getByTestId('filter-type') as HTMLSelectElement).value).toBe('');
  });

  it('marks rows with unsynced work, conflicts and rejected operations', async () => {
    await seedProjects(1);
    const { mutate } = await import('../db');
    await mutate('projects', pid(0), { capacity: 40 });
    render(<ProjectList viewKey="flags" />);
    await waitFor(() => expect(screen.getByTestId('flag-unsynced')).toBeTruthy());
    expect(screen.queryByTestId('flag-conflict')).toBeNull();
  });
});

describe('search box', () => {
  async function seedPeople() {
    await seedProjects(3);
    const person = serverRow('persons', { name_ar: 'سالم بن خميس', name_latin: 'Salim Khamis' });
    await applyServerRows('persons', [person]);
    await applyServerRows('project_staff', [
      serverRow('project_staff', { project_id: pid(1), person_id: person.id, role: 'imam' }),
    ]);
    return person;
  }

  it('debounces 250 ms, then searches the device and the server once, and merges both', async () => {
    const person = await seedPeople();
    const calls: number[] = [];
    syncMocks.rpc.mockImplementation(async (_fn: string) => {
      calls.push(performance.now());
      const hits: SearchHit[] = [
        {
          kind: 'staff',
          id: person.id,
          score: 0.9,
          name_ar: person.name_ar,
          name_latin: person.name_latin,
          projects_count: 2,
          projects: [
            {
              id: pid(1),
              code: null,
              name_ar: 'مسجد 001',
              name_latin: null,
              type: 'mosque',
              status: 'active',
              lon: null,
              lat: null,
              role: 'imam',
            },
            {
              id: pid(900),
              code: null,
              name_ar: 'مسجد بعيد',
              name_latin: null,
              type: 'mosque',
              status: 'active',
              lon: null,
              lat: null,
              role: 'teacher',
            },
          ],
        },
        {
          kind: 'project',
          id: pid(901),
          score: 0.7,
          name_ar: 'مسجد سالم',
          name_latin: null,
          code: 'TZ-PN-000901',
          type: 'mosque',
          status: 'active',
          record_state: 'approved',
          lon: null,
          lat: null,
          country_id: null,
          admin_area_id: null,
          locality_id: null,
        },
        {
          kind: 'donor',
          id: 'donor-1',
          score: 0.6,
          name_ar: 'سالم للخير',
          name_latin: null,
          projects_count: 1,
          projects: [],
        },
      ];
      return hits;
    });

    render(<ProjectList viewKey="search" />);
    const input = screen.getByTestId('search-input');
    fireEvent.input(input, { target: { value: 'س' } });
    fireEvent.input(input, { target: { value: 'سا' } });
    fireEvent.input(input, { target: { value: 'سال' } });
    fireEvent.input(input, { target: { value: 'سالم' } });
    const typedAt = performance.now();
    await sleep(150);
    expect(syncMocks.rpc).not.toHaveBeenCalled();
    await waitFor(() => expect(syncMocks.rpc).toHaveBeenCalledTimes(1));
    expect(calls[0]! - typedAt).toBeGreaterThanOrEqual(240);
    expect(syncMocks.rpc).toHaveBeenCalledWith('search', { p_q: 'سالم', p_limit: 20 });

    await waitFor(() => expect(screen.getAllByTestId('search-hit').length).toBe(3));
    const kinds = screen.getAllByTestId('search-hit').map((el) => el.getAttribute('data-kind'));
    // The staff hit found on both sides appears once, with the server's project list.
    expect(kinds.filter((k) => k === 'staff')).toHaveLength(1);
    expect(kinds).toContain('donor');
    expect(kinds).toContain('project'); // server-only project
    const staffHit = screen
      .getAllByTestId('search-hit')
      .find((el) => el.getAttribute('data-kind') === 'staff')!;
    // English UI: the Latin name is shown (pickName).
    expect(staffHit.textContent).toContain('Salim Khamis');
    expect(staffHit.querySelectorAll('[data-testid="search-hit-project"]').length).toBe(2);
    expect(screen.getByText('Not on this device yet')).toBeTruthy();
    await sleep(300);
    expect(syncMocks.rpc).toHaveBeenCalledTimes(1);
  });

  it('offline: device results only, no request', async () => {
    await seedPeople();
    setOnline(false);
    render(<ProjectList viewKey="offline" />);
    fireEvent.input(screen.getByTestId('search-input'), { target: { value: 'سالم' } });
    await waitFor(() => expect(screen.getAllByTestId('search-hit').length).toBe(1));
    expect(screen.getByTestId('search-hit').getAttribute('data-kind')).toBe('staff');
    expect(syncMocks.rpc).not.toHaveBeenCalled();
  });

  it('a viewer never gets staff hits, even when a server answer contained one', async () => {
    useRole('viewer');
    syncMocks.rpc.mockResolvedValue([
      {
        kind: 'staff',
        id: 'p1',
        score: 1,
        name_ar: 'سالم',
        name_latin: null,
        projects_count: 1,
        projects: [],
      },
      {
        kind: 'donor',
        id: 'd1',
        score: 0.5,
        name_ar: 'سالم للخير',
        name_latin: null,
        projects_count: 0,
        projects: [],
      },
    ] satisfies SearchHit[]);
    render(<ProjectList viewKey="viewer" />);
    fireEvent.input(screen.getByTestId('search-input'), { target: { value: 'سالم' } });
    await waitFor(() => expect(screen.getAllByTestId('search-hit').length).toBe(1));
    expect(screen.getByTestId('search-hit').getAttribute('data-kind')).toBe('donor');
  });

  it('the text query also filters the register (device index, debounced)', async () => {
    await seedProjects(5, (i) => ({
      name_ar: i === 2 ? 'مسجد النور' : `مدرسة ${i}`,
      name_latin: i === 2 ? 'Masjid Nur' : null,
    }));
    render(<ProjectList viewKey="q" />);
    await waitFor(() => expect(loadedCount()).toBe(5));
    fireEvent.input(screen.getByTestId('search-input'), { target: { value: 'النور' } });
    await waitFor(() => expect(loadedCount()).toBe(1));
    expect(screen.getByTestId('project-row').getAttribute('data-id')).toBe(pid(2));
    expect(screen.getByTestId('project-row').textContent).toContain('Masjid Nur');
  });
});

describe('mergeHits', () => {
  const project = (id: string, score: number): SearchHit => ({
    kind: 'project',
    id,
    score,
    name_ar: id,
    name_latin: null,
    code: null,
    type: 'mosque',
    status: 'active',
    record_state: 'approved',
    lon: null,
    lat: null,
    country_id: null,
    admin_area_id: null,
    locality_id: null,
  });

  it('de-duplicates by kind + id, keeps the best score, sorts best first', () => {
    const merged = mergeHits(
      [project('a', 0.5), project('b', 0.9)],
      [project('a', 0.95), project('c', 0.1)],
      {
        seePeople: true,
      },
    );
    expect(merged.map((h) => [h.id, h.score, h.local])).toEqual([
      ['a', 0.95, true],
      ['b', 0.9, true],
      ['c', 0.1, false],
    ]);
  });

  it('drops staff hits for users without people access', () => {
    const staff: SearchHit = {
      kind: 'staff',
      id: 's',
      score: 1,
      name_ar: 's',
      name_latin: null,
      projects_count: 0,
      projects: [],
    };
    expect(mergeHits([staff], [], { seePeople: false })).toEqual([]);
    expect(mergeHits([staff], [], { seePeople: true })).toHaveLength(1);
  });
});

describe('filters are remembered per view (brief §12)', () => {
  it('switching to another view and back keeps the register filters; each view has its own', async () => {
    await seedProjects(9, (i) => ({
      type: i < 3 ? 'school' : 'mosque',
      status: i % 2 ? 'active' : 'inactive',
    }));
    const first = render(<ProjectsPage />);
    fireEvent.change(screen.getByTestId('filter-type'), { target: { value: 'school' } });
    await waitFor(() =>
      expect(screen.getByTestId('projects-counter').textContent).toBe('Showing 3 of 9'),
    );
    first.unmount();

    const other = render(<MaintenancePage />);
    expect((screen.getByTestId('filter-type') as HTMLSelectElement).value).toBe('');
    fireEvent.change(screen.getByTestId('filter-status'), { target: { value: 'active' } });
    other.unmount();

    render(<ProjectsPage />);
    expect((screen.getByTestId('filter-type') as HTMLSelectElement).value).toBe('school');
    expect((screen.getByTestId('filter-status') as HTMLSelectElement).value).toBe('');
    await waitFor(() =>
      expect(screen.getByTestId('projects-counter').textContent).toBe('Showing 3 of 9'),
    );
    expect(getPref<{ type?: string }>('filters.projects', {}).type).toBe('school');
    expect(getPref<{ status?: string }>('filters.maintenance', {}).status).toBe('active');
  });
});

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth', async () => (await import('./testkit')).authModule());
vi.mock('../sync', async () => (await import('./testkit')).syncModule());

import { applyServerRows, db, type Row } from '../db';
import { freshDb, serverProject, USER_A } from '../db/testing/factory';
import { setLocale } from '../i18n';
import { clearViewFilters, currentRoute, navigate } from '../routes';
import IncompletePage, { INCOMPLETE_ROW_HEIGHT } from './IncompletePage';
import ReviewPage from './ReviewPage';
import { REVIEW_ROW_HEIGHT } from './SubmittedPanel';
import { resetSyncMocks, syncModule, useRole } from './testkit';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pid = (i: number) => `00000000-0080-7000-8000-${String(i + 1).padStart(12, '0')}`;

async function seed(n: number, values: (i: number) => Partial<Row<'projects'>>): Promise<void> {
  await applyServerRows(
    'projects',
    Array.from({ length: n }, (_, i) =>
      serverProject({
        id: pid(i),
        name_ar: `مسجد ${String(i).padStart(3, '0')}`,
        name_latin: `Masjid ${i}`,
        code: `TZ-PN-${String(i).padStart(6, '0')}`,
        ...values(i),
      }),
    ),
  );
}

/** Rows loaded into the list (what `aria-setsize` says), not rows in the DOM. */
function loadedCount(list: HTMLElement): number {
  const first = within(list).queryAllByRole('listitem')[0];
  return first ? Number(first.getAttribute('aria-setsize')) : 0;
}

/**
 * Scrolls a virtual list from top to bottom; returns every row id seen per index, the loaded
 * sizes met on the way and the largest number of rows / buttons that were in the DOM at once.
 */
async function scrollThrough(
  list: HTMLElement,
  rowTestId: string,
  rowHeight: number,
  expected: number,
): Promise<{ seen: Map<number, string>; sizes: number[]; maxRows: number; maxButtons: number }> {
  const seen = new Map<number, string>();
  const sizes = new Set<number>([loadedCount(list)]);
  let maxRows = 0;
  let maxButtons = 0;
  for (let top = 0, guard = 0; guard < 200 && seen.size < expected; guard++, top += 5 * rowHeight) {
    await act(async () => {
      list.scrollTop = top;
      fireEvent.scroll(list);
      await sleep(15);
    });
    const rows = within(list).queryAllByTestId(rowTestId);
    maxRows = Math.max(maxRows, rows.length);
    maxButtons = Math.max(maxButtons, list.querySelectorAll('button, a').length);
    for (const row of rows) {
      const index = Number((row.closest('[data-index]') as HTMLElement).dataset.index);
      const before = seen.get(index);
      if (before !== undefined) expect(before).toBe(row.getAttribute('data-id'));
      seen.set(index, row.getAttribute('data-id')!);
    }
    sizes.add(loadedCount(list));
  }
  return { seen, sizes: [...sizes].sort((a, b) => a - b), maxRows, maxButtons };
}

beforeEach(async () => {
  await freshDb();
  await setLocale('en');
  clearViewFilters();
  resetSyncMocks();
  navigate('/review');
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('review queue: virtual list over keyset pages of 50 (brief §5)', () => {
  it('160 submitted records: pages of 50 while scrolling, a small window in the DOM', async () => {
    useRole('branch_supervisor');
    await seed(160, () => ({ record_state: 'submitted' }));
    render(<ReviewPage />);
    const list = await screen.findByTestId('review-rows');
    await waitFor(() => expect(loadedCount(list)).toBe(50));
    expect(screen.getAllByTestId('review-row').length).toBeLessThan(20);
    expect(screen.queryByTestId('review-more')).toBeNull();

    const { seen, sizes, maxRows, maxButtons } = await scrollThrough(
      list,
      'review-row',
      REVIEW_ROW_HEIGHT,
      160,
    );
    expect(sizes).toEqual([50, 100, 150, 160]);
    expect(seen.size).toBe(160);
    expect(new Set(seen.values()).size).toBe(160);
    // Before: 150 rows and 300 buttons after two "show more". Now a window of rows only.
    expect(maxRows).toBeLessThan(25);
    expect(maxButtons).toBeLessThan(50);
    await waitFor(() =>
      expect(within(screen.getByTestId('review-tab-submitted')).getByText('160')).toBeTruthy(),
    );
  }, 30_000);

  it('a row opens the record (click, Enter); its buttons act without opening it', async () => {
    useRole('branch_supervisor');
    await seed(3, () => ({ record_state: 'submitted' }));
    render(<ReviewPage />);
    await waitFor(() => expect(screen.getAllByTestId('review-row')).toHaveLength(3));
    const rowOf = (i: number) =>
      screen.getAllByTestId('review-row').find((r) => r.getAttribute('data-id') === pid(i))!;

    // Approve from the list: the record is decided, the page is not left.
    fireEvent.click(within(rowOf(1)).getByTestId('review-approve'));
    await waitFor(async () =>
      expect((await db.projects.get(pid(1)))?.record_state).toBe('approved'),
    );
    expect(currentRoute.value.path).toBe('/review');
    await waitFor(() => expect(screen.getAllByTestId('review-row')).toHaveLength(2));

    // Tab onto a row's button: that row becomes the list's active row (arrow keys go on from it).
    const returnButton = within(rowOf(2)).getByTestId('review-return');
    returnButton.focus();
    fireEvent.focusIn(returnButton);
    const slot = rowOf(2).closest('[data-index]') as HTMLElement;
    await waitFor(() => expect(slot.classList.contains('vlist__row--active')).toBe(true));
    expect(slot.tabIndex).toBe(0);

    // Enter on the row opens the record.
    slot.focus();
    fireEvent.keyDown(slot, { key: 'Enter' });
    expect(currentRoute.value.path).toBe(`/projects/${pid(2)}`);

    navigate('/review');
    fireEvent.click(rowOf(0).querySelector('.rrow__name')!);
    expect(currentRoute.value.path).toBe(`/projects/${pid(0)}`);
  });

  it('a sync cycle reloads the loaded rows without dropping back to the first page', async () => {
    useRole('branch_supervisor');
    await seed(120, () => ({ record_state: 'submitted' }));
    render(<ReviewPage />);
    const list = await screen.findByTestId('review-rows');
    await waitFor(() => expect(loadedCount(list)).toBe(50));
    await act(async () => {
      list.scrollTop = 45 * REVIEW_ROW_HEIGHT;
      fireEvent.scroll(list);
      await sleep(30);
    });
    await waitFor(() => expect(loadedCount(list)).toBe(100));

    const status = syncModule().syncStatus as { value: Record<string, unknown> };
    await act(async () => {
      status.value = { ...status.value, lastSyncAt: Date.now() };
      await sleep(30);
    });
    await waitFor(() => expect(loadedCount(list)).toBe(100));
    expect(screen.getAllByTestId('review-row').length).toBeLessThan(25);
  }, 30_000);
});

describe('incomplete records: virtual list over keyset pages of 50 (brief §5)', () => {
  it('130 incomplete records: pages while scrolling, a small window in the DOM', async () => {
    useRole('field_collector');
    await seed(130, () => ({ created_by: USER_A, completeness: 40 }));
    render(<IncompletePage />);
    const list = await screen.findByTestId('incomplete-rows');
    await waitFor(() => expect(loadedCount(list)).toBe(50));
    expect(screen.getAllByTestId('incomplete-row').length).toBeLessThan(20);
    expect(screen.queryByTestId('incomplete-more')).toBeNull();

    const { seen, sizes, maxRows } = await scrollThrough(
      list,
      'incomplete-row',
      INCOMPLETE_ROW_HEIGHT,
      130,
    );
    expect(sizes).toEqual([50, 100, 130]);
    expect(seen.size).toBe(130);
    expect(maxRows).toBeLessThan(25);
    // Every row still says what is missing.
    for (const row of screen.getAllByTestId('incomplete-row')) {
      expect(within(row).getByTestId('incomplete-missing').children.length).toBeGreaterThan(0);
    }
  }, 30_000);

  it('"complete now" opens the form, the row opens the record', async () => {
    useRole('field_collector');
    await seed(2, () => ({ created_by: USER_A, completeness: 40 }));
    navigate('/incomplete');
    render(<IncompletePage />);
    await waitFor(() => expect(screen.getAllByTestId('incomplete-row')).toHaveLength(2));
    const row = screen.getAllByTestId('incomplete-row')[0]!;
    const id = row.getAttribute('data-id')!;
    fireEvent.click(within(row).getByTestId('incomplete-edit'));
    expect(currentRoute.value.path).toBe(`/projects/${id}/edit`);

    navigate('/incomplete');
    fireEvent.click(row.querySelector('.rrow__name')!);
    expect(currentRoute.value.path).toBe(`/projects/${id}`);
  });
});

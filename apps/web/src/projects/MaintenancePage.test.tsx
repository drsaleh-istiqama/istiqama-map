import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth', async () => (await import('./testkit')).authModule());
vi.mock('../sync', async () => (await import('./testkit')).syncModule());

import { applyServerRows, type Row } from '../db';
import { freshDb, serverProject, serverRow } from '../db/testing/factory';
import { setLocale } from '../i18n';
import { clearViewFilters, navigate } from '../routes';
import MaintenancePage from './MaintenancePage';
import { resetSyncMocks, useRole } from './testkit';
import { useOpenMaintenanceCount } from './useOpenMaintenanceCount';

const MOSQUE = '00000000-0080-7000-8000-0000000000c1';
const SCHOOL = '00000000-0080-7000-8000-0000000000c2';

function entry(
  id: string,
  project: string,
  priority: Row<'project_maintenance'>['priority'],
  reported_on: string,
  state: Row<'project_maintenance'>['state'] = 'open',
) {
  return serverRow('project_maintenance', {
    id,
    project_id: project,
    priority,
    reported_on,
    state,
    description: `entry ${id}`,
  });
}

async function seed(): Promise<void> {
  await applyServerRows('projects', [
    serverProject({ id: MOSQUE, name_ar: 'مسجد', name_latin: 'Masjid', type: 'mosque' }),
    serverProject({ id: SCHOOL, name_ar: 'مدرسة', name_latin: 'Shule', type: 'school' }),
  ]);
  await applyServerRows('project_maintenance', [
    entry('e1', MOSQUE, 'low', '2026-09-10'),
    entry('e2', SCHOOL, 'urgent', '2026-08-01'),
    entry('e3', MOSQUE, 'high', '2026-09-05'),
    entry('e4', MOSQUE, 'urgent', '2026-09-03'),
    entry('e5', SCHOOL, 'medium', '2026-09-20', 'in_progress'),
    entry('e6', MOSQUE, 'urgent', '2026-09-25', 'done'),
  ]);
}

const order = (): string[] =>
  screen.getAllByTestId('maintenance-row').map((r) => r.getAttribute('data-id')!);

beforeEach(async () => {
  await freshDb();
  await setLocale('en');
  clearViewFilters();
  resetSyncMocks();
  useRole('field_collector');
});
afterEach(cleanup);

describe('open maintenance view', () => {
  it('lists open and in-progress entries, most urgent first, then the newest', async () => {
    await seed();
    render(<MaintenancePage />);
    await waitFor(() => expect(order()).toEqual(['e4', 'e2', 'e3', 'e5', 'e1']));
    expect(screen.getByTestId('maintenance-counter').textContent).toBe(
      'Open maintenance entries: 5',
    );
    expect(screen.getAllByTestId('maintenance-row')[0]!.textContent).toContain('Masjid');
  });

  it('filters by project fields, remembered for this view', async () => {
    await seed();
    const view = render(<MaintenancePage />);
    await waitFor(() => expect(order()).toHaveLength(5));
    fireEvent.change(screen.getByTestId('filter-type'), { target: { value: 'school' } });
    await waitFor(() => expect(order()).toEqual(['e2', 'e5']));
    view.unmount();
    render(<MaintenancePage />);
    await waitFor(() => expect(order()).toEqual(['e2', 'e5']));
    fireEvent.click(screen.getByTestId('filter-reset'));
    await waitFor(() => expect(order()).toHaveLength(5));
  });

  it('opens the project from a row', async () => {
    await seed();
    render(<MaintenancePage />);
    await waitFor(() => expect(order()).toHaveLength(5));
    fireEvent.click(screen.getAllByTestId('maintenance-row')[0]!);
    expect(window.location.pathname).toBe(`/projects/${MOSQUE}`);
  });
});

describe('useOpenMaintenanceCount', () => {
  function Badge() {
    return <span data-testid="badge">{useOpenMaintenanceCount()}</span>;
  }

  it('counts the open entries on the device and recounts on navigation', async () => {
    render(<Badge />);
    await waitFor(() => expect(screen.getByTestId('badge').textContent).toBe('0'));
    await seed();
    navigate('/maintenance');
    await waitFor(() => expect(screen.getByTestId('badge').textContent).toBe('5'));
  });
});

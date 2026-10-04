import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth', async () => (await import('./testkit')).authModule());
vi.mock('../sync', async () => (await import('./testkit')).syncModule());

import { applyServerRows } from '../db';
import { freshDb, serverRow } from '../db/testing/factory';
import { setLocale } from '../i18n';
import { clearViewFilters } from '../routes';
import { setReportsApi } from './api';
import { exportFilters, defaultChoices } from './ExportPanel';
import { downloadable, exportJobs, setFileSaver, setPolling, stopFollowing } from './exportJobs';
import ReportsPage from './ReportsPage';
import {
  dashboardFor,
  exportJob,
  FakeReportsApi,
  PEMBA,
  resetSyncMocks,
  setOnline,
  syncMocks,
  TZ,
  USER,
  useRole,
} from './testkit';

let api: FakeReportsApi;
const saved: Array<{ url: string; name: string | null }> = [];

beforeEach(async () => {
  await freshDb();
  await setLocale('en');
  clearViewFilters();
  resetSyncMocks();
  stopFollowing();
  exportJobs.value = [];
  saved.length = 0;
  setFileSaver((url, name) => saved.push({ url, name }));
  setPolling([5], 400);
  api = new FakeReportsApi();
  api.dashboard.mockImplementation(async () => dashboardFor('country_manager'));
  setReportsApi(api);
  await applyServerRows('countries', [
    serverRow('countries', { id: TZ, iso2: 'TZ', name_ar: 'تنزانيا', name_en: 'Tanzania' }),
  ]);
  await applyServerRows('branches', [
    serverRow('branches', { id: PEMBA, code: 'PEMBA', country_id: TZ, name_en: 'Pemba branch' }),
  ]);
});

afterEach(() => {
  cleanup();
  stopFollowing();
  setReportsApi(null);
  setFileSaver(null);
  setPolling([1500, 2000, 3000, 4000, 5000], 180);
  document.body.innerHTML = '';
});

async function openDialog(): Promise<HTMLElement> {
  render(<ReportsPage />);
  await screen.findByTestId('dashboard');
  fireEvent.click(screen.getByTestId('reports-export'));
  return screen.findByTestId('export-dialog');
}

describe('export filters', () => {
  it('combine the dashboard scope with the dialog choices', () => {
    const c = {
      ...defaultChoices('ar'),
      type: 'school',
      status: 'active',
      recordState: 'approved',
      openMaintenance: true,
      incomplete: true,
    };
    expect(exportFilters({ type: 'country', id: TZ }, c)).toEqual({
      country_id: TZ,
      type: 'school',
      status: 'active',
      record_state: 'approved',
      has_open_maintenance: true,
      incomplete: true,
    });
    expect(exportFilters({ type: 'global', id: null }, defaultChoices('sw'))).toEqual({});
  });

  it('dataset: projects is the server default (not sent); staff is sent', () => {
    expect(defaultChoices('ar').dataset).toBe('projects');
    expect(
      exportFilters({ type: 'branch', id: PEMBA }, { ...defaultChoices('ar'), dataset: 'staff' }),
    ).toEqual({ branch_id: PEMBA, dataset: 'staff' });
  });

  it('a link is downloadable until it expires', () => {
    expect(downloadable({ storage_path: 'a', expires_at: null })).toBe(true);
    expect(downloadable({ storage_path: 'a', expires_at: '2000-01-01T00:00:00Z' })).toBe(false);
    expect(downloadable({ storage_path: null, expires_at: null })).toBe(false);
  });
});

describe('export dialog → function → polling → download', () => {
  it('runs the whole flow', async () => {
    useRole('country_manager');
    const dialog = await openDialog();
    // Default: XLSX in the interface language.
    expect((within(dialog).getByTestId('export-format-xlsx') as HTMLInputElement).checked).toBe(
      true,
    );
    expect((within(dialog).getByTestId('export-lang-en') as HTMLInputElement).checked).toBe(true);
    expect(within(dialog).getByTestId('export-scope').textContent).toContain('Tanzania');
    expect(within(dialog).getByTestId('export-salary-note').dataset.restricted).toBe('true');

    fireEvent.click(within(dialog).getByTestId('export-format-csv'));
    fireEvent.click(within(dialog).getByTestId('export-lang-sw'));
    fireEvent.change(within(dialog).getByTestId('export-filter-type'), {
      target: { value: 'school' },
    });
    fireEvent.click(within(dialog).getByTestId('export-filter-maintenance'));
    fireEvent.click(within(dialog).getByTestId('export-submit'));

    await waitFor(() => expect(api.exportStart).toHaveBeenCalledWith('job-1'));
    expect(api.exportRequest).toHaveBeenCalledWith({
      format: 'csv',
      lang: 'sw',
      filters: { country_id: TZ, type: 'school', has_open_maintenance: true },
    });
    await waitFor(() => expect(screen.queryByTestId('export-dialog')).toBeNull());

    // The job shows up and is followed.
    const row = await screen.findByTestId('export-job-row');
    expect(row.dataset.state).toBe('queued');
    api.setJob('job-1', { state: 'running' });
    await waitFor(() => expect(screen.getByTestId('export-job-row').dataset.state).toBe('running'));
    expect(screen.queryByTestId('export-download')).toBeNull();

    api.setJob('job-1', {
      state: 'done',
      storage_path: `${USER}/job-1.csv`,
      file_name: 'istiqama-projects-2026-10-04.csv',
      row_count: 12,
      bytes: 4096,
      expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
    });
    await waitFor(() => expect(screen.getByTestId('export-job-row').dataset.state).toBe('done'));
    // The export.ready notification is pulled for the bell.
    await waitFor(() => expect(syncMocks.syncNow).toHaveBeenCalled());
    expect(screen.getByTestId('export-job-row').textContent).toContain('12 rows');

    fireEvent.click(screen.getByTestId('export-download'));
    await waitFor(() => expect(saved).toHaveLength(1));
    // the download URL is issued by the export function for the job, never signed here
    expect(api.exportDownloadUrl).toHaveBeenCalledWith('job-1');
    expect(saved[0]).toEqual({
      url: `https://storage.test/sign/${USER}/job-1.csv?token=t`,
      name: 'istiqama-projects-2026-10-04.csv',
    });
  });

  it('staff table: offered with people scope; CSV staff export sends dataset = staff', async () => {
    useRole('branch_supervisor');
    const dialog = await openDialog();
    expect(within(dialog).getByTestId('export-dataset')).toBeTruthy();
    expect(
      (within(dialog).getByTestId('export-dataset-projects') as HTMLInputElement).checked,
    ).toBe(true);
    // XLSX of projects: the workbook carries a second Staff sheet
    expect(within(dialog).getByTestId('export-dataset-hint').textContent).toContain(
      'second Staff sheet',
    );
    fireEvent.click(within(dialog).getByTestId('export-format-csv'));
    expect(within(dialog).getByTestId('export-dataset-hint').textContent).toContain('one table');
    fireEvent.click(within(dialog).getByTestId('export-dataset-staff'));
    expect(within(dialog).getByTestId('export-dataset-hint').textContent).toContain(
      'One row per current assignment',
    );
    fireEvent.click(within(dialog).getByTestId('export-submit'));
    await waitFor(() => expect(api.exportRequest).toHaveBeenCalled());
    expect(api.exportRequest).toHaveBeenCalledWith({
      format: 'csv',
      lang: 'en',
      filters: expect.objectContaining({ dataset: 'staff' }),
    });
  });

  it('viewer: no staff table choice, and a kept staff choice is never sent', async () => {
    useRole('viewer');
    api.dashboard.mockImplementation(async () => dashboardFor('viewer'));
    const dialog = await openDialog();
    expect(within(dialog).queryByTestId('export-dataset')).toBeNull();
    fireEvent.click(within(dialog).getByTestId('export-submit'));
    await waitFor(() => expect(api.exportRequest).toHaveBeenCalled());
    const filters = api.exportRequest.mock.calls[0]![0].filters as Record<string, unknown>;
    expect(filters.dataset).toBeUndefined();
  });

  it('keeps the choices when the dialog is closed with Esc', async () => {
    useRole('viewer');
    api.dashboard.mockImplementation(async () => dashboardFor('viewer'));
    const dialog = await openDialog();
    expect(within(dialog).getByTestId('export-salary-note').dataset.restricted).toBe('false');
    fireEvent.click(within(dialog).getByTestId('export-format-csv'));
    fireEvent.change(within(dialog).getByTestId('export-filter-status'), {
      target: { value: 'maintenance' },
    });
    fireEvent.keyDown(document.activeElement ?? dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('export-dialog')).toBeNull());
    fireEvent.click(screen.getByTestId('reports-export'));
    const again = await screen.findByTestId('export-dialog');
    expect((within(again).getByTestId('export-format-csv') as HTMLInputElement).checked).toBe(true);
    expect((within(again).getByTestId('export-filter-status') as HTMLSelectElement).value).toBe(
      'maintenance',
    );
    expect(api.exportRequest).not.toHaveBeenCalled();
  });

  it('defaults the file language to the interface language', async () => {
    await setLocale('sw');
    useRole('viewer');
    api.dashboard.mockImplementation(async () => dashboardFor('viewer'));
    const dialog = await openDialog();
    expect((within(dialog).getByTestId('export-lang-sw') as HTMLInputElement).checked).toBe(true);
  });

  it('refuses to start offline and says why', async () => {
    useRole('viewer');
    api.dashboard.mockImplementation(async () => dashboardFor('viewer'));
    const dialog = await openDialog();
    setOnline(false);
    fireEvent.click(within(dialog).getByTestId('export-submit'));
    expect((await within(dialog).findByTestId('export-error')).textContent).toContain(
      'internet connection',
    );
    expect(api.exportRequest).not.toHaveBeenCalled();
  });

  it('shows a rate-limit refusal inside the dialog', async () => {
    useRole('viewer');
    api.dashboard.mockImplementation(async () => dashboardFor('viewer'));
    const { ReportsApiError } = await import('./api');
    api.exportRequest.mockImplementation(async () => {
      throw new ReportsApiError('PT429', 'rate limit exceeded');
    });
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByTestId('export-submit'));
    expect((await within(dialog).findByTestId('export-error')).textContent).toContain(
      'Too many requests',
    );
  });

  it('a failed start leaves a queued job that can be resumed', async () => {
    useRole('viewer');
    api.dashboard.mockImplementation(async () => dashboardFor('viewer'));
    api.exportStart.mockImplementationOnce(async () => {
      throw new Error('network');
    });
    setPolling([5], 2);
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByTestId('export-submit'));
    const resume = await screen.findByTestId('export-resume', {}, { timeout: 3000 });
    fireEvent.click(resume);
    await waitFor(() => expect(api.exportStart).toHaveBeenCalledTimes(2));
  });
});

describe('past exports', () => {
  it('lists the own jobs with their state; only live files can be downloaded', async () => {
    useRole('viewer');
    api.dashboard.mockImplementation(async () => dashboardFor('viewer'));
    const done = exportJob({
      id: 'a',
      state: 'done',
      storage_path: `${USER}/a.xlsx`,
      file_name: 'a.xlsx',
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      created_at: '2026-10-04T09:00:00Z',
      filters: { country_id: TZ, type: 'mosque' },
    });
    const old = exportJob({
      id: 'b',
      state: 'expired',
      storage_path: `${USER}/b.csv`,
      format: 'csv',
      created_at: '2026-09-01T09:00:00Z',
    });
    const failed = exportJob({ id: 'c', state: 'failed', created_at: '2026-10-03T09:00:00Z' });
    const fallback = exportJob({
      id: 'd',
      state: 'done',
      storage_path: `${USER}/d.csv`,
      stats: { fallback: { from: 'xlsx', to: 'csv' } },
      created_at: '2026-10-02T09:00:00Z',
    });
    const staff = exportJob({
      id: 'e',
      state: 'done',
      format: 'csv',
      storage_path: `${USER}/e.csv`,
      filters: { dataset: 'staff' },
      row_count: 7,
      stats: { dataset: 'staff' },
      created_at: '2026-10-04T08:00:00Z',
    });
    const workbook = exportJob({
      id: 'f',
      state: 'done',
      storage_path: `${USER}/f.xlsx`,
      row_count: 3,
      stats: { staff_rows: 5 },
      created_at: '2026-10-04T07:00:00Z',
    });
    const omitted = exportJob({
      id: 'g',
      state: 'done',
      storage_path: `${USER}/g.csv`,
      stats: { fallback: { from: 'xlsx', to: 'csv', staff_omitted: true } },
      created_at: '2026-10-04T06:00:00Z',
    });
    for (const j of [done, old, failed, fallback, staff, workbook, omitted]) api.jobs.set(j.id, j);
    render(<ReportsPage />);
    await waitFor(() => expect(screen.getAllByTestId('export-job-row')).toHaveLength(7));
    const all = screen.getAllByTestId('export-job-row');
    const byId = (id: string): HTMLElement => all.find((r) => r.dataset.id === id)!;
    expect(byId('e').textContent).toContain('Staff');
    expect(within(byId('f')).getByTestId('export-job-staff-rows').textContent).toBe('5 staff rows');
    expect(within(byId('g')).getByTestId('export-fallback').textContent).toContain(
      'Staff sheet was left out',
    );
    expect(within(byId('a')).queryByTestId('export-job-staff-rows')).toBeNull();
    const rows = all.filter((r) => ['a', 'b', 'c', 'd'].includes(r.dataset.id ?? ''));
    expect(rows.map((r) => r.dataset.id)).toEqual(['a', 'c', 'd', 'b']);
    expect(within(rows[0]!).getByTestId('export-download')).toBeTruthy();
    expect(rows[0]!.textContent).toContain('Tanzania');
    expect(within(rows[3]!).queryByTestId('export-download')).toBeNull();
    expect(rows[1]!.textContent).toContain('could not be created');
    expect(within(rows[2]!).getByTestId('export-fallback')).toBeTruthy();
  });

  it('cancels an active job', async () => {
    useRole('viewer');
    api.dashboard.mockImplementation(async () => dashboardFor('viewer'));
    const running = exportJob({ id: 'r', state: 'running' });
    api.jobs.set('r', running);
    setPolling([60_000], 1);
    render(<ReportsPage />);
    fireEvent.click(await screen.findByTestId('export-cancel'));
    await waitFor(() => expect(api.exportCancel).toHaveBeenCalledWith('r'));
    await waitFor(() =>
      expect(screen.getByTestId('export-job-row').dataset.state).toBe('cancelled'),
    );
  });
});

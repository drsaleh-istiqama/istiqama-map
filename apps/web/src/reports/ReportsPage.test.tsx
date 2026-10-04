import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

vi.mock('../auth', async () => (await import('./testkit')).authModule());
vi.mock('../sync', async () => (await import('./testkit')).syncModule());

import { applyServerRows, saveAppSettings } from '../db';
import { freshDb, serverRow } from '../db/testing/factory';
import { setLocale } from '../i18n';
import { getPref } from '../lib/prefs';
import { clearViewFilters, currentRoute } from '../routes';
import { setReportsApi } from './api';
import { readCachedDashboard, writeCachedDashboard } from './cache';
import { exportJobs, stopFollowing } from './exportJobs';
import ReportsPage from './ReportsPage';
import {
  countryReportFor,
  dashboardFor,
  FakeReportsApi,
  PEMBA,
  resetSyncMocks,
  setOnline,
  syncError,
  TZ,
  USER,
  useRole,
} from './testkit';

let api: FakeReportsApi;

async function seedReference(): Promise<void> {
  await applyServerRows('countries', [
    serverRow('countries', { id: TZ, iso2: 'TZ', name_ar: 'تنزانيا', name_en: 'Tanzania' }),
  ]);
  await applyServerRows('branches', [
    serverRow('branches', {
      id: PEMBA,
      code: 'PEMBA',
      country_id: TZ,
      name_ar: 'فرع بيمبا',
      name_en: 'Pemba branch',
    }),
  ]);
}

beforeEach(async () => {
  await freshDb();
  await setLocale('en');
  clearViewFilters();
  resetSyncMocks();
  stopFollowing();
  exportJobs.value = [];
  api = new FakeReportsApi();
  setReportsApi(api);
  await seedReference();
});

afterEach(() => {
  cleanup();
  setReportsApi(null);
  stopFollowing();
  document.body.innerHTML = '';
});

async function openPage(): Promise<HTMLElement> {
  render(<ReportsPage />);
  return screen.findByTestId('dashboard');
}

describe('dashboard per role', () => {
  it('viewer: global scope, totals and needs, but no person names anywhere', async () => {
    useRole('viewer');
    api.dashboard.mockImplementation(async () => dashboardFor('viewer'));
    const dash = await openPage();
    expect(api.dashboard).toHaveBeenCalledWith({ type: 'global', id: null });
    expect(within(dash).getByTestId('kpi-projects').textContent).toContain('33');
    expect(within(dash).getByTestId('dash-by-type').querySelectorAll('li')).toHaveLength(3);
    expect(within(dash).getByTestId('need-quran').textContent).toContain('1,120');
    expect(within(dash).getByTestId('dash-collectors-hidden')).toBeTruthy();
    expect(within(dash).queryByTestId('dash-collectors')).toBeNull();
    expect(within(dash).queryByTestId('dash-payroll')).toBeNull();
    expect(dash.textContent).not.toContain('Salim');
    // Global readers see the regional tables.
    expect(within(dash).getAllByTestId('region-row').length).toBeGreaterThan(0);
  });

  it('viewer: names stay hidden even if a payload carried them', async () => {
    useRole('viewer');
    api.dashboard.mockImplementation(async () => dashboardFor('field_collector'));
    const dash = await openPage();
    expect(dash.textContent).not.toContain('Salim Collector');
    expect(within(dash).getByTestId('dash-collectors-hidden')).toBeTruthy();
  });

  it('collector: branch scope, collector activity with names, no payroll', async () => {
    useRole('field_collector');
    api.dashboard.mockImplementation(async () =>
      dashboardFor('field_collector', {
        type: 'branch',
        id: PEMBA,
        code: 'PEMBA',
        name_en: 'Pemba branch',
      }),
    );
    const dash = await openPage();
    expect(api.dashboard).toHaveBeenCalledWith({ type: 'branch', id: PEMBA });
    const scope = screen.getByTestId('reports-scope') as HTMLSelectElement;
    expect([...scope.options].map((o) => o.value)).toEqual([`branch:${PEMBA}`]);
    expect(within(dash).getAllByTestId('dash-collector-row')).toHaveLength(2);
    expect(within(dash).getByTestId('dash-collectors').textContent).toContain('Salim Collector');
    expect(within(dash).queryByTestId('dash-payroll')).toBeNull();
    expect(within(dash).getByTestId('dash-weeks').querySelectorAll('.rweeks__col')).toHaveLength(
      12,
    );
  });

  it('manager: payroll per currency, USD total, missing rate and the FX placeholder notice', async () => {
    useRole('country_manager');
    await saveAppSettings([
      { key: 'fx.placeholder', value: { placeholder: true, effective_date: '2025-01-01' } },
    ]);
    api.dashboard.mockImplementation(async () => countryReportFor('country_manager'));
    const dash = await openPage();
    expect(api.dashboard).toHaveBeenCalledWith({ type: 'country', id: TZ });
    const rows = within(dash).getAllByTestId('dash-payroll-row');
    expect(rows.map((r) => r.dataset.currency)).toEqual(['TZS', 'KES', 'XAF']);
    expect(rows[0]!.querySelector('[data-testid="dash-payroll-local"]')!.textContent).toMatch(
      /TZS\s?6,040,000/,
    );
    expect(rows[2]!.textContent).toContain('No exchange rate');
    expect(within(dash).getByTestId('dash-payroll-usd').textContent).toMatch(/USD\s?2,526\.20/);
    expect(within(dash).getByTestId('dash-missing-rates').textContent).toContain('XAF');
    await waitFor(() => expect(within(dash).getByTestId('dash-fx-notice')).toBeTruthy());
  });

  it('manager without the placeholder flag: no FX notice', async () => {
    useRole('country_manager');
    await saveAppSettings([{ key: 'fx.placeholder', value: { placeholder: false } }]);
    api.dashboard.mockImplementation(async () => dashboardFor('country_manager'));
    const dash = await openPage();
    expect(within(dash).getByTestId('dash-payroll')).toBeTruthy();
    expect(within(dash).queryByTestId('dash-fx-notice')).toBeNull();
  });

  it('switches scope and remembers the choice', async () => {
    useRole('country_manager');
    api.dashboard.mockImplementation(async (scope) =>
      scope.type === 'branch'
        ? dashboardFor('country_manager', { type: 'branch', id: PEMBA })
        : dashboardFor('country_manager'),
    );
    await openPage();
    fireEvent.change(screen.getByTestId('reports-scope'), { target: { value: `branch:${PEMBA}` } });
    await waitFor(() =>
      expect(api.dashboard).toHaveBeenLastCalledWith({ type: 'branch', id: PEMBA }),
    );
    expect(getPref<{ scope: string }>('filters.reports', { scope: '' }).scope).toBe(
      `branch:${PEMBA}`,
    );
  });

  it('shows the time the figures were computed and the heat-map links open the map', async () => {
    useRole('hq_admin');
    api.dashboard.mockImplementation(async () => dashboardFor('hq_admin'));
    await openPage();
    const fresh = screen.getByTestId('reports-freshness');
    expect(fresh.dataset.source).toBe('live');
    expect(fresh.dataset.refreshed).toBe('2026-10-04T16:51:45.110089+00:00');
    fireEvent.click(screen.getAllByTestId('heat-link-quran_need')[0]!);
    expect(getPref('map.heat', null)).toBe('quran_need');
    expect(currentRoute.value.path).toBe('/map');
  });

  it('explains a refused scope instead of showing figures', async () => {
    useRole('viewer');
    api.dashboard.mockImplementation(async () => {
      throw syncError('forbidden');
    });
    render(<ReportsPage />);
    expect((await screen.findByTestId('reports-error')).textContent).toContain('not allowed');
    expect(screen.queryByTestId('dashboard')).toBeNull();
  });

  it('a user without any read scope gets an explanation and no request', async () => {
    useRole('viewer', { read: { all: false, countries: [], branches: [] } });
    render(<ReportsPage />);
    expect(await screen.findByTestId('reports-no-scope')).toBeTruthy();
    expect(api.dashboard).not.toHaveBeenCalled();
  });
});

describe('offline', () => {
  it('stores the live figures and shows them offline with their dates', async () => {
    useRole('viewer');
    api.dashboard.mockImplementation(async () => dashboardFor('viewer'));
    await openPage();
    await waitFor(async () =>
      expect(
        await readCachedDashboard(USER, 'epoch-1', { type: 'global', id: null }),
      ).not.toBeNull(),
    );
    cleanup();

    setOnline(false);
    api.dashboard.mockClear();
    const dash = await openPage();
    expect(api.dashboard).not.toHaveBeenCalled();
    expect(within(dash).getByTestId('kpi-projects').textContent).toContain('33');
    expect(screen.getByTestId('reports-offline').textContent).toContain('last copy saved');
    const fresh = screen.getByTestId('reports-freshness');
    expect(fresh.dataset.source).toBe('cache');
    expect(fresh.textContent).toContain('Figures computed on');
    expect(fresh.textContent).toContain('Saved on this device');
    expect((screen.getByTestId('reports-refresh') as HTMLButtonElement).disabled).toBe(true);
  });

  it('offline without a saved copy: a clear message, no request', async () => {
    useRole('viewer');
    setOnline(false);
    render(<ReportsPage />);
    expect(await screen.findByTestId('reports-empty-offline')).toBeTruthy();
    expect(api.dashboard).not.toHaveBeenCalled();
  });

  it('a cached copy of another scope epoch is not shown (roles changed)', async () => {
    useRole('country_manager', { epoch: 'epoch-2' });
    await writeCachedDashboard(
      USER,
      'epoch-1',
      { type: 'country', id: TZ },
      dashboardFor('country_manager'),
    );
    setOnline(false);
    render(<ReportsPage />);
    expect(await screen.findByTestId('reports-empty-offline')).toBeTruthy();
    expect(screen.queryByTestId('dash-payroll')).toBeNull();
  });

  it('refreshes when the connection comes back', async () => {
    useRole('viewer');
    await writeCachedDashboard(
      USER,
      'epoch-1',
      { type: 'global', id: null },
      dashboardFor('viewer'),
    );
    setOnline(false);
    await openPage();
    expect(api.dashboard).not.toHaveBeenCalled();
    setOnline(true, true);
    await waitFor(() => expect(api.dashboard).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId('reports-freshness').dataset.source).toBe('live'),
    );
  });
});

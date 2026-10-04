import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth', async () => (await import('./testkit')).authModule());
vi.mock('../sync', async () => (await import('./testkit')).syncModule());

import { freshDb } from '../db/testing/factory';
import { setLocale } from '../i18n';
import { setPhotoStorage, type PhotoStorage } from '../photos/storage';
import { navigate } from '../routes';
import { setReportsApi } from './api';
import { clearShapeCache } from './AreaMap';
import PrintPage from './PrintPage';
import { printPath } from './paths';
import {
  countryReportFor,
  DONOR,
  donorReport,
  FakeReportsApi,
  PROJECT,
  projectReportFor,
  resetSyncMocks,
  setOnline,
  syncError,
  TZ,
  useRole,
} from './testkit';

let api: FakeReportsApi;

const photoStorage: PhotoStorage = {
  downloadThumb: vi.fn(async () => {
    throw new Error('no thumbs in tests');
  }),
  signFull: vi.fn(async (path: string) => `https://photos.test/${path}?token=t`),
  cachedThumb: vi.fn(async () => null),
};

beforeEach(async () => {
  await freshDb();
  await setLocale('ar');
  resetSyncMocks();
  clearShapeCache();
  setPhotoStorage(photoStorage);
  api = new FakeReportsApi();
  setReportsApi(api);
});

afterEach(() => {
  cleanup();
  setReportsApi(null);
  setPhotoStorage(null);
  navigate('/');
  document.body.innerHTML = '';
});

async function openPrint(kind: 'project' | 'donor' | 'country', id: string): Promise<HTMLElement> {
  navigate(printPath(kind, id));
  render(<PrintPage />);
  return screen.findByTestId('print-doc');
}

describe('project card', () => {
  it('Arabic, right to left, with every section and the report RPC of the project', async () => {
    useRole('field_collector');
    api.report.mockImplementation(async () => projectReportFor('field_collector'));
    const doc = await openPrint('project', PROJECT);

    expect(api.report).toHaveBeenCalledWith('project', PROJECT);
    expect(doc.getAttribute('dir')).toBe('rtl');
    expect(doc.getAttribute('lang')).toBe('ar');
    expect(doc.dataset.kind).toBe('project');
    // Running header / footer of every printed page.
    expect(doc.querySelector('thead .phead')).toBeTruthy();
    expect(doc.querySelector('tfoot .pfoot')).toBeTruthy();

    expect(within(doc).getByTestId('print-code').textContent).toBe('TZ-TG-000024');
    expect(within(doc).getByTestId('print-status')).toBeTruthy();
    for (const id of [
      'facts',
      'land',
      'facilities',
      'community',
      'staff',
      'maintenance',
      'donors',
    ]) {
      expect(within(doc).getByTestId(`print-section-${id}`)).toBeTruthy();
    }
    expect(within(doc).getAllByTestId('print-maintenance-row')).toHaveLength(1);
    // Cover photo (signed full size) and the gallery of the other photos.
    const cover = await waitFor(() => {
      const img = within(doc).getByTestId('print-cover').querySelector('img');
      expect(img).toBeTruthy();
      return img as HTMLImageElement;
    });
    expect(cover.getAttribute('src')).toContain('TZ/p/ph1.webp');
    expect(within(doc).getByTestId('print-gallery').querySelectorAll('li')).toHaveLength(1);

    // Collector: names of the staff, the hidden person, but no salaries and no salary option.
    const rows = within(doc).getAllByTestId('print-staff-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('بكر محمد');
    expect(within(doc).queryByTestId('print-salary')).toBeNull();
    expect(screen.queryByTestId('print-show-salaries')).toBeNull();
    expect(doc.textContent).not.toContain('340');
  });

  it('viewer: staff count only, no person names, no owner name', async () => {
    useRole('viewer');
    api.report.mockImplementation(async () => projectReportFor('viewer'));
    const doc = await openPrint('project', PROJECT);
    expect(within(doc).getByTestId('print-staff-count')).toBeTruthy();
    expect(within(doc).queryByTestId('print-staff')).toBeNull();
    expect(doc.textContent).not.toContain('Salim');
    expect(doc.textContent).not.toContain('Waqf committee');
    expect(screen.queryByTestId('print-show-salaries')).toBeNull();
  });

  it('country manager: salaries are printed only after choosing to include them', async () => {
    useRole('country_manager');
    api.report.mockImplementation(async () => projectReportFor('country_manager'));
    const doc = await openPrint('project', PROJECT);
    expect(within(doc).queryByTestId('print-salary')).toBeNull();
    const toggle = screen.getByTestId('print-show-salaries') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    const cells = await within(doc).findAllByTestId('print-salary');
    expect(cells).toHaveLength(2);
    expect(cells[0]!.textContent).toMatch(/[٣3]/);
  });

  it('location snapshot: the point inside the outline of its district, no tiles', async () => {
    useRole('field_collector');
    api.report.mockImplementation(async () => projectReportFor('field_collector'));
    api.adminAreaShapes.mockImplementation(async () => ({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { id: 'a2' },
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [38.9, -5.1],
                [39.0, -5.1],
                [39.0, -5.0],
                [38.9, -5.0],
                [38.9, -5.1],
              ],
            ],
          },
        },
      ],
    }));
    const doc = await openPrint('project', PROJECT);
    expect(await within(doc).findByTestId('print-map-area')).toBeTruthy();
    expect(within(doc).getByTestId('print-map-point')).toBeTruthy();
    expect(api.adminAreaShapes).toHaveBeenCalledWith(TZ, 2);
    expect(doc.querySelector('[data-testid="print-map"] img')).toBeNull();
  });

  it('print button calls window.print()', async () => {
    useRole('viewer');
    api.report.mockImplementation(async () => projectReportFor('viewer'));
    const print = vi.fn();
    const original = Object.getOwnPropertyDescriptor(window, 'print');
    Object.defineProperty(window, 'print', { configurable: true, writable: true, value: print });
    try {
      await openPrint('project', PROJECT);
      fireEvent.click(screen.getByTestId('print-button'));
      expect(print).toHaveBeenCalledTimes(1);
    } finally {
      if (original) Object.defineProperty(window, 'print', original);
      else delete (window as { print?: unknown }).print;
    }
  });

  it('English: left to right', async () => {
    await setLocale('en');
    useRole('viewer');
    api.report.mockImplementation(async () => projectReportFor('viewer'));
    const doc = await openPrint('project', PROJECT);
    expect(doc.getAttribute('dir')).toBe('ltr');
    expect(doc.getAttribute('lang')).toBe('en');
  });
});

describe('donor and country reports', () => {
  it('donor report lists the projects of the donor', async () => {
    useRole('viewer');
    api.report.mockImplementation(async () => donorReport());
    const doc = await openPrint('donor', DONOR);
    expect(api.report).toHaveBeenCalledWith('donor', DONOR);
    expect(within(doc).getByTestId('print-donor')).toBeTruthy();
    expect(within(doc).getAllByTestId('print-donor-project')).toHaveLength(1);
  });

  it('country report: dashboard + branch table; payroll only for restricted roles and on request', async () => {
    useRole('branch_supervisor');
    api.report.mockImplementation(async () => countryReportFor('branch_supervisor'));
    let doc = await openPrint('country', TZ);
    expect(within(doc).getByTestId('print-country')).toBeTruthy();
    expect(within(doc).getByTestId('print-section-dashboard')).toBeTruthy();
    expect(within(doc).getAllByTestId('print-branch-row').length).toBeGreaterThan(0);
    expect(within(doc).queryByTestId('dash-payroll')).toBeNull();
    expect(within(doc).queryByTestId('print-branch-payroll')).toBeNull();
    expect(screen.queryByTestId('print-show-salaries')).toBeNull();
    cleanup();

    useRole('country_manager');
    api.report.mockImplementation(async () => countryReportFor('country_manager'));
    doc = await openPrint('country', TZ);
    expect(within(doc).queryByTestId('dash-payroll')).toBeNull();
    fireEvent.click(screen.getByTestId('print-show-salaries'));
    await waitFor(() => expect(within(doc).getByTestId('dash-payroll')).toBeTruthy());
  });
});

describe('states', () => {
  it('offline: a clear message and no server call', async () => {
    setOnline(false);
    useRole('viewer');
    navigate(printPath('project', PROJECT));
    render(<PrintPage />);
    expect(await screen.findByTestId('print-offline')).toBeTruthy();
    expect(api.report).not.toHaveBeenCalled();
    expect((screen.getByTestId('print-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('unknown kind', async () => {
    useRole('viewer');
    navigate('/reports/print/invoice/x');
    render(<PrintPage />);
    expect(await screen.findByTestId('print-error')).toBeTruthy();
    expect(api.report).not.toHaveBeenCalled();
  });

  it('not found: an error with a retry', async () => {
    useRole('viewer');
    api.report.mockImplementation(async () => {
      throw syncError('not_found');
    });
    navigate(printPath('project', PROJECT));
    render(<PrintPage />);
    expect(await screen.findByTestId('print-error')).toBeTruthy();
    api.report.mockImplementation(async () => projectReportFor('viewer'));
    fireEvent.click(screen.getByTestId('print-retry'));
    expect(await screen.findByTestId('print-doc')).toBeTruthy();
  });
});

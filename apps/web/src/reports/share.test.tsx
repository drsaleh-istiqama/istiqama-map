import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth', async () => (await import('./testkit')).authModule());
vi.mock('../sync', async () => (await import('./testkit')).syncModule());

const shareMock = vi.hoisted(() => ({ sharePdf: vi.fn() }));
vi.mock('./share', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./share')>()),
  sharePdf: shareMock.sharePdf,
}));

import { freshDb } from '../db/testing/factory';
import { setLocale } from '../i18n';
import { navigate } from '../routes';
import { setReportsApi } from './api';
import PrintPage from './PrintPage';
import { printPath } from './paths';
import { mailUrl, pdfFileName, whatsappUrl } from './share';
import { FakeReportsApi, PROJECT, projectReportFor, resetSyncMocks, useRole } from './testkit';

let api: FakeReportsApi;

beforeEach(async () => {
  await freshDb();
  await setLocale('ar');
  resetSyncMocks();
  useRole('hq_admin');
  api = new FakeReportsApi();
  api.report.mockImplementation(async () => projectReportFor('hq_admin'));
  setReportsApi(api);
  shareMock.sharePdf.mockReset();
});

afterEach(() => {
  cleanup();
  setReportsApi(null);
  navigate('/');
});

describe('share helpers', () => {
  it('keeps Arabic in the file name and drops characters no file system accepts', () => {
    expect(pdfFileName('بطاقة مشروع — TZ/PS:000035?')).toBe('بطاقة مشروع — TZ PS 000035.pdf');
    expect(pdfFileName('')).toBe('report.pdf');
  });

  it('WhatsApp and e-mail links carry the message, encoded', () => {
    expect(whatsappUrl('جامع & مدرسة')).toBe(
      `https://wa.me/?text=${encodeURIComponent('جامع & مدرسة')}`,
    );
    expect(mailUrl('ع', 'نص')).toBe(
      `mailto:?subject=${encodeURIComponent('ع')}&body=${encodeURIComponent('نص')}`,
    );
  });
});

describe('share button of the print view', () => {
  it('phone: the share sheet took the PDF — no dialog', async () => {
    shareMock.sharePdf.mockResolvedValue('shared');
    navigate(printPath('project', PROJECT));
    render(<PrintPage />);
    await screen.findByTestId('print-doc');
    fireEvent.click(screen.getByTestId('print-share'));
    await waitFor(() => expect(shareMock.sharePdf).toHaveBeenCalledTimes(1));
    const [el, title] = shareMock.sharePdf.mock.calls[0] as [HTMLElement, string];
    expect(el.getAttribute('data-testid')).toBe('print-doc');
    expect(title).toContain('بطاقة');
    expect(screen.queryByTestId('share-dialog')).toBeNull();
  });

  it('computer: the PDF was downloaded — WhatsApp and e-mail are offered', async () => {
    shareMock.sharePdf.mockResolvedValue('downloaded');
    navigate(printPath('project', PROJECT));
    render(<PrintPage />);
    await screen.findByTestId('print-doc');
    fireEvent.click(screen.getByTestId('print-share'));
    await screen.findByTestId('share-dialog');
    expect(screen.getByTestId('share-whatsapp').getAttribute('href')).toMatch(
      /^https:\/\/wa\.me\/\?text=/,
    );
    expect(screen.getByTestId('share-email').getAttribute('href')).toMatch(/^mailto:\?subject=/);
  });
});

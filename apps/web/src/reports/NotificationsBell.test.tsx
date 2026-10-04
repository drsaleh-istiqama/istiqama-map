import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth', async () => (await import('./testkit')).authModule());
vi.mock('../sync', async () => (await import('./testkit')).syncModule());

import { applyServerRows, db } from '../db';
import { freshDb, serverRow } from '../db/testing/factory';
import { setLocale } from '../i18n';
import { setReportsApi } from './api';
import { setFileSaver } from './exportJobs';
import { NotificationsBell } from './NotificationsBell';
import { listNotifications, markRead, unreadCount } from './notifications';
import { FakeReportsApi, resetSyncMocks, setOnline, USER, useRole } from './testkit';

let api: FakeReportsApi;
const saved: Array<{ url: string; name: string | null }> = [];

const READY = '0b000000-0000-4000-8000-0000000000a1';
const FAILED = '0b000000-0000-4000-8000-0000000000a2';
const OLD = '0b000000-0000-4000-8000-0000000000a3';

async function seed(): Promise<void> {
  const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
  await applyServerRows('notifications', [
    serverRow('notifications', {
      id: READY,
      user_id: USER,
      kind: 'export.ready',
      created_at: '2026-10-04T10:00:00Z',
      payload: {
        job_id: 'job-1',
        format: 'xlsx',
        lang: 'ar',
        bucket: 'exports',
        storage_path: `${USER}/job-1.xlsx`,
        file_name: 'projects-2026-10-04.xlsx',
        bytes: 20480,
        row_count: 33,
        expires_at: future,
      },
    }),
    serverRow('notifications', {
      id: FAILED,
      user_id: USER,
      kind: 'export.failed',
      created_at: '2026-10-04T09:00:00Z',
      payload: { job_id: 'job-2', format: 'csv', lang: 'en', error: 'boom' },
    }),
    serverRow('notifications', {
      id: OLD,
      user_id: USER,
      kind: 'export.ready',
      created_at: '2026-09-01T09:00:00Z',
      read_at: '2026-09-01T10:00:00Z',
      payload: {
        job_id: 'job-0',
        format: 'csv',
        storage_path: `${USER}/job-0.csv`,
        expires_at: '2026-09-08T09:00:00Z',
      },
    }),
  ]);
}

beforeEach(async () => {
  await freshDb();
  await setLocale('en');
  resetSyncMocks();
  useRole('field_collector');
  api = new FakeReportsApi();
  setReportsApi(api);
  saved.length = 0;
  setFileSaver((url, name) => saved.push({ url, name }));
  await seed();
});

afterEach(() => {
  cleanup();
  setReportsApi(null);
  setFileSaver(null);
  document.body.innerHTML = '';
});

describe('notification store', () => {
  it('counts unread rows, lists newest first and marks one read locally (queued for sync)', async () => {
    expect(await unreadCount()).toBe(2);
    expect((await listNotifications()).map((n) => n.id)).toEqual([READY, FAILED, OLD]);
    await markRead(FAILED, new Date('2026-10-04T12:00:00Z'));
    expect(await unreadCount()).toBe(1);
    const row = await db.notifications.get(FAILED);
    expect(row?.read_at).toBe('2026-10-04T12:00:00.000Z');
    // A local change waiting for the sync engine.
    expect(await db.outbox.count()).toBeGreaterThan(0);
  });
});

describe('<NotificationsBell />', () => {
  it('shows the unread count, lists the notifications and marks them read', async () => {
    render(<NotificationsBell />);
    const bell = screen.getByTestId('notifications-bell');
    await waitFor(() => expect(screen.getByTestId('notifications-count').textContent).toBe('2'));
    expect(bell.getAttribute('aria-label')).toMatch(/2/);

    fireEvent.click(bell);
    const dialog = await screen.findByTestId('notifications-dialog');
    const items = await within(dialog).findAllByTestId('notification-item');
    expect(items).toHaveLength(3);
    expect(items[0]!.dataset.kind).toBe('export.ready');
    expect(items[0]!.dataset.unread).toBe('true');
    expect(items[2]!.dataset.unread).toBe('false');
    // The expired file of the old export offers no download.
    expect(within(items[2]!).queryByTestId('notification-download')).toBeNull();

    fireEvent.click(within(items[1]!).getByTestId('notification-read'));
    await waitFor(() => expect(screen.getByTestId('notifications-count').textContent).toBe('1'));
    expect((await db.notifications.get(FAILED))?.read_at).toBeTruthy();

    fireEvent.click(within(dialog).getByTestId('notifications-mark-all'));
    await waitFor(() => expect(screen.queryByTestId('notifications-count')).toBeNull());
    expect(await unreadCount()).toBe(0);
  });

  it('an export-ready item opens the download through a fresh signed URL and is marked read', async () => {
    render(<NotificationsBell />);
    fireEvent.click(screen.getByTestId('notifications-bell'));
    const dialog = await screen.findByTestId('notifications-dialog');
    const [ready] = await within(dialog).findAllByTestId('notification-item');
    expect(ready!.textContent).toContain('33');
    fireEvent.click(within(ready!).getByTestId('notification-download'));
    await waitFor(() => expect(saved).toHaveLength(1));
    // the URL comes from the export function for that job (never signed in the browser)
    expect(api.exportDownloadUrl).toHaveBeenCalledWith('job-1');
    expect(saved[0]!.url).toContain('token=t');
    expect(saved[0]!.name).toBe('projects-2026-10-04.xlsx');
    await waitFor(async () => expect((await db.notifications.get(READY))?.read_at).toBeTruthy());
  });

  it('offline: the list still opens, the download says it needs the network', async () => {
    setOnline(false);
    render(<NotificationsBell />);
    fireEvent.click(screen.getByTestId('notifications-bell'));
    const dialog = await screen.findByTestId('notifications-dialog');
    const [ready] = await within(dialog).findAllByTestId('notification-item');
    fireEvent.click(within(ready!).getByTestId('notification-download'));
    await new Promise((r) => setTimeout(r, 20));
    expect(api.exportDownloadUrl).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });

  it('empty state', async () => {
    await db.notifications.clear();
    render(<NotificationsBell />);
    expect(screen.queryByTestId('notifications-count')).toBeNull();
    fireEvent.click(screen.getByTestId('notifications-bell'));
    expect(await screen.findByTestId('notifications-empty')).toBeTruthy();
  });
});

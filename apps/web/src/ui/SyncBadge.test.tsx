import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ syncNow: vi.fn(() => Promise.resolve()) }));

vi.mock('../sync', async () => {
  const { signal } = await import('@preact/signals');
  return {
    syncStatus: signal({
      online: true,
      state: 'idle',
      pendingOps: 0,
      pendingPhotos: 0,
      failedOps: 0,
      lastSyncAt: null,
      lastError: null,
    }),
    syncNow: mocks.syncNow,
  };
});

import { setLocale } from '../i18n';
import { defineMessages } from '../i18n/messages';
import { syncStatus } from '../sync';
import { SyncBadge, syncBadgeState } from './SyncBadge';

type Status = typeof syncStatus.value;
const HEALTHY: Status = {
  online: true,
  state: 'idle',
  pendingOps: 0,
  pendingPhotos: 0,
  failedOps: 0,
  lastSyncAt: null,
  lastError: null,
};

function setStatus(patch: Partial<Status>): void {
  syncStatus.value = { ...HEALTHY, ...patch };
}

beforeEach(async () => {
  mocks.syncNow.mockClear();
  mocks.syncNow.mockImplementation(() => Promise.resolve());
  setStatus({});
  await setLocale('en');
});

afterEach(cleanup);

describe('syncBadgeState', () => {
  it('offline wins over everything; then syncing, error, ok', () => {
    expect(syncBadgeState({ online: false, state: 'error' })).toBe('offline');
    expect(syncBadgeState({ online: false, state: 'pushing' })).toBe('offline');
    expect(syncBadgeState({ online: true, state: 'pushing' })).toBe('syncing');
    expect(syncBadgeState({ online: true, state: 'pulling' })).toBe('syncing');
    expect(syncBadgeState({ online: true, state: 'error' })).toBe('error');
    expect(syncBadgeState({ online: true, state: 'idle' })).toBe('ok');
  });
});

describe('<SyncBadge>', () => {
  it('online and idle: zero counters, "not synced yet", sync-now enabled', () => {
    render(<SyncBadge />);
    const badge = screen.getByTestId('sync-badge');
    expect(badge.getAttribute('data-state')).toBe('ok');
    expect(badge.textContent).toContain('Online');
    expect(badge.textContent).toContain('Not synced yet');
    expect(screen.getByTestId('sync-pending-ops').textContent).toBe('0');
    expect(screen.getByTestId('sync-pending-photos').textContent).toBe('0');
    expect(screen.queryByTestId('sync-failed-ops')).toBeNull();
    expect((screen.getByTestId('sync-now') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('status').textContent).toContain('Online');
  });

  it('shows pending operations and photos, with readable labels', () => {
    setStatus({ pendingOps: 20, pendingPhotos: 3 });
    render(<SyncBadge />);
    expect(screen.getByTestId('sync-pending-ops').textContent).toBe('20');
    expect(screen.getByTestId('sync-pending-photos').textContent).toBe('3');
    expect(screen.getByTestId('sync-badge').textContent).toContain('20 changes waiting to upload');
    expect(screen.getByTestId('sync-badge').textContent).toContain('3 photos waiting to upload');
  });

  it('offline: says so and disables sync-now', () => {
    setStatus({ online: false, pendingOps: 4 });
    render(<SyncBadge />);
    expect(screen.getByTestId('sync-badge').getAttribute('data-state')).toBe('offline');
    expect(screen.getByRole('status').textContent).toContain('Offline');
    expect((screen.getByTestId('sync-now') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('sync-pending-ops').textContent).toBe('4');
  });

  it('pushing / pulling: shows progress and blocks a second run', () => {
    setStatus({ state: 'pushing' });
    render(<SyncBadge />);
    expect(screen.getByTestId('sync-badge').getAttribute('data-state')).toBe('syncing');
    expect(screen.getByRole('status').textContent).toContain('Uploading data…');
    expect((screen.getByTestId('sync-now') as HTMLButtonElement).disabled).toBe(true);

    setStatus({ state: 'pulling' });
    return waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('Fetching updates…'),
    );
  });

  it('error: generic message, or the message behind the key reported by the sync engine', async () => {
    setStatus({ state: 'error', lastError: 'sync.error_unknown_key_for_this_test' });
    render(<SyncBadge />);
    expect(screen.getByTestId('sync-badge').getAttribute('data-state')).toBe('error');
    expect(screen.getByRole('status').textContent).toContain('Sync failed');
    expect((screen.getByTestId('sync-now') as HTMLButtonElement).disabled).toBe(false);

    defineMessages('en', { 'sync.error_test_only': 'The server is busy' });
    setStatus({ state: 'error', lastError: 'sync.error_test_only' });
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('The server is busy'),
    );
  });

  it('shows operations that need attention', () => {
    setStatus({ failedOps: 2 });
    render(<SyncBadge />);
    expect(screen.getByTestId('sync-failed-ops').textContent).toBe('2');
    expect(screen.getByTestId('sync-badge').textContent).toContain('Need attention: 2');
  });

  it('shows the last successful sync as a relative time', () => {
    setStatus({ lastSyncAt: Date.now() - 5 * 60_000 });
    render(<SyncBadge />);
    expect(screen.getByTestId('sync-badge').textContent).toContain('Last sync: 5 minutes ago');
  });

  it('"sync now" calls syncNow() and a failure does not escape', async () => {
    mocks.syncNow.mockImplementationOnce(() => Promise.reject(new Error('network')));
    render(<SyncBadge />);
    fireEvent.click(screen.getByTestId('sync-now'));
    fireEvent.click(screen.getByTestId('sync-now'));
    expect(mocks.syncNow).toHaveBeenCalledTimes(2);
    await Promise.resolve();
  });

  it('reacts to status changes and to the language', async () => {
    render(<SyncBadge />);
    setStatus({ online: false, pendingOps: 7 });
    await waitFor(() => expect(screen.getByTestId('sync-pending-ops').textContent).toBe('7'));
    expect(screen.getByTestId('sync-badge').getAttribute('data-state')).toBe('offline');

    await setLocale('ar');
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('غير متصل'));
    expect(screen.getByTestId('sync-now').getAttribute('aria-label')).toBe('مزامنة الآن');
    expect(screen.getByTestId('sync-badge').textContent).toContain('7 عمليات بانتظار الرفع');
  });
});

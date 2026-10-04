import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prefs: new Map<string, unknown>(),
  profileUpdate: vi.fn(),
  pinUnlock: vi.fn(async (_pin: string) => true),
  pinSet: vi.fn(async (_pin: string) => undefined),
  pinLock: vi.fn(),
  signOut: vi.fn(async () => undefined),
  storageEstimate: vi.fn(),
  purgeCaches: vi.fn(async () => undefined),
}));

vi.mock('../lib/prefs', () => ({
  getPref: <T,>(key: string, fallback: T): T =>
    mocks.prefs.has(key) ? (mocks.prefs.get(key) as T) : fallback,
  setPref: (key: string, value: unknown): void => {
    if (value === null || value === undefined) mocks.prefs.delete(key);
    else mocks.prefs.set(key, value);
  },
}));

vi.mock('../auth', async () => {
  const { signal } = await import('@preact/signals');
  const session = signal<unknown>({ user: { id: 'u1' } });
  return {
    me: signal({
      user_id: 'u1',
      profile: { full_name: 'Amina', preferred_language: 'en' },
      roles: [],
    }),
    session,
    supabase: {
      from: (table: string) => ({
        update: (values: unknown) => ({
          eq: async (column: string, value: unknown) => {
            mocks.profileUpdate(table, values, column, value);
            return { data: null, error: null };
          },
        }),
      }),
    },
    pin: {
      isSet: async () => true,
      set: mocks.pinSet,
      unlock: mocks.pinUnlock,
      lock: mocks.pinLock,
      locked: signal(false),
    },
    lockMinutes: signal(15),
    signOut: mocks.signOut,
    deviceId: () => 'device-1234',
  };
});

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
    syncNow: vi.fn(),
    // Public API only: the settings screen must not reach into the sync module's files.
    WIFI_ONLY_PREF_KEY: 'test.wifiOnly',
    storageEstimate: mocks.storageEstimate,
  };
});
vi.mock('../db', () => ({
  listProjects: async () => ({ rows: [], next: null, total: 0 }),
  getAppSetting: async (_key: string, fallback: unknown) => fallback,
  saveAppSettings: async () => undefined,
}));
vi.mock('../ui/pwa/register', async (original) => ({
  ...((await original()) as Record<string, unknown>),
  purgeUserCaches: mocks.purgeCaches,
}));

import * as auth from '../auth';
import { locale, setLocale } from '../i18n';
import { syncStatus } from '../sync';
import { serverEnvironment } from '../ui/appSettings';
import { clearRecentErrors, recordError } from '../ui/monitoring';
import { APP_VERSION } from '../version';
import { diagnosticsText } from './AboutSection';
import { validatePinChange } from './SecuritySection';
import SettingsPage from './SettingsPage';

const session = auth.session as unknown as { value: unknown };

function typePin(testId: string, value: string): void {
  fireEvent.input(screen.getByTestId(testId), { target: { value } });
}

beforeEach(async () => {
  mocks.prefs.clear();
  for (const mock of [
    mocks.profileUpdate,
    mocks.pinUnlock,
    mocks.pinSet,
    mocks.pinLock,
    mocks.signOut,
    mocks.purgeCaches,
  ]) {
    mock.mockClear();
  }
  mocks.pinUnlock.mockImplementation(async () => true);
  mocks.pinSet.mockImplementation(async () => undefined);
  mocks.signOut.mockImplementation(async () => undefined);
  mocks.storageEstimate.mockReset();
  mocks.storageEstimate.mockResolvedValue({
    usage: 5 * 1024 * 1024,
    quota: 100 * 1024 * 1024,
    free: 95 * 1024 * 1024,
    percentUsed: 5,
    persisted: true,
  });
  session.value = { user: { id: 'u1' } };
  syncStatus.value = { ...syncStatus.value, pendingOps: 0, pendingPhotos: 0, failedOps: 0 };
  serverEnvironment.value = null;
  clearRecentErrors();
  await setLocale('en');
  mocks.prefs.clear();
});

afterEach(cleanup);

describe('language', () => {
  it('offers the three languages and marks the current one', () => {
    render(<SettingsPage />);
    expect(screen.getByTestId('lang-ar').textContent).toBe('العربية');
    expect(screen.getByTestId('lang-sw').textContent).toBe('Kiswahili');
    expect(screen.getByTestId('lang-en').textContent).toBe('English');
    expect(screen.getByTestId('lang-en').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('lang-ar').getAttribute('aria-pressed')).toBe('false');
  });

  it('switches language and direction at once, remembers it and tells the profile', async () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId('lang-ar'));
    await waitFor(() => expect(locale.value).toBe('ar'));
    expect(document.documentElement.dir).toBe('rtl');
    expect(mocks.prefs.get('locale')).toBe('ar');
    await waitFor(() =>
      expect(screen.getByTestId('lang-ar').getAttribute('aria-pressed')).toBe('true'),
    );
    expect(screen.getByText('الأمان')).toBeTruthy();
    await waitFor(() =>
      expect(mocks.profileUpdate).toHaveBeenCalledWith(
        'profiles',
        { preferred_language: 'ar' },
        'id',
        'u1',
      ),
    );

    fireEvent.click(screen.getByTestId('lang-sw'));
    await waitFor(() => expect(locale.value).toBe('sw'));
    expect(document.documentElement.dir).toBe('ltr');
    expect(screen.getByText('Usalama')).toBeTruthy();
  });
});

describe('storage and Wi-Fi only', () => {
  it('shows the storage estimate, the persistence state and what is still pending', async () => {
    syncStatus.value = { ...syncStatus.value, pendingOps: 12, pendingPhotos: 3 };
    render(<SettingsPage />);
    const usage = await screen.findByTestId('storage-usage');
    expect(usage.textContent).toContain('Space used: 5 MB of 100 MB');
    expect(usage.textContent).toContain('Persistent storage is on');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('5');
    expect(screen.getByTestId('settings-pending-ops').textContent).toBe('12');
    expect(screen.getByTestId('settings-pending-photos').textContent).toBe('3');
  });

  it('says so when the browser gives no estimate, and can be refreshed', async () => {
    mocks.storageEstimate.mockResolvedValueOnce(null);
    render(<SettingsPage />);
    expect(await screen.findByTestId('storage-unavailable')).toBeTruthy();
    fireEvent.click(screen.getByTestId('storage-refresh'));
    expect(await screen.findByTestId('storage-usage')).toBeTruthy();
    expect(mocks.storageEstimate).toHaveBeenCalledTimes(2);
  });

  it('stores the Wi-Fi-only switch under the key the sync engine reads', async () => {
    render(<SettingsPage />);
    const toggle = screen.getByTestId('wifi-only') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(mocks.prefs.get('test.wifiOnly')).toBe(true);
    fireEvent.click(toggle);
    expect(mocks.prefs.get('test.wifiOnly')).toBe(false);
    cleanup();

    mocks.prefs.set('test.wifiOnly', true);
    render(<SettingsPage />);
    expect((screen.getByTestId('wifi-only') as HTMLInputElement).checked).toBe(true);
  });
});

describe('placeholders for other teams', () => {
  it('keeps clearly marked sections for map packs and the v2 import', () => {
    render(<SettingsPage />);
    expect(screen.getByTestId('settings-map-packs').textContent).toContain('Offline map packs');
    expect(screen.getByTestId('settings-v2-import').textContent).toContain('previous version');
  });
});

describe('PIN', () => {
  it('validates the form (pure)', () => {
    expect(validatePinChange('1357', '2468', '2468')).toEqual({});
    expect(validatePinChange('', '2468', '2468')).toEqual({ current: 'settings.pinErrFormat' });
    expect(validatePinChange('1357', '12', '12')).toEqual({ next: 'settings.pinErrFormat' });
    expect(validatePinChange('1357', '123456789', '123456789')).toEqual({
      next: 'settings.pinErrFormat',
    });
    expect(validatePinChange('1357', '1357', '1357')).toEqual({ next: 'settings.pinErrSame' });
    expect(validatePinChange('1357', '2468', '2469')).toEqual({
      repeat: 'settings.pinErrMismatch',
    });
  });

  it('shows errors next to the fields and does not call the vault', async () => {
    render(<SettingsPage />);
    typePin('pin-current', '1357');
    typePin('pin-new', '24');
    typePin('pin-repeat', '25');
    fireEvent.click(screen.getByTestId('pin-save'));
    await waitFor(() =>
      expect(screen.getByTestId('pin-new').getAttribute('aria-invalid')).toBe('true'),
    );
    expect(document.getElementById('pin-new-error')?.textContent).toBe(
      'The PIN must be 4 to 8 digits.',
    );
    expect(document.getElementById('pin-repeat-error')?.textContent).toBe(
      'The two PINs do not match.',
    );
    expect(mocks.pinUnlock).not.toHaveBeenCalled();
    expect(mocks.pinSet).not.toHaveBeenCalled();
  });

  it('accepts digits only', () => {
    render(<SettingsPage />);
    typePin('pin-new', '12ab34cd5678999');
    expect((screen.getByTestId('pin-new') as HTMLInputElement).value).toBe('12345678');
  });

  it('verifies the current PIN before changing it', async () => {
    mocks.pinUnlock.mockImplementationOnce(async () => false);
    render(<SettingsPage />);
    typePin('pin-current', '1111');
    typePin('pin-new', '2468');
    typePin('pin-repeat', '2468');
    fireEvent.click(screen.getByTestId('pin-save'));
    await waitFor(() =>
      expect(document.getElementById('pin-current-error')?.textContent).toBe(
        'The current PIN is not correct.',
      ),
    );
    expect(mocks.pinSet).not.toHaveBeenCalled();

    typePin('pin-current', '1357');
    fireEvent.click(screen.getByTestId('pin-save'));
    await waitFor(() => expect(mocks.pinSet).toHaveBeenCalledWith('2468'));
    expect(mocks.pinUnlock).toHaveBeenLastCalledWith('1357');
    expect((await screen.findByTestId('toast-success')).textContent).toContain(
      'The new PIN was saved',
    );
    await waitFor(() => expect((screen.getByTestId('pin-new') as HTMLInputElement).value).toBe(''));
  });

  it('with the auth extension: counts the guesses left, and tells a throttled vault apart', async () => {
    const extended = auth.pin as unknown as Record<string, unknown>;
    const tryUnlock = vi.fn(async (_code: string) => 'wrong');
    Object.assign(extended, { tryUnlock, attempts: { value: { failures: 7 } }, maxFailures: 10 });
    try {
      render(<SettingsPage />);
      typePin('pin-current', '1111');
      typePin('pin-new', '2468');
      typePin('pin-repeat', '2468');
      fireEvent.click(screen.getByTestId('pin-save'));
      await waitFor(() =>
        expect(document.getElementById('pin-current-error')?.textContent).toBe(
          'The current PIN is not correct. Attempts left: 3.',
        ),
      );
      expect(tryUnlock).toHaveBeenCalledWith('1111');
      expect(mocks.pinUnlock).not.toHaveBeenCalled();

      tryUnlock.mockImplementationOnce(async () => 'throttled');
      fireEvent.click(screen.getByTestId('pin-save'));
      await waitFor(() =>
        expect(document.getElementById('pin-current-error')?.textContent).toBe(
          'Too many wrong attempts. Wait a moment and try again.',
        ),
      );

      // Wiped: the auth gate replaces the screen; nothing is saved, nothing is shown here.
      tryUnlock.mockImplementationOnce(async () => 'wiped');
      fireEvent.click(screen.getByTestId('pin-save'));
      await waitFor(() => expect(tryUnlock).toHaveBeenCalledTimes(3));
      await waitFor(() => expect(document.getElementById('pin-current-error')).toBeNull());
      expect(mocks.pinSet).not.toHaveBeenCalled();
    } finally {
      delete extended.tryUnlock;
      delete extended.attempts;
      delete extended.maxFailures;
    }
  });

  it('reports a refusal of the vault', async () => {
    mocks.pinSet.mockImplementationOnce(async () => {
      throw new Error('storage');
    });
    render(<SettingsPage />);
    typePin('pin-current', '1357');
    typePin('pin-new', '2468');
    typePin('pin-repeat', '2468');
    fireEvent.click(screen.getByTestId('pin-save'));
    expect((await screen.findByTestId('toast-error')).textContent).toContain(
      'The PIN could not be saved',
    );
  });

  it('"lock now" locks the app', () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId('lock-now'));
    expect(mocks.pinLock).toHaveBeenCalledTimes(1);
  });
});

describe('sign out', () => {
  it('asks first, and does nothing when the user cancels', async () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId('sign-out'));
    expect((await screen.findByTestId('confirm-dialog')).textContent).toContain('Sign out?');
    fireEvent.click(screen.getByTestId('confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it('signs out, then clears per-user caches and saved filters', async () => {
    mocks.prefs.set('filters.__views', ['projects']);
    mocks.prefs.set('filters.projects', { q: 'a name' });
    mocks.signOut.mockImplementationOnce(async () => {
      session.value = null;
    });
    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId('sign-out'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await waitFor(() => expect(mocks.purgeCaches).toHaveBeenCalledTimes(1));
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(mocks.prefs.has('filters.projects')).toBe(false);
  });

  it('with unsent work leaves the question to the auth module (no double confirmation)', async () => {
    syncStatus.value = { ...syncStatus.value, pendingOps: 4 };
    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId('sign-out'));
    await waitFor(() => expect(mocks.signOut).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    // The auth module's own dialog was declined: the session is still there, nothing is purged.
    expect(mocks.purgeCaches).not.toHaveBeenCalled();
  });
});

describe('about', () => {
  it('shows version, environment and device id', () => {
    render(<SettingsPage />);
    expect(screen.getByTestId('about-version').textContent).toBe(APP_VERSION);
    expect(screen.getByTestId('about-device').textContent).toBe('device-1234');
    expect(screen.getByTestId('about-environment').textContent).toBe('Development');
    expect(screen.getByTestId('about-no-errors')).toBeTruthy();
  });

  it('prefers the environment the server reports', async () => {
    render(<SettingsPage />);
    serverEnvironment.value = 'staging';
    await waitFor(() =>
      expect(screen.getByTestId('about-environment').textContent).toBe('Staging'),
    );
  });

  it('lists the last errors (newest first) and clears them', async () => {
    recordError(new Error('first failure'), 'error');
    recordError(new Error('second failure for amina@example.org'), 'promise');
    render(<SettingsPage />);
    const items = [...screen.getByTestId('about-errors').querySelectorAll('li')].map(
      (li) => li.textContent ?? '',
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toContain('second failure for [email]');
    expect(items[1]).toContain('first failure');

    fireEvent.click(screen.getByTestId('about-clear'));
    await waitFor(() => expect(screen.getByTestId('about-no-errors')).toBeTruthy());
  });

  it('builds a plain-text diagnostics report', () => {
    const text = diagnosticsText('3.0.0', 'staging', 'device-1', [
      { at: '2026-10-03T10:00:00.000Z', message: 'Error: boom', source: 'error', count: 3 },
    ]);
    expect(text.split('\n')).toEqual([
      'version: 3.0.0',
      'environment: staging',
      'device: device-1',
      'errors: 1',
      '2026-10-03T10:00:00.000Z [error] x3 Error: boom',
    ]);
  });
});

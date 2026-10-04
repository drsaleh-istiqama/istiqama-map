import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  startSync: vi.fn(),
  stopSync: vi.fn(),
  listProjects: vi.fn(async () => ({ rows: [], next: null, total: 0 })),
  settingsRows: [] as Array<{ key: string; value: unknown }>,
  cachedSettings: {} as Record<string, unknown>,
}));

vi.mock('../../auth', async () => {
  const { signal, computed } = await import('@preact/signals');
  const caps = signal({
    write: false,
    review: false,
    seePeople: false,
    admin: false,
    manage: false,
  });
  const query = {
    select: () => query,
    eq: () => Promise.resolve({ data: mocks.settingsRows, error: null }),
  };
  return {
    me: signal(null),
    session: signal({ user: { id: 'u1' } }),
    can: {
      write: computed(() => caps.value.write),
      review: computed(() => caps.value.review),
      seePeople: computed(() => caps.value.seePeople),
      seeRestricted: computed(() => false),
      admin: computed(() => caps.value.admin),
      manage: computed(() => caps.value.manage),
    },
    supabase: { from: () => query },
    __caps: caps,
  };
});

vi.mock('../../sync', async () => {
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
    syncNow: vi.fn(() => Promise.resolve()),
    startSync: mocks.startSync,
    stopSync: mocks.stopSync,
  };
});

vi.mock('../../db', () => ({
  listProjects: mocks.listProjects,
  getAppSetting: async (key: string, fallback: unknown) => mocks.cachedSettings[key] ?? fallback,
  saveAppSettings: async (rows: Array<{ key: string; value: unknown }>) => {
    mocks.cachedSettings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  },
}));

import * as auth from '../../auth';
import { setLocale } from '../../i18n';
import { navigate } from '../../routes';
import { syncStatus } from '../../sync';
import { serverEnvironment } from '../appSettings';
import { updateAvailable } from '../pwa/register';
import { Shell } from './Shell';

type Caps = {
  write: boolean;
  review: boolean;
  seePeople: boolean;
  admin: boolean;
  manage: boolean;
};
const caps = (auth as unknown as { __caps: { value: Caps } }).__caps;
const me = auth.me as unknown as { value: unknown };

function setViewport(desktop: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: desktop,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

/**
 * Views are lazy chunks: the first import in a busy test worker (the whole suite runs in
 * parallel) can take longer than Testing Library's default 1 s.
 */
const LAZY_VIEW = { timeout: 8000 };

const linkIds = (container: HTMLElement): Array<string | null> =>
  [...container.querySelectorAll('a[data-testid]')].map((a) => a.getAttribute('data-testid'));

beforeEach(async () => {
  mocks.startSync.mockClear();
  mocks.stopSync.mockClear();
  mocks.listProjects.mockClear();
  mocks.listProjects.mockImplementation(async () => ({ rows: [], next: null, total: 0 }));
  mocks.settingsRows = [];
  mocks.cachedSettings = {};
  serverEnvironment.value = null;
  updateAvailable.value = false;
  caps.value = { write: true, review: true, seePeople: true, admin: true, manage: false };
  me.value = null;
  syncStatus.value = { ...syncStatus.value, online: true, state: 'idle', pendingOps: 0 };
  navigate('/map', { replace: true });
  await setLocale('en');
  setViewport(false);
});

afterEach(cleanup);

describe('<Shell> on a phone', () => {
  it('bottom navigation is exactly map, projects, add, maintenance, reports', async () => {
    render(<Shell />);
    const bar = screen.getByTestId('bottom-nav');
    expect(linkIds(bar)).toEqual([
      'nav-map',
      'nav-projects',
      'add-project',
      'nav-maintenance',
      'nav-reports',
    ]);
    expect(within(bar).getByTestId('nav-maintenance').textContent).toContain('Maintenance');
    // Test ids are unique: no second navigation is rendered on a phone.
    expect(screen.getAllByTestId('nav-maintenance')).toHaveLength(1);
    expect(screen.getAllByTestId('add-project')).toHaveLength(1);
    await screen.findByTestId('stub-map', {}, LAZY_VIEW);
  });

  it('marks the active item with aria-current="page"', async () => {
    render(<Shell />);
    expect(screen.getByTestId('nav-map').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('nav-maintenance').getAttribute('aria-current')).toBeNull();

    fireEvent.click(screen.getByTestId('nav-maintenance'));
    await waitFor(() =>
      expect(screen.getByTestId('nav-maintenance').getAttribute('aria-current')).toBe('page'),
    );
    expect(screen.getByTestId('nav-map').getAttribute('aria-current')).toBeNull();
    expect(window.location.pathname).toBe('/maintenance');
    expect(screen.getByTestId('view-title').textContent).toBe('Maintenance');
    await waitFor(() => expect(document.title).toContain('Maintenance'));
    await screen.findByTestId('stub-maintenance', {}, LAZY_VIEW);
  });

  it('the "more" sheet holds the remaining destinations and closes on navigation', async () => {
    render(<Shell />);
    expect(screen.queryByTestId('more-sheet')).toBeNull();
    fireEvent.click(screen.getByTestId('nav-more'));
    const sheet = await screen.findByTestId('more-sheet');
    expect(linkIds(sheet)).toEqual([
      'account-card',
      'nav-incomplete',
      'nav-review',
      'nav-people',
      'nav-import',
      'nav-admin',
      'nav-settings',
    ]);

    fireEvent.click(within(sheet).getByTestId('nav-review'));
    await waitFor(() => expect(screen.queryByTestId('more-sheet')).toBeNull());
    expect(window.location.pathname).toBe('/review');
  });

  it('hides what the user has no capability for', async () => {
    caps.value = { write: false, review: false, seePeople: false, admin: false, manage: false };
    render(<Shell />);
    expect(linkIds(screen.getByTestId('bottom-nav'))).toEqual([
      'nav-map',
      'nav-projects',
      'nav-maintenance',
      'nav-reports',
    ]);
    expect(screen.queryByTestId('add-project')).toBeNull();
    fireEvent.click(screen.getByTestId('nav-more'));
    const sheet = await screen.findByTestId('more-sheet');
    expect(linkIds(sheet)).toEqual(['account-card', 'nav-settings']);
  });

  it('follows capability changes (roles granted after MFA)', async () => {
    caps.value = { write: true, review: false, seePeople: true, admin: false, manage: false };
    render(<Shell />);
    fireEvent.click(screen.getByTestId('nav-more'));
    const sheet = await screen.findByTestId('more-sheet');
    expect(within(sheet).queryByTestId('nav-review')).toBeNull();
    expect(within(sheet).queryByTestId('nav-admin')).toBeNull();

    caps.value = { write: true, review: true, seePeople: true, admin: false, manage: true };
    await waitFor(() => expect(within(sheet).getByTestId('nav-review')).toBeTruthy());
    // A country manager (auth extension `can.manage`) reaches the administration pages too.
    expect(within(sheet).getByTestId('nav-admin')).toBeTruthy();
  });

  it('shows the open-maintenance count on the maintenance entry', async () => {
    mocks.listProjects.mockImplementation(async () => ({ rows: [], next: null, total: 7 }));
    render(<Shell />);
    await waitFor(() => expect(screen.getByTestId('nav-maintenance').textContent).toContain('7'));
    expect(mocks.listProjects).toHaveBeenCalledWith({ openMaintenance: true }, null, 1);
    expect(screen.getByTestId('nav-maintenance').textContent).toContain('Open maintenance: 7');
  });
});

describe('<Shell> on a desktop', () => {
  beforeEach(() => setViewport(true));

  it('lists every destination in the sidebar and keeps "add project" in the top bar', async () => {
    render(<Shell />);
    expect(screen.queryByTestId('bottom-nav')).toBeNull();
    expect(screen.queryByTestId('nav-more')).toBeNull();
    const sidebar = document.querySelector('.sidebar') as HTMLElement;
    expect(linkIds(sidebar)).toEqual([
      'nav-map',
      'nav-projects',
      'nav-maintenance',
      'nav-reports',
      'nav-incomplete',
      'nav-review',
      'nav-people',
      'nav-import',
      'nav-admin',
      'nav-settings',
      'account-card',
    ]);
    expect(screen.getAllByTestId('add-project')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('add-project'));
    await waitFor(() => expect(window.location.pathname).toBe('/projects/new'));
    await screen.findByTestId('stub-project-form', {}, LAZY_VIEW);
  });

  it('a viewer has no "add project" button', () => {
    caps.value = { write: false, review: false, seePeople: false, admin: false, manage: false };
    render(<Shell />);
    expect(screen.queryByTestId('add-project')).toBeNull();
  });
});

describe('<Shell> chrome', () => {
  it('always shows the sync badge and starts / stops the sync engine with the shell', () => {
    const view = render(<Shell />);
    expect(screen.getByTestId('sync-badge')).toBeTruthy();
    expect(screen.getByTestId('sync-now')).toBeTruthy();
    expect(mocks.startSync).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(mocks.stopSync).toHaveBeenCalledTimes(1);
  });

  it('takes the account card from the signed-in user, never from the code', async () => {
    setViewport(true);
    me.value = {
      user_id: 'u1',
      profile: { full_name: 'Amina Juma', preferred_language: 'en' },
      roles: [{ role: 'field_collector' }, { role: 'branch_supervisor' }],
      assigned_roles: [],
    };
    render(<Shell />);
    expect(screen.getByTestId('account-name').textContent).toBe('Amina Juma');
    expect(screen.getByTestId('account-role').textContent).toBe('Branch supervisor');

    me.value = {
      user_id: 'u2',
      profile: { full_name: 'سالم بن ناصر', preferred_language: 'en' },
      roles: [],
      assigned_roles: [{ role: 'hq_admin' }],
    };
    await waitFor(() =>
      expect(screen.getByTestId('account-name').textContent).toBe('سالم بن ناصر'),
    );
    expect(screen.getByTestId('account-role').textContent).toBe('Head office');
  });

  it('shows a neutral placeholder while the user context is unknown', () => {
    setViewport(true);
    render(<Shell />);
    expect(screen.getByTestId('account-name').textContent).toBe('User');
    expect(screen.getByTestId('account-role').textContent).toBe('No role');
  });

  it('shows the demo badge only when the server says it is a staging environment', async () => {
    me.value = {
      user_id: 'u1',
      profile: { full_name: 'A', preferred_language: 'en' },
      roles: [],
      assigned_roles: [],
    };
    mocks.settingsRows = [{ key: 'gps.accuracy_warn_m', value: 30 }];
    const first = render(<Shell />);
    await waitFor(() => expect(mocks.cachedSettings['gps.accuracy_warn_m']).toBe(30));
    expect(screen.queryByTestId('env-badge')).toBeNull();
    first.unmount();

    me.value = {
      user_id: 'u2',
      profile: { full_name: 'B', preferred_language: 'en' },
      roles: [],
      assigned_roles: [],
    };
    mocks.settingsRows = [{ key: 'app.environment', value: 'staging' }];
    render(<Shell />);
    expect((await screen.findByTestId('env-badge')).textContent).toBe('Demo data');
  });

  it('uses the cached setting when the server cannot be reached', async () => {
    mocks.cachedSettings = { 'app.environment': 'staging' };
    me.value = {
      user_id: 'u1',
      profile: { full_name: 'A', preferred_language: 'en' },
      roles: [],
      assigned_roles: [],
    };
    const eq = vi.fn(() => Promise.reject(new Error('offline')));
    const original = auth.supabase.from;
    (auth.supabase as unknown as { from: unknown }).from = () => ({ select: () => ({ eq }) });
    try {
      render(<Shell />);
      expect(await screen.findByTestId('env-badge')).toBeTruthy();
    } finally {
      (auth.supabase as unknown as { from: unknown }).from = original;
    }
  });

  it('shows the offline banner while offline and announces the return of the connection', async () => {
    render(<Shell />);
    expect(screen.queryByTestId('offline-banner')).toBeNull();
    syncStatus.value = { ...syncStatus.value, online: false };
    expect((await screen.findByTestId('offline-banner')).textContent).toContain('You are offline');
    syncStatus.value = { ...syncStatus.value, online: true };
    await waitFor(() => expect(screen.queryByTestId('offline-banner')).toBeNull());
    expect((await screen.findByTestId('toast-success')).textContent).toContain(
      'The internet connection is back',
    );
  });

  it('offers an available update and lets the user postpone it', async () => {
    render(<Shell />);
    expect(screen.queryByTestId('update-prompt')).toBeNull();
    updateAvailable.value = true;
    expect((await screen.findByTestId('update-prompt')).textContent).toContain(
      'A new version of the app is available',
    );
    expect(screen.getByTestId('update-accept')).toBeTruthy();
    fireEvent.click(screen.getByTestId('update-later'));
    await waitFor(() => expect(screen.queryByTestId('update-prompt')).toBeNull());
  });

  it('moves focus to the content on navigation, but not when only the language changes', async () => {
    render(<Shell />);
    const main = document.getElementById('main') as HTMLElement;
    const syncNowButton = screen.getByTestId('sync-now');
    syncNowButton.focus();

    await setLocale('ar');
    await waitFor(() => expect(document.title).toContain('الخارطة'));
    expect(document.activeElement).toBe(syncNowButton);

    fireEvent.click(screen.getByTestId('nav-reports'));
    await waitFor(() => expect(document.activeElement).toBe(main));
    expect(document.title).toContain('التقارير');
  });

  it('renders the 404 view for an unknown address', async () => {
    navigate('/no/such/page', { replace: true });
    render(<Shell />);
    expect(await screen.findByTestId('not-found')).toBeTruthy();
    expect(screen.getByTestId('view-title').textContent).toBe('Page not found');
    expect(screen.getByTestId('nav-map').getAttribute('aria-current')).toBeNull();
  });

  it('adopts the profile language on a device where none was chosen', async () => {
    me.value = {
      user_id: 'u1',
      profile: { full_name: 'Juma', preferred_language: 'sw' },
      roles: [],
      assigned_roles: [],
    };
    const prefs = await import('../../lib/prefs');
    prefs.setPref('locale', null);
    render(<Shell />);
    await waitFor(() =>
      expect(screen.getByTestId('nav-maintenance').textContent).toContain('Matengenezo'),
    );
    expect(document.documentElement.lang).toBe('sw');
  });
});

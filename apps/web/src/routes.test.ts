import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory stand-in for lib/prefs: the router only needs getPref / setPref.
const prefStore = vi.hoisted(() => new Map<string, unknown>());
vi.mock('./lib/prefs', () => ({
  getPref: <T>(key: string, fallback: T): T =>
    prefStore.has(key) ? (prefStore.get(key) as T) : fallback,
  setPref: (key: string, value: unknown): void => {
    if (value === null || value === undefined) prefStore.delete(key);
    else prefStore.set(key, JSON.parse(JSON.stringify(value)));
  },
}));

import {
  applyPendingScroll,
  clearViewFilters,
  currentRoute,
  matchPath,
  matchRoute,
  navigate,
  routes,
  setScrollContainer,
  useRoute,
  useViewFilters,
} from './routes';

describe('matchPath', () => {
  it('matches static paths exactly', () => {
    expect(matchPath('/projects', '/projects')).toEqual({});
    expect(matchPath('/projects', '/projects/')).toEqual({});
    expect(matchPath('/projects', '/project')).toBeNull();
    expect(matchPath('/', '/')).toEqual({});
    expect(matchPath('/', '/map')).toBeNull();
  });

  it('extracts and decodes parameters', () => {
    expect(matchPath('/projects/:id', '/projects/0190-abc')).toEqual({ id: '0190-abc' });
    expect(matchPath('/projects/:id/edit', '/projects/42/edit')).toEqual({ id: '42' });
    expect(matchPath('/reports/print/:kind/:id', '/reports/print/donor/d%201')).toEqual({
      kind: 'donor',
      id: 'd 1',
    });
    expect(matchPath('/projects/:id', '/projects/a/b')).toBeNull();
    expect(matchPath('/projects/:id', '/projects')).toBeNull();
  });

  it('keeps a malformed escape sequence as it is instead of throwing', () => {
    expect(matchPath('/projects/:id', '/projects/%E0%A4%A')).toEqual({ id: '%E0%A4%A' });
  });

  it('supports a trailing wildcard that also matches the bare prefix', () => {
    expect(matchPath('/admin/*', '/admin')).toEqual({ '*': '' });
    expect(matchPath('/admin/*', '/admin/users')).toEqual({ '*': 'users' });
    expect(matchPath('/admin/*', '/admin/users/42/roles')).toEqual({ '*': 'users/42/roles' });
    expect(matchPath('/admin/*', '/administrator')).toBeNull();
  });
});

describe('route table (docs/contracts/web.md §3.9)', () => {
  const cases: Array<[string, string, Record<string, string>]> = [
    ['/login', '/login', {}],
    ['/', '/', {}],
    ['/map', '/map', {}],
    ['/projects', '/projects', {}],
    ['/projects/new', '/projects/new', {}],
    [
      '/projects/0190f3a2-7c1e-7abc-8def-000000000001/edit',
      '/projects/:id/edit',
      { id: '0190f3a2-7c1e-7abc-8def-000000000001' },
    ],
    [
      '/projects/0190f3a2-7c1e-7abc-8def-000000000001',
      '/projects/:id',
      { id: '0190f3a2-7c1e-7abc-8def-000000000001' },
    ],
    ['/maintenance', '/maintenance', {}],
    ['/incomplete', '/incomplete', {}],
    ['/review', '/review', {}],
    ['/people', '/people', {}],
    ['/reports', '/reports', {}],
    ['/reports/print/project/p1', '/reports/print/:kind/:id', { kind: 'project', id: 'p1' }],
    ['/import', '/import', {}],
    ['/admin', '/admin/*', { '*': '' }],
    ['/admin/users', '/admin/*', { '*': 'users' }],
    ['/settings', '/settings', {}],
  ];

  it.each(cases)('%s → %s', (pathname, pattern, params) => {
    const match = matchRoute(pathname);
    expect(match?.route.path).toBe(pattern);
    expect(match?.params).toEqual(params);
  });

  it('prefers /projects/new over /projects/:id', () => {
    expect(matchRoute('/projects/new')?.route.path).toBe('/projects/new');
  });

  it('returns null for unknown paths (404 view)', () => {
    expect(matchRoute('/nope')).toBeNull();
    expect(matchRoute('/projects/1/2/3')).toBeNull();
    expect(matchRoute('/reports/print/project')).toBeNull();
  });

  it('highlights the right navigation item and marks bare routes', () => {
    const navOf = (path: string) => matchRoute(path)?.route.nav;
    expect(navOf('/')).toBe('map');
    expect(navOf('/projects/new')).toBe('add');
    expect(navOf('/projects/abc/edit')).toBe('projects');
    expect(navOf('/maintenance')).toBe('maintenance');
    expect(navOf('/admin/devices')).toBe('admin');
    expect(matchRoute('/login')?.route.bare).toBe(true);
    expect(matchRoute('/reports/print/country/tz')?.route.bare).toBe(true);
    expect(matchRoute('/settings')?.route.bare).toBeUndefined();
  });

  it('every route has a lazy loader and a title key; `/` and `/map` share one loader', () => {
    for (const route of routes) {
      expect(typeof route.load).toBe('function');
      expect(route.titleKey).toMatch(/^nav\.\w+$/);
    }
    expect(matchRoute('/')?.route.load).toBe(matchRoute('/map')?.route.load);
  });

  it('loads every feature view module, each with a default-exported component', async () => {
    // Login (auth team) and Settings pull in the real auth / sync modules and have their own tests.
    const loaders = new Set(
      routes.filter((r) => r.path !== '/login' && r.path !== '/settings').map((r) => r.load),
    );
    expect(loaders.size).toBe(13);
    for (const load of loaders) {
      const module = await load();
      expect(typeof module.default).toBe('function');
    }
    // A slow first import in a busy worker is not a failure.
  }, 30_000);
});

describe('navigate / useRoute', () => {
  beforeEach(() => {
    navigate('/map', { replace: true });
  });

  it('pushes a history entry and updates the current route', () => {
    const before = window.history.length;
    navigate('/projects/abc?tab=photos');
    expect(window.location.pathname).toBe('/projects/abc');
    expect(window.history.length).toBe(before + 1);
    const match = useRoute();
    expect(match.path).toBe('/projects/abc');
    expect(match.params).toEqual({ id: 'abc' });
    expect(match.query.get('tab')).toBe('photos');
    expect(match.route?.path).toBe('/projects/:id');
  });

  it('replaces instead of pushing when asked', () => {
    navigate('/projects');
    const before = window.history.length;
    navigate('/settings', { replace: true });
    expect(window.history.length).toBe(before);
    expect(currentRoute.value.path).toBe('/settings');
  });

  it('does not push the same URL twice', () => {
    navigate('/reports');
    const before = window.history.length;
    navigate('/reports');
    expect(window.history.length).toBe(before);
  });

  it('yields a null route for unknown paths', () => {
    navigate('/does/not/exist');
    expect(currentRoute.value.route).toBeNull();
    expect(currentRoute.value.path).toBe('/does/not/exist');
  });

  it('follows the browser back button (popstate)', () => {
    navigate('/projects');
    navigate('/reports');
    window.history.replaceState(window.history.state, '', '/projects');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(currentRoute.value.path).toBe('/projects');
  });

  it('starts a new page at the top and restores the scroll offset of an older entry', () => {
    const scroller = document.createElement('div');
    setScrollContainer(scroller);
    navigate('/projects');
    applyPendingScroll();
    const listEntry = window.history.state as { key: string };
    scroller.scrollTop = 480; // the user scrolled the list…
    navigate('/projects/abc'); // …and opened a project: the offset of the list entry is remembered
    scroller.scrollTop = 123;
    applyPendingScroll();
    expect(scroller.scrollTop).toBe(0);

    // Back to the list.
    window.history.replaceState(listEntry, '', '/projects');
    window.dispatchEvent(new PopStateEvent('popstate'));
    applyPendingScroll();
    expect(scroller.scrollTop).toBe(480);
    setScrollContainer(null);
  });
});

describe('useViewFilters (brief §12: switching views must not wipe filters)', () => {
  const defaults = { q: '', type: '', status: '' };

  beforeEach(() => {
    clearViewFilters();
    prefStore.clear();
  });

  it('keeps the filters of each view apart', () => {
    const [, setMap] = useViewFilters('map', defaults);
    const [, setProjects] = useViewFilters('projects', defaults);
    setMap({ status: 'maintenance' });
    setProjects({ type: 'school', q: 'نور' });

    // "Switch views": read both again, as the pages do when they render.
    expect(useViewFilters('map', defaults)[0]).toEqual({ q: '', type: '', status: 'maintenance' });
    expect(useViewFilters('projects', defaults)[0]).toEqual({
      q: 'نور',
      type: 'school',
      status: '',
    });
  });

  it('merges partial updates and accepts an updater function', () => {
    const [, set] = useViewFilters('maintenance', defaults);
    set({ status: 'active' });
    set((previous) => ({ ...previous, q: 'pemba' }));
    expect(useViewFilters('maintenance', defaults)[0]).toEqual({
      q: 'pemba',
      type: '',
      status: 'active',
    });
  });

  it('persists through lib/prefs and restores after a reload', () => {
    const [, set] = useViewFilters('projects', defaults);
    set({ status: 'building' });
    expect(prefStore.get('filters.projects')).toEqual({ q: '', type: '', status: 'building' });

    // Simulate a reload: the in-memory stores are gone, the preference is still there.
    const saved = prefStore.get('filters.projects');
    clearViewFilters();
    prefStore.set('filters.projects', saved);
    expect(useViewFilters('projects', defaults)[0].status).toBe('building');
  });

  it('adds new default fields to filters saved by an older version', () => {
    prefStore.set('filters.reports', { status: 'inactive' });
    expect(useViewFilters('reports', { ...defaults, countryId: '' })[0]).toEqual({
      q: '',
      type: '',
      status: 'inactive',
      countryId: '',
    });
  });

  it('reset returns one view to its defaults and leaves the others alone', () => {
    const [, setMap] = useViewFilters('map', defaults);
    const [, setProjects, resetProjects] = useViewFilters('projects', defaults);
    setMap({ type: 'mosque' });
    setProjects({ type: 'school' });
    resetProjects();
    expect(useViewFilters('projects', defaults)[0]).toEqual(defaults);
    expect(useViewFilters('map', defaults)[0].type).toBe('mosque');
  });

  it('clearViewFilters forgets everything (sign-out)', () => {
    const [, set] = useViewFilters('projects', defaults);
    set({ q: 'a person name' });
    clearViewFilters();
    expect(prefStore.has('filters.projects')).toBe(false);
    expect(useViewFilters('projects', defaults)[0]).toEqual(defaults);
  });

  it('works with the view key alone (defaults are optional)', () => {
    const [initial, set] = useViewFilters<{ status?: string }>('incomplete');
    expect(initial).toEqual({});
    set({ status: 'maintenance' });
    expect(useViewFilters<{ status?: string }>('incomplete')[0]).toEqual({ status: 'maintenance' });
  });

  it('in components: a view re-renders on change and finds its filter again after a view switch', async () => {
    function View({ name }: { name: string }) {
      const [filters, set] = useViewFilters(name, defaults);
      return h(
        'button',
        { 'data-testid': `filter-${name}`, onClick: () => set({ status: 'maintenance' }) },
        filters.status || 'all',
      );
    }
    const view = render(h(View, { name: 'projects' }));
    fireEvent.click(screen.getByTestId('filter-projects'));
    await waitFor(() =>
      expect(screen.getByTestId('filter-projects').textContent).toBe('maintenance'),
    );

    // Switch to another view (the projects page unmounts) and back again.
    view.rerender(h(View, { key: 'map', name: 'map' }));
    expect(screen.getByTestId('filter-map').textContent).toBe('all');
    view.rerender(h(View, { key: 'projects', name: 'projects' }));
    expect(screen.getByTestId('filter-projects').textContent).toBe('maintenance');
    view.unmount();
  });
});

/**
 * Tiny history-API router (docs/contracts/web.md §3.9) — no library.
 *
 *  - `routes`            the route table; every view is a lazy chunk
 *  - `matchRoute(path)`  pure pattern matching (`:param`, trailing `*`)
 *  - `navigate(path)`    pushState / replaceState + scroll bookkeeping
 *  - `useRoute()`        current match; components re-render on navigation
 *  - `useViewFilters()`  per-view filter persistence (brief §12: switching views must not
 *                        wipe the filters the user chose)
 */
import { computed, signal, type ReadonlySignal, type Signal } from '@preact/signals';
import type { ComponentType } from 'preact';
import { getPref, setPref } from './lib/prefs';

export type NavId =
  | 'map'
  | 'projects'
  | 'add'
  | 'maintenance'
  | 'reports'
  | 'incomplete'
  | 'review'
  | 'people'
  | 'import'
  | 'admin'
  | 'settings';

export type RouteParams = Record<string, string>;

export interface RouteDef {
  /** `/static`, `/:param` segments, optional trailing `/*` (also matches the bare prefix). */
  path: string;
  /** Lazy module whose default export is the view component. */
  load: () => Promise<{ default: ComponentType }>;
  /** Navigation item highlighted while this route is open. */
  nav?: NavId;
  /** Translation key of the page title. */
  titleKey: string;
  /** Rendered without the application chrome (login, print pages). */
  bare?: boolean;
}

/** `/` and `/map` are the same page: one loader, so moving between them keeps the map mounted. */
const mapPage: RouteDef['load'] = () => import('./map/MapPage');

export const routes: readonly RouteDef[] = [
  { path: '/login', load: () => import('./auth/LoginView'), titleKey: 'nav.login', bare: true },
  { path: '/', load: mapPage, nav: 'map', titleKey: 'nav.map' },
  { path: '/map', load: mapPage, nav: 'map', titleKey: 'nav.map' },
  {
    path: '/projects',
    load: () => import('./projects/ProjectsPage'),
    nav: 'projects',
    titleKey: 'nav.projects',
  },
  {
    path: '/projects/new',
    load: () => import('./projects/ProjectFormPage'),
    nav: 'add',
    titleKey: 'nav.add',
  },
  {
    path: '/projects/:id/edit',
    load: () => import('./projects/ProjectFormPage'),
    nav: 'projects',
    titleKey: 'nav.editProject',
  },
  {
    path: '/projects/:id',
    load: () => import('./projects/ProjectDetailsPage'),
    nav: 'projects',
    titleKey: 'nav.projectDetails',
  },
  {
    path: '/maintenance',
    load: () => import('./projects/MaintenancePage'),
    nav: 'maintenance',
    titleKey: 'nav.maintenance',
  },
  {
    path: '/incomplete',
    load: () => import('./projects/IncompletePage'),
    nav: 'incomplete',
    titleKey: 'nav.incomplete',
  },
  {
    path: '/review',
    load: () => import('./projects/ReviewPage'),
    nav: 'review',
    titleKey: 'nav.review',
  },
  {
    path: '/people',
    load: () => import('./people/PeoplePage'),
    nav: 'people',
    titleKey: 'nav.people',
  },
  {
    path: '/reports',
    load: () => import('./reports/ReportsPage'),
    nav: 'reports',
    titleKey: 'nav.reports',
  },
  {
    path: '/reports/print/:kind/:id',
    load: () => import('./reports/PrintPage'),
    nav: 'reports',
    titleKey: 'nav.print',
    bare: true,
  },
  {
    path: '/import',
    load: () => import('./import/ImportPage'),
    nav: 'import',
    titleKey: 'nav.import',
  },
  {
    path: '/admin/*',
    load: () => import('./admin/AdminPage'),
    nav: 'admin',
    titleKey: 'nav.admin',
  },
  {
    path: '/settings',
    load: () => import('./settings/SettingsPage'),
    nav: 'settings',
    titleKey: 'nav.settings',
  },
];

// ---------------------------------------------------------------------------------------------
// Matching (pure)
// ---------------------------------------------------------------------------------------------

function segmentsOf(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Params when `pattern` matches `pathname`, otherwise null. A wildcard rest is returned as `params['*']`. */
export function matchPath(pattern: string, pathname: string): RouteParams | null {
  const wanted = segmentsOf(pattern);
  const given = segmentsOf(pathname);
  const wildcard = wanted[wanted.length - 1] === '*';
  if (wildcard) wanted.pop();
  if (given.length < wanted.length || (!wildcard && given.length !== wanted.length)) return null;

  const params: RouteParams = {};
  for (let i = 0; i < wanted.length; i++) {
    const want = wanted[i] as string;
    const got = given[i] as string;
    if (want.startsWith(':')) params[want.slice(1)] = decode(got);
    else if (want !== got) return null;
  }
  if (wildcard) params['*'] = given.slice(wanted.length).map(decode).join('/');
  return params;
}

/** First route of the table matching `pathname` (static routes are listed before parametric ones). */
export function matchRoute(
  pathname: string,
  table: readonly RouteDef[] = routes,
): { route: RouteDef; params: RouteParams } | null {
  for (const route of table) {
    const params = matchPath(route.path, pathname);
    if (params) return { route, params };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Location state
// ---------------------------------------------------------------------------------------------

export interface RouteMatch {
  /** Pathname inside the app (base path removed), e.g. `/projects/0190…/edit`. */
  path: string;
  query: URLSearchParams;
  params: RouteParams;
  /** null = no such page (404 view). */
  route: RouteDef | null;
}

const BASE = (import.meta.env?.BASE_URL ?? '/').replace(/\/+$/, '');
const hasWindow = typeof window !== 'undefined';

function stripBase(pathname: string): string {
  const path = BASE && pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname;
  return path === '' ? '/' : path;
}

function readLocation(): { path: string; search: string } {
  if (!hasWindow) return { path: '/', search: '' };
  return { path: stripBase(window.location.pathname), search: window.location.search };
}

const location = signal(readLocation());

/** Current route as a signal (for code outside components). */
export const currentRoute: ReadonlySignal<RouteMatch> = computed(() => {
  const { path, search } = location.value;
  const match = matchRoute(path);
  return {
    path,
    query: new URLSearchParams(search),
    params: match?.params ?? {},
    route: match?.route ?? null,
  };
});

/** Current route; the calling component re-renders when it changes. */
export function useRoute(): RouteMatch {
  return currentRoute.value;
}

// ---------------------------------------------------------------------------------------------
// Navigation and scroll restoration
// ---------------------------------------------------------------------------------------------

const scrollByEntry = new Map<string, number>();
let scrollContainer: HTMLElement | null = null;
let pendingScroll: number | null = null;
let entryCounter = 0;

function entryKey(): string {
  const state: unknown = hasWindow ? window.history.state : null;
  const key = state && typeof state === 'object' ? (state as { key?: unknown }).key : undefined;
  return typeof key === 'string' ? key : 'entry-0';
}

function rememberScroll(): void {
  scrollByEntry.set(
    entryKey(),
    scrollContainer ? scrollContainer.scrollTop : hasWindow ? window.scrollY : 0,
  );
}

/** The element that scrolls page content (the shell's <main>); null = the window. */
export function setScrollContainer(element: HTMLElement | null): void {
  scrollContainer = element;
}

/**
 * Called by the shell once the view of the current route is on screen: new pages start at
 * the top, back/forward return to where the user was.
 */
export function applyPendingScroll(): void {
  if (pendingScroll === null) return;
  const top = pendingScroll;
  pendingScroll = null;
  if (scrollContainer) scrollContainer.scrollTop = top;
  else if (hasWindow) window.scrollTo(0, top);
}

export function navigate(path: string, opts: { replace?: boolean } = {}): void {
  if (!hasWindow) return;
  const target = new URL(BASE + path, window.location.origin);
  const same =
    target.pathname === window.location.pathname && target.search === window.location.search;
  if (same && !opts.replace) return;
  const url = target.pathname + target.search + target.hash;
  if (opts.replace) {
    window.history.replaceState({ key: entryKey() }, '', url);
  } else {
    rememberScroll();
    window.history.pushState(
      { key: `entry-${Date.now().toString(36)}-${++entryCounter}` },
      '',
      url,
    );
    pendingScroll = 0;
  }
  location.value = readLocation();
}

if (hasWindow) {
  if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';
  window.addEventListener('popstate', () => {
    pendingScroll = scrollByEntry.get(entryKey()) ?? 0;
    location.value = readLocation();
  });
  // Leaving through back/forward: remember where this entry was scrolled to.
  window.addEventListener('pagehide', rememberScroll);
}

// ---------------------------------------------------------------------------------------------
// Per-view filters
// ---------------------------------------------------------------------------------------------

const FILTER_PREF = 'filters.';
const FILTER_INDEX_PREF = 'filters.__views';
const filterStores = new Map<string, Signal<object>>();

function filterStore<T extends object>(viewKey: string, defaults: T): Signal<T> {
  let store = filterStores.get(viewKey) as Signal<T> | undefined;
  if (!store) {
    const saved = getPref<Partial<T> | null>(FILTER_PREF + viewKey, null);
    store = signal<T>({ ...defaults, ...(saved && typeof saved === 'object' ? saved : {}) });
    filterStores.set(viewKey, store as unknown as Signal<object>);
  }
  return store;
}

function persistFilters<T extends object>(viewKey: string, value: T): void {
  setPref(FILTER_PREF + viewKey, value);
  const views = getPref<string[]>(FILTER_INDEX_PREF, []);
  if (!views.includes(viewKey)) setPref(FILTER_INDEX_PREF, [...views, viewKey]);
}

export type SetViewFilters<T> = (patch: Partial<T> | ((previous: T) => T)) => void;

/**
 * Filters of one view (`'map'`, `'projects'`, `'maintenance'`, …), kept apart from every
 * other view and remembered on this device. Returns `[filters, set, reset]`; `set` merges a
 * partial update. Pass the same `defaults` object shape on every call.
 */
export function useViewFilters<T extends object>(
  viewKey: string,
  defaults: T,
): [T, SetViewFilters<T>, () => void] {
  const store = filterStore(viewKey, defaults);
  const set: SetViewFilters<T> = (patch) => {
    const next = typeof patch === 'function' ? patch(store.peek()) : { ...store.peek(), ...patch };
    store.value = next;
    persistFilters(viewKey, next);
  };
  const reset = (): void => {
    store.value = { ...defaults };
    persistFilters(viewKey, store.peek());
  };
  return [store.value, set, reset];
}

/** Forget every saved filter (sign-out: a search text may contain a person's name). */
export function clearViewFilters(): void {
  for (const viewKey of new Set([
    ...filterStores.keys(),
    ...getPref<string[]>(FILTER_INDEX_PREF, []),
  ])) {
    setPref(FILTER_PREF + viewKey, null);
  }
  setPref(FILTER_INDEX_PREF, []);
  filterStores.clear();
}

import { describe, expect, it } from 'vitest';
import { matchRoute } from '../../routes';
import { NAV_ITEMS, visibleNav, type Capabilities } from './nav';

const NONE: Capabilities = { write: false, review: false, seePeople: false, admin: false };
const ALL: Capabilities = { write: true, review: true, seePeople: true, admin: true };
const ids = (items: Array<{ id: string }>): string[] => items.map((item) => item.id);

describe('navigation model', () => {
  it('the phone bottom bar is exactly: map, projects, add, maintenance, reports (brief §12)', () => {
    expect(ids(visibleNav(ALL).primary)).toEqual([
      'map',
      'projects',
      'add',
      'maintenance',
      'reports',
    ]);
  });

  it('everything else is in the "more" sheet', () => {
    expect(ids(visibleNav(ALL).more)).toEqual([
      'incomplete',
      'review',
      'people',
      'import',
      'admin',
      'settings',
    ]);
  });

  it('a field collector sees what a collector can use', () => {
    const nav = visibleNav({ write: true, review: false, seePeople: true, admin: false });
    expect(ids(nav.primary)).toEqual(['map', 'projects', 'add', 'maintenance', 'reports']);
    expect(ids(nav.more)).toEqual(['incomplete', 'people', 'import', 'settings']);
  });

  it('a viewer keeps maintenance but cannot add, review, import, administer or see people', () => {
    const nav = visibleNav(NONE);
    expect(ids(nav.primary)).toEqual(['map', 'projects', 'maintenance', 'reports']);
    expect(ids(nav.more)).toEqual(['settings']);
  });

  it('review and admin entries follow their capabilities independently', () => {
    expect(ids(visibleNav({ ...NONE, review: true }).more)).toEqual(['review', 'settings']);
    expect(ids(visibleNav({ ...NONE, admin: true }).more)).toEqual(['admin', 'settings']);
    expect(ids(visibleNav({ ...NONE, seePeople: true }).more)).toEqual(['people', 'settings']);
  });

  it('uses the test ids of the contract', () => {
    const testIds = Object.fromEntries(NAV_ITEMS.map((item) => [item.id, item.testId]));
    expect(testIds).toEqual({
      map: 'nav-map',
      projects: 'nav-projects',
      add: 'add-project',
      maintenance: 'nav-maintenance',
      reports: 'nav-reports',
      incomplete: 'nav-incomplete',
      review: 'nav-review',
      people: 'nav-people',
      import: 'nav-import',
      admin: 'nav-admin',
      settings: 'nav-settings',
    });
  });

  it('every item leads to a route that highlights it', () => {
    for (const item of NAV_ITEMS) {
      expect(matchRoute(item.path)?.route.nav, item.path).toBe(item.id);
    }
  });
});

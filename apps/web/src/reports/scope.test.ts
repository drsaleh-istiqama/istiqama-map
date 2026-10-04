import { beforeEach, describe, expect, it } from 'vitest';
import { applyServerRows } from '../db';
import { freshDb, serverRow } from '../db/testing/factory';
import {
  loadScopeOptions,
  parseScopeKey,
  pickInitialScope,
  printableCountries,
  readTriple,
  scopeFilters,
  scopeKey,
} from './scope';
import { KE, PEMBA, TANGA, TZ } from './testkit';

const MOMBASA = '96366d9e-3682-308d-91ad-e76c7345f6cb';

beforeEach(async () => {
  await freshDb();
  await applyServerRows('countries', [
    serverRow('countries', { id: TZ, iso2: 'TZ', name_ar: 'تنزانيا', name_en: 'Tanzania' }),
    serverRow('countries', { id: KE, iso2: 'KE', name_ar: 'كينيا', name_en: 'Kenya' }),
  ]);
  await applyServerRows('branches', [
    serverRow('branches', { id: PEMBA, code: 'PEMBA', country_id: TZ, name_ar: 'فرع بيمبا' }),
    serverRow('branches', { id: TANGA, code: 'TANGA', country_id: TZ, name_ar: 'فرع تانغا' }),
    serverRow('branches', { id: MOMBASA, code: 'MOMBASA', country_id: KE, name_ar: 'فرع ممباسا' }),
  ]);
});

describe('scope keys', () => {
  it('round-trips', () => {
    expect(scopeKey({ type: 'global', id: null })).toBe('global');
    expect(scopeKey({ type: 'branch', id: PEMBA })).toBe(`branch:${PEMBA}`);
    expect(parseScopeKey(`country:${TZ}`)).toEqual({ type: 'country', id: TZ });
    expect(parseScopeKey('global')).toEqual({ type: 'global', id: null });
    expect(parseScopeKey('nonsense')).toBeNull();
    expect(parseScopeKey(null)).toBeNull();
  });

  it('maps a scope to export filters', () => {
    expect(scopeFilters({ type: 'global', id: null })).toEqual({});
    expect(scopeFilters({ type: 'country', id: TZ })).toEqual({ country_id: TZ });
    expect(scopeFilters({ type: 'branch', id: PEMBA })).toEqual({ branch_id: PEMBA });
  });

  it('reads the read triple and fails closed', () => {
    expect(readTriple(null)).toEqual({ all: false, countries: [], branches: [] });
    expect(readTriple({ scopes: { read: { all: true } } }).all).toBe(true);
  });
});

describe('loadScopeOptions', () => {
  it('offers everything to a global reader, global first', async () => {
    const options = await loadScopeOptions({ all: true, countries: [], branches: [] });
    expect(options.map((o) => o.key)).toEqual([
      'global',
      `country:${KE}`,
      `country:${TZ}`,
      `branch:${MOMBASA}`,
      `branch:${PEMBA}`,
      `branch:${TANGA}`,
    ]);
    expect(printableCountries(options)).toHaveLength(2);
  });

  it('a country manager gets his country and its branches, never global or another country', async () => {
    const options = await loadScopeOptions({ all: false, countries: [TZ], branches: [] });
    expect(options.map((o) => o.key)).toEqual([
      `country:${TZ}`,
      `branch:${PEMBA}`,
      `branch:${TANGA}`,
    ]);
  });

  it('a branch collector gets only his branch (no country: dashboard(country) would be refused)', async () => {
    const options = await loadScopeOptions({ all: false, countries: [], branches: [PEMBA] });
    expect(options.map((o) => o.key)).toEqual([`branch:${PEMBA}`]);
    expect(printableCountries(options)).toEqual([]);
  });

  it('still offers a scope whose reference row was not pulled yet', async () => {
    const other = '11111111-1111-4111-8111-111111111111';
    const options = await loadScopeOptions({ all: false, countries: [], branches: [other] });
    expect(options).toEqual([{ key: `branch:${other}`, type: 'branch', id: other }]);
  });

  it('remembers the chosen scope only while it is allowed', async () => {
    const options = await loadScopeOptions({ all: false, countries: [TZ], branches: [] });
    expect(pickInitialScope(options, `branch:${TANGA}`)?.key).toBe(`branch:${TANGA}`);
    expect(pickInitialScope(options, 'global')?.key).toBe(`country:${TZ}`);
    expect(pickInitialScope([], null)).toBeNull();
  });
});

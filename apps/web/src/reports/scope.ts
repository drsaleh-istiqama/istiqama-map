/**
 * Which dashboard scopes the signed-in user may open (docs/contracts/reports-import-export.md
 * §2 access rule): `global` with a global read role; a country with a global role or a role on
 * that country; a branch with a global role, a role on its country or on the branch itself.
 * The read triple comes from `my_context().scopes.read`; country and branch names from the
 * synced reference rows. The server checks again on every call.
 */
import { db, type Row } from '../db';
import type { ScopeRef, ScopeType } from './types';

export interface ReadTriple {
  all: boolean;
  countries: string[];
  branches: string[];
}

export interface ScopeOption {
  key: string;
  type: ScopeType;
  id: string | null;
  country?: Row<'countries'>;
  branch?: Row<'branches'>;
}

export function scopeKey(scope: ScopeRef): string {
  return scope.type === 'global' || !scope.id ? 'global' : `${scope.type}:${scope.id}`;
}

export function parseScopeKey(key: string | null | undefined): ScopeRef | null {
  if (!key) return null;
  if (key === 'global') return { type: 'global', id: null };
  const m = /^(country|branch):(.+)$/.exec(key);
  return m ? { type: m[1] as ScopeType, id: m[2] as string } : null;
}

/** The read triple of a `my_context()` payload (fail closed: nothing). */
export function readTriple(context: unknown): ReadTriple {
  const read = (context as { scopes?: { read?: Partial<ReadTriple> } } | null)?.scopes?.read;
  return {
    all: read?.all === true,
    countries: Array.isArray(read?.countries) ? read.countries : [],
    branches: Array.isArray(read?.branches) ? read.branches : [],
  };
}

const live = <T extends { deleted_at?: string | null; active?: boolean }>(row: T): boolean =>
  !row.deleted_at && row.active !== false;

/**
 * Options in display order: global, the countries, then the branches (sorted by code; the
 * component shows names in the interface language).
 */
export async function loadScopeOptions(read: ReadTriple): Promise<ScopeOption[]> {
  const [countries, branches] = await Promise.all([
    db.countries.toArray().catch(() => [] as Row<'countries'>[]),
    db.branches.toArray().catch(() => [] as Row<'branches'>[]),
  ]);
  const countryIds = new Set(read.countries);
  const branchIds = new Set(read.branches);
  const options: ScopeOption[] = [];
  if (read.all) options.push({ key: 'global', type: 'global', id: null });

  const readableCountries = countries
    .filter(live)
    .filter((c) => read.all || countryIds.has(c.id))
    .sort((a, b) => a.iso2.localeCompare(b.iso2));
  for (const country of readableCountries) {
    options.push({ key: `country:${country.id}`, type: 'country', id: country.id, country });
  }

  const readableBranches = branches
    .filter(live)
    .filter((b) => read.all || countryIds.has(b.country_id) || branchIds.has(b.id))
    .sort((a, b) => a.code.localeCompare(b.code));
  for (const branch of readableBranches) {
    options.push({ key: `branch:${branch.id}`, type: 'branch', id: branch.id, branch });
  }

  // A role on a country / branch whose reference row has not been pulled yet: still offer it.
  const known = new Set(options.map((o) => o.key));
  for (const id of read.countries) {
    if (!known.has(`country:${id}`)) options.push({ key: `country:${id}`, type: 'country', id });
  }
  for (const id of read.branches) {
    if (!known.has(`branch:${id}`)) options.push({ key: `branch:${id}`, type: 'branch', id });
  }
  return options;
}

/** The option to open first: the remembered one when still allowed, else the widest scope. */
export function pickInitialScope(
  options: ScopeOption[],
  remembered: string | null,
): ScopeOption | null {
  return options.find((o) => o.key === remembered) ?? options[0] ?? null;
}

/** Export filters equivalent to a dashboard scope (same keys as `projects_page`). */
export function scopeFilters(scope: ScopeRef): Record<string, unknown> {
  if (scope.type === 'country' && scope.id) return { country_id: scope.id };
  if (scope.type === 'branch' && scope.id) return { branch_id: scope.id };
  return {};
}

/** Countries whose periodic report the user may print (report_country: like dashboard('country')). */
export function printableCountries(options: ScopeOption[]): ScopeOption[] {
  return options.filter((o) => o.type === 'country');
}

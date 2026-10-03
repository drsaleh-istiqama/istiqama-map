/**
 * Command-line options of the boundary importer.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CACHE_DIR = path.join(SCRIPT_DIR, 'data');

export type Release = 'gbOpen' | 'gbHumanitarian' | 'gbAuthoritative';
export type RelocateMode = 'missing' | 'all' | 'none';

export interface Options {
  /** ISO3 or ISO2 codes, upper-case. Empty = every active country in the database. */
  countries: string[];
  levels: number[];
  offline: boolean;
  /** Local GeoJSON to load instead of a geoBoundaries download. */
  file: string | null;
  cacheDir: string;
  /** Use the full-resolution geometry instead of the simplified one. */
  full: boolean;
  /** Download again even when a completed file is in the cache. */
  refresh: boolean;
  release: Release;
  relocate: RelocateMode;
  localities: boolean;
  /** Let names.json overwrite name_ar / name_sw / short_code of existing rows. */
  overwriteNames: boolean;
  /** Allow a file with far fewer shapes than the level it replaces. */
  allowShrink: boolean;
  dryRun: boolean;
  databaseUrl: string | null;
  retries: number;
  help: boolean;
}

export const HELP = `Import administrative boundaries (ADM1-ADM3) from geoBoundaries into public.admin_areas.

Usage: npm run boundaries:import -- [options]

  --country <ISO3[,ISO3]>   countries to import (ISO3 or ISO2); default: every active country
  --levels <1,2,3>          administrative levels; default 1,2,3
  --offline                 use cached files only, never touch the network
  --file <path>             load this GeoJSON instead of downloading
                            (needs exactly one --country and one level in --levels)
  --cache-dir <dir>         download cache; default scripts/import-boundaries/data
  --full                    full-resolution geometry (default: simplified, falling back to full)
  --refresh                 download again even when the cache holds a completed file
  --release <name>          gbOpen (default) | gbHumanitarian | gbAuthoritative
  --relocate <mode>         missing (default): give an area to projects/localities that lack one
                            all: re-derive the area of every located project and locality
                            none: do not touch projects or localities
  --skip-localities         do not import the v2 towns and villages (localities.v2.json)
  --overwrite-names         let names.json replace name_ar/name_sw/short_code of existing rows
  --allow-shrink            accept a file with fewer than half as many shapes as the areas it retires
  --retries <n>             download attempts per file; default 5
  --dry-run                 run everything, then roll back: nothing is written to the database
  --database-url <url>      default: DATABASE_URL from the environment or .env.local
  --help
`;

const BOOLEAN_FLAGS = new Set([
  'offline',
  'full',
  'refresh',
  'skip-localities',
  'overwrite-names',
  'allow-shrink',
  'dry-run',
  'help',
]);
const VALUE_FLAGS = new Set([
  'country',
  'levels',
  'file',
  'cache-dir',
  'release',
  'relocate',
  'retries',
  'database-url',
]);

export class UsageError extends Error {}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

export function parseOptions(argv: string[]): Options {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '-h') {
      flags.set('help', true);
      continue;
    }
    if (!arg.startsWith('--')) throw new UsageError(`unexpected argument: ${arg}`);
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, true);
    } else if (VALUE_FLAGS.has(name)) {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined || value === '') throw new UsageError(`--${name} needs a value`);
      flags.set(name, value);
    } else {
      throw new UsageError(`unknown option: --${name}`);
    }
  }
  const str = (name: string): string | null => {
    const v = flags.get(name);
    return typeof v === 'string' ? v : null;
  };

  const countries = splitList(str('country') ?? '').map((c) => c.toUpperCase());
  for (const c of countries) {
    if (!/^[A-Z]{2,3}$/.test(c)) throw new UsageError(`--country: "${c}" is not an ISO2/ISO3 code`);
  }

  const levels = [...new Set(splitList(str('levels') ?? '1,2,3').map(Number))].sort(
    (a, b) => a - b,
  );
  if (levels.length === 0 || levels.some((l) => ![1, 2, 3].includes(l))) {
    throw new UsageError('--levels accepts a comma-separated list of 1, 2, 3');
  }

  const release = (str('release') ?? 'gbOpen') as Release;
  if (!['gbOpen', 'gbHumanitarian', 'gbAuthoritative'].includes(release)) {
    throw new UsageError('--release must be gbOpen, gbHumanitarian or gbAuthoritative');
  }

  const relocate = (str('relocate') ?? 'missing') as RelocateMode;
  if (!['missing', 'all', 'none'].includes(relocate)) {
    throw new UsageError('--relocate must be missing, all or none');
  }

  const retries = Number(str('retries') ?? '5');
  if (!Number.isInteger(retries) || retries < 1 || retries > 20) {
    throw new UsageError('--retries must be an integer between 1 and 20');
  }

  const file = str('file');
  if (file !== null && (countries.length !== 1 || levels.length !== 1)) {
    throw new UsageError('--file needs exactly one --country and exactly one level in --levels');
  }

  return {
    countries,
    levels,
    offline: flags.has('offline'),
    file: file === null ? null : path.resolve(file),
    cacheDir: path.resolve(str('cache-dir') ?? DEFAULT_CACHE_DIR),
    full: flags.has('full'),
    refresh: flags.has('refresh'),
    release,
    relocate,
    localities: !flags.has('skip-localities'),
    overwriteNames: flags.has('overwrite-names'),
    allowShrink: flags.has('allow-shrink'),
    dryRun: flags.has('dry-run'),
    databaseUrl: str('database-url'),
    retries,
    help: flags.has('help'),
  };
}

/**
 * Command line of `npm run pmtiles:build` (pure: parsed and unit-tested without side effects).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(SCRIPT_DIR, '..', '..');

/** Development source: the East Africa extract on this machine (nothing is downloaded). */
export const DEFAULT_SOURCE = path.join(ROOT, '.local', 'tiles', 'east-africa.pmtiles');
export const DEFAULT_TOOL = path.join(
  ROOT,
  '.local',
  'pmtiles',
  process.platform === 'win32' ? 'pmtiles.exe' : 'pmtiles',
);
export const DEFAULT_OUT_DIR = path.join(ROOT, '.local', 'packs');
/** Street level: enough to find a mosque in a village; z15 doubles the size for little gain. */
export const DEFAULT_MAX_ZOOM = 14;

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface BuildOptions {
  command: 'build' | 'list';
  /** ISO2 of the country (TZ, KE, …). */
  country: string | null;
  /** Level-1 or level-2 area: id, `code`, `short_code` or English / Arabic / Swahili name. */
  area: string | null;
  level: 1 | 2 | null;
  /** Local file or http(s) URL of the source archive. */
  source: string;
  /** Allow an http(s) source (it is read with HTTP Range requests — that is a download). */
  allowRemote: boolean;
  maxZoom: number;
  minZoom: number;
  /** Pack code (default `<ISO2>-<short code>` / `<ISO2>-<parent short code>-<name>`). */
  code: string | null;
  tool: string;
  outDir: string;
  upload: boolean;
  /** Write the `map_packs` row (only together with the upload). */
  register: boolean;
  dryRun: boolean;
  databaseUrl: string | null;
  tilesVersion: string | null;
  help: boolean;
}

export const HELP = `Build offline map packs (brief §4.7) from a PMTiles archive.

  npm run pmtiles:build -- --country TZ --area "North Pemba"            build + upload + register
  npm run pmtiles:build -- --country TZ --area PN --maxzoom 13 --dry-run  only show what would happen
  npm run pmtiles:build -- list --country TZ --level 1                   areas you can build

Options
  --country <ISO2>          country of the area (TZ, KE, UG, RW, BI, MZ, OM)
  --area <value>            level-1 or level-2 area: id, code, short code or name (ar/en/sw)
  --level <1|2>             restrict the area lookup to one level
  --source <file|url>       source archive (default: ${path.relative(ROOT, DEFAULT_SOURCE)})
  --allow-remote            needed for an http(s) source such as https://build.protomaps.com/<date>.pmtiles
  --maxzoom <n>             deepest zoom in the pack (default ${DEFAULT_MAX_ZOOM})
  --minzoom <n>             first zoom in the pack (default 0)
  --code <code>             pack code (default TZ-PN style)
  --tiles-version <text>    source build stamp stored in map_packs.tiles_version
  --tool <path>             pmtiles CLI (default: ${path.relative(ROOT, DEFAULT_TOOL)})
  --out-dir <dir>           where packs are written (default: ${path.relative(ROOT, DEFAULT_OUT_DIR)})
  --no-upload               build the file only
  --no-register             upload, but do not write the map_packs row
  --dry-run                 resolve the area and print the plan; build nothing
  --database-url <url>      default: DATABASE_URL from the environment or .env.local
  --help

Uploads use SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (environment or .env.local).`;

function intOption(name: string, raw: string | undefined, min: number, max: number): number {
  const n = Number(raw);
  if (raw === undefined || !Number.isInteger(n) || n < min || n > max)
    throw new UsageError(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

export function parseOptions(argv: readonly string[]): BuildOptions {
  const opts: BuildOptions = {
    command: 'build',
    country: null,
    area: null,
    level: null,
    source: DEFAULT_SOURCE,
    allowRemote: false,
    maxZoom: DEFAULT_MAX_ZOOM,
    minZoom: 0,
    code: null,
    tool: DEFAULT_TOOL,
    outDir: DEFAULT_OUT_DIR,
    upload: true,
    register: true,
    dryRun: false,
    databaseUrl: null,
    tilesVersion: null,
    help: false,
  };
  const args = [...argv];
  if (args[0] === 'list' || args[0] === 'build') opts.command = args.shift() as 'list' | 'build';
  while (args.length > 0) {
    const arg = args.shift()!;
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    const value = (): string => {
      const v = inline ?? args.shift();
      if (v === undefined || v === '') throw new UsageError(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--country':
        opts.country = value().toUpperCase();
        if (!/^[A-Z]{2}$/.test(opts.country)) throw new UsageError('--country must be an ISO2 code');
        break;
      case '--area':
        opts.area = value();
        break;
      case '--level':
        opts.level = intOption('--level', value(), 1, 2) as 1 | 2;
        break;
      case '--source':
        opts.source = value();
        break;
      case '--allow-remote':
        opts.allowRemote = true;
        break;
      case '--maxzoom':
        opts.maxZoom = intOption('--maxzoom', value(), 0, 15);
        break;
      case '--minzoom':
        opts.minZoom = intOption('--minzoom', value(), 0, 15);
        break;
      case '--code':
        opts.code = value();
        if (!/^[A-Za-z0-9_-]{2,64}$/.test(opts.code))
          throw new UsageError('--code may only contain letters, digits, "-" and "_"');
        break;
      case '--tiles-version':
        opts.tilesVersion = value();
        break;
      case '--tool':
        opts.tool = value();
        break;
      case '--out-dir':
        opts.outDir = path.resolve(value());
        break;
      case '--no-upload':
        opts.upload = false;
        opts.register = false;
        break;
      case '--no-register':
        opts.register = false;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--database-url':
        opts.databaseUrl = value();
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw new UsageError(`unknown option ${arg}`);
    }
  }
  if (opts.help) return opts;
  if (opts.minZoom > opts.maxZoom) throw new UsageError('--minzoom is above --maxzoom');
  if (isRemote(opts.source) && !opts.allowRemote)
    throw new UsageError(
      `--source ${opts.source} is remote: reading it downloads data. Add --allow-remote to confirm.`,
    );
  if (opts.command === 'build') {
    if (!opts.country) throw new UsageError('--country is required');
    if (!opts.area) throw new UsageError('--area is required');
  } else if (!opts.country) {
    throw new UsageError('list needs --country');
  }
  return opts;
}

export function isRemote(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

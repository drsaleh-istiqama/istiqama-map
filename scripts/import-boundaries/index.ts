/**
 * Boundary importer (brief section 2.1): loads ADM1-ADM3 of every active country from
 * geoBoundaries into public.admin_areas, then the v2 towns and villages as approved
 * localities, then gives projects and localities their administrative area.
 *
 *   npm run boundaries:import -- --help
 *
 * Usage, cache layout and data licences: scripts/import-boundaries/README.md
 */
import path from 'node:path';
import dotenv from 'dotenv';
import pg from 'pg';
import { HELP, SCRIPT_DIR, UsageError, parseOptions, type Options } from './cli.ts';
import { obtainBoundary, type BoundaryMeta } from './download.ts';
import { readBoundaryFile, type BoundaryFeature } from './geojson.ts';
import {
  existingShortCodes,
  linkParents,
  listCountries,
  loadLevel,
  prepareSession,
  recordSources,
  relocate,
  type CountryRow,
  type PreparedFeature,
  type SourceRecord,
} from './load.ts';
import { hasV2Localities, importV2Localities } from './localities.ts';
import { NameIndex, assignShortCodes } from './names.ts';

const ROOT = path.resolve(SCRIPT_DIR, '..', '..');

interface LevelInput {
  level: number;
  features: BoundaryFeature[];
  warnings: string[];
  variant: string;
  meta: BoundaryMeta | null;
}

const log = (message: string): void => console.log(message);

/**
 * Runs units of work in their own transaction. In --dry-run mode everything happens inside
 * one outer transaction that is rolled back at the end (units become savepoints).
 */
class Transactions {
  private readonly client: pg.Client;
  private readonly dryRun: boolean;

  constructor(client: pg.Client, dryRun: boolean) {
    this.client = client;
    this.dryRun = dryRun;
  }

  async start(): Promise<void> {
    if (this.dryRun) await this.client.query('begin');
  }

  async finish(): Promise<void> {
    if (this.dryRun) await this.client.query('rollback');
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    const [begin, commit, rollback] = this.dryRun
      ? ['savepoint ib_unit', 'release savepoint ib_unit', 'rollback to savepoint ib_unit']
      : ['begin', 'commit', 'rollback'];
    await this.client.query(begin);
    try {
      const result = await work();
      await this.client.query(commit);
      return result;
    } catch (error) {
      await this.client.query(rollback).catch(() => undefined);
      throw error;
    }
  }
}

/** Applies names.json and assigns short codes (level 1). */
function prepareFeatures(
  names: NameIndex,
  country: CountryRow,
  level: number,
  features: BoundaryFeature[],
  shortCodesInDb: Map<string, string>,
): PreparedFeature[] {
  const known = features.map((f) => names.find(country.iso2, level, f.nameEn, f.iso));
  const shortCodes =
    level === 1
      ? assignShortCodes(
          features.map((f, i) => ({
            code: f.code,
            nameEn: known[i]?.name_en ?? f.nameEn,
            iso: f.iso,
            preferred: known[i]?.short_code ?? null,
          })),
          shortCodesInDb,
        )
      : new Map<string, string>();
  return features.map((f, i) => ({
    code: f.code,
    nameEn: known[i]?.name_en ?? f.nameEn,
    nameAr: known[i]?.name_ar ?? f.nameAr,
    nameSw: known[i]?.name_sw ?? f.nameSw,
    shortCode: shortCodes.get(f.code) ?? null,
    geometry: f.geometry,
  }));
}

/** Downloads (or reads from the cache / --file) the requested levels of one country. */
async function collectLevels(country: CountryRow, opts: Options): Promise<LevelInput[]> {
  const inputs: LevelInput[] = [];
  for (const level of opts.levels) {
    if (opts.file !== null) {
      const { features, warnings } = readBoundaryFile(opts.file, level);
      inputs.push({
        level,
        features,
        warnings,
        variant: `file:${path.basename(opts.file)}`,
        meta: null,
      });
      continue;
    }
    if (country.iso3 === null) {
      log(`  ADM${level}: skipped, the country has no ISO3 code (use --file)`);
      continue;
    }
    const obtained = await obtainBoundary(country.iso3, level, {
      cacheDir: opts.cacheDir,
      release: opts.release,
      offline: opts.offline,
      full: opts.full,
      refresh: opts.refresh,
      retries: opts.retries,
      log,
    });
    if (obtained.status === 'no-data') {
      log(`  ADM${level}: geoBoundaries has no data for this level`);
      continue;
    }
    if (obtained.status === 'not-cached') {
      log(`  ADM${level}: not in the cache (--offline), skipped`);
      continue;
    }
    const { features, warnings } = readBoundaryFile(obtained.file, level);
    inputs.push({
      level,
      features,
      warnings,
      variant: `${obtained.variant}${obtained.fromCache ? ', cached' : ''}`,
      meta: obtained.meta,
    });
  }
  return inputs;
}

async function importCountry(
  client: pg.Client,
  names: NameIndex,
  country: CountryRow,
  inputs: LevelInput[],
  opts: Options,
): Promise<void> {
  const sources: SourceRecord[] = [];
  for (const input of inputs) {
    const shortCodesInDb =
      input.level === 1 ? await existingShortCodes(client, country.id) : new Map<string, string>();
    const prepared = prepareFeatures(names, country, input.level, input.features, shortCodesInDb);
    const result = await loadLevel(client, country, input.level, prepared, {
      overwriteNames: opts.overwriteNames,
      // A custom file may hold only part of a level: never retire what it does not mention.
      keepMissing: opts.file !== null,
      allowShrink: opts.allowShrink,
    });
    const named = prepared.filter((f) => f.nameAr !== null).length;
    log(
      `  ADM${input.level}: ${result.features} shapes (${input.variant}) -> ` +
        `${result.inserted} new, ${result.updated} updated, ${result.unchanged} unchanged` +
        (result.retired > 0 ? `, ${result.retired} retired` : '') +
        (result.dropped > 0 ? `, ${result.dropped} dropped (empty geometry)` : '') +
        `; ${named} with an Arabic name`,
    );
    input.warnings.forEach((w) => log(`        note: ${w}`));
    sources.push({
      level: input.level,
      info: {
        release: opts.file !== null ? 'file' : opts.release,
        variant: input.variant.replace(', cached', ''),
        boundary_id: input.meta?.boundaryID ?? null,
        source: input.meta?.boundarySource ?? null,
        license: input.meta?.boundaryLicense ?? null,
        license_source: input.meta?.licenseSource ?? null,
        source_url: input.meta?.boundarySourceURL ?? null,
        build_date: input.meta?.buildDate ?? null,
        year_represented: input.meta?.boundaryYearRepresented ?? null,
        features: result.features - result.dropped,
        imported_at: new Date().toISOString(),
      },
      changed: result.inserted + result.updated + result.retired > 0,
    });
  }
  await recordSources(client, country.iso3 ?? country.iso2, sources);
  const linked = await linkParents(client, country.id);
  if (linked > 0) log(`  parents: ${linked} area(s) linked to the level above`);
}

async function main(): Promise<number> {
  let opts: Options;
  try {
    opts = parseOptions(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n\n${HELP}`);
      return 2;
    }
    throw error;
  }
  if (opts.help) {
    log(HELP);
    return 0;
  }

  dotenv.config({ path: [path.join(ROOT, '.env.local'), path.join(ROOT, '.env')], quiet: true });
  const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set (environment, .env.local or --database-url).');
    return 2;
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const failures: string[] = [];
  try {
    const where = await client.query<{ db: string; host: string | null }>(
      `select current_database() as db, inet_server_addr()::text as host`,
    );
    log(
      `database: ${where.rows[0]?.db ?? '?'} @ ${where.rows[0]?.host ?? 'local'}` +
        (opts.dryRun ? '   (DRY RUN: nothing is written)' : ''),
    );
    await prepareSession(client);

    const countries = await listCountries(client, opts.countries);
    for (const wanted of opts.countries) {
      if (!countries.some((c) => c.iso3 === wanted || c.iso2 === wanted)) {
        failures.push(`${wanted}: not found in public.countries`);
      }
    }
    if (countries.length === 0) {
      console.error(
        failures.length > 0
          ? failures.join('\n')
          : 'No active country in public.countries (migration 0060 or the admin screens add them).',
      );
      return 1;
    }

    const names = new NameIndex();
    const tx = new Transactions(client, opts.dryRun);
    await tx.start();

    for (const country of countries) {
      log(
        `\n${country.iso3 ?? country.iso2}  ${country.name_en}${country.active ? '' : '  (inactive)'}`,
      );
      try {
        const inputs = await collectLevels(country, opts);
        if (inputs.length > 0) {
          await tx.run(() => importCountry(client, names, country, inputs, opts));
        }
        if (opts.localities && hasV2Localities(country.iso2)) {
          const loc = await tx.run(() => importV2Localities(client, country));
          log(
            `  localities (v2): ${loc.total} known -> ${loc.inserted} new, ${loc.attached} attached to an area` +
              (loc.unmatchedRegions.length > 0
                ? `; no area found for: ${loc.unmatchedRegions.join('، ')}`
                : ''),
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${country.iso3 ?? country.iso2}: ${message}`);
        console.error(`  FAILED: ${message}`);
      }
    }

    const moved = await tx.run(() => relocate(client, opts.relocate));
    log(
      `\nadmin area re-derived (--relocate ${opts.relocate}): ${moved.projects} project(s), ` +
        `${moved.localities} locality(ies); references moved off retired areas: ` +
        `${moved.branches} branch(es), ${moved.persons} person(s), ${moved.mapPacks} map pack(s)`,
    );

    await tx.finish();
  } finally {
    await client.end();
  }

  if (failures.length > 0) {
    console.error(
      `\n${failures.length} problem(s):\n${failures.map((f) => `  - ${f}`).join('\n')}`,
    );
    return 1;
  }
  log(opts.dryRun ? '\ndry run finished, nothing was written' : '\ndone');
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);

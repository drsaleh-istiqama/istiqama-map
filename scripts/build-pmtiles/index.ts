/**
 * Offline map packs (brief §4.7): extracts the region of one administrative area from a
 * PMTiles archive, uploads it to the bucket `tiles` as `packs/<ISO2>/<code>.pmtiles` and
 * upserts its `map_packs` row (names in three languages, bytes, bbox, zoom range, sha256).
 * Devices list the packs through sync_pull and download them from Settings.
 *
 *   npm run pmtiles:build -- --help
 *
 * Usage and the production workflow: scripts/build-pmtiles/README.md
 */
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import pg from 'pg';
import { HELP, isRemote, parseOptions, ROOT, UsageError, type BuildOptions } from './cli.ts';
import { readArchiveHeader, runExtract, sha256File } from './pmtiles.ts';
import {
  areaGeoJson,
  findAreas,
  listAreas,
  mapPackRow,
  packCode,
  packStoragePath,
  upsertMapPack,
  type AreaRow,
} from './region.ts';
import { maxObjectBytes, storageConfig, uploadFile, verifyPublic } from './storage.ts';

const log = (message: string): void => console.log(message);

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function connect(opts: BuildOptions): Promise<pg.Client> {
  dotenv.config({ path: [path.join(ROOT, '.env.local'), path.join(ROOT, '.env')], quiet: true });
  const url = opts.databaseUrl ?? process.env.DATABASE_URL;
  if (!url) throw new UsageError('DATABASE_URL is not set (environment, .env.local or --database-url)');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

function describe(area: AreaRow): string {
  return `${area.name_en ?? area.code} / ${area.name_ar ?? '—'} (level ${area.level}, ${area.code})`;
}

async function list(client: pg.Client, opts: BuildOptions): Promise<void> {
  const areas = await listAreas(client, opts.country!, opts.level);
  for (const a of areas) log(`${packCode(a).padEnd(28)} level ${a.level}  ${describe(a)}`);
  log(`${areas.length} areas`);
}

async function build(client: pg.Client, opts: BuildOptions): Promise<void> {
  const matches = await findAreas(client, opts.country!, opts.area!, opts.level);
  if (matches.length === 0)
    throw new UsageError(
      `no level-1/2 area "${opts.area}" with an outline in ${opts.country} (try: list --country ${opts.country})`,
    );
  if (matches.length > 1 && matches[0]!.level === matches[1]!.level)
    throw new UsageError(
      `"${opts.area}" is ambiguous:\n${matches.map((m) => `  ${m.id}  ${describe(m)}`).join('\n')}\nUse --area <id> or --level.`,
    );
  const area = matches[0]!;
  const code = opts.code ?? packCode(area);
  const storagePath = packStoragePath(area.iso2, code);
  const out = path.join(opts.outDir, `${code}.pmtiles`);
  log(`area      ${describe(area)}`);
  log(`pack      ${code} → tiles/${storagePath}`);
  log(`source    ${opts.source}${isRemote(opts.source) ? ' (remote: HTTP Range requests)' : ''}`);
  log(`zoom      ${opts.minZoom}–${opts.maxZoom}`);

  if (!isRemote(opts.source)) {
    if (!existsSync(opts.source)) throw new UsageError(`source archive not found: ${opts.source}`);
    // A broken source fails here, not after minutes of extracting.
    const { header } = await readArchiveHeader(opts.source);
    log(`source    z${header.minZoom}–${header.maxZoom}, bounds ${header.minLon},${header.minLat},${header.maxLon},${header.maxLat}`);
  }
  if (!existsSync(opts.tool)) throw new UsageError(`pmtiles CLI not found: ${opts.tool} (--tool)`);

  await mkdir(opts.outDir, { recursive: true });
  const regionFile = path.join(opts.outDir, `${code}.region.geojson`);
  await writeFile(regionFile, await areaGeoJson(client, area.id));

  const extract = {
    tool: opts.tool,
    source: opts.source,
    out,
    regionFile,
    minZoom: opts.minZoom,
    maxZoom: opts.maxZoom,
  };
  if (opts.dryRun) {
    log(await runExtract({ ...extract, dryRun: true }));
    log('dry run: nothing written');
    return;
  }
  await rm(out, { force: true });
  log(await runExtract(extract));

  const { header, bytes } = await readArchiveHeader(out);
  const sha256 = await sha256File(out);
  log(`built     ${out} — ${mb(bytes)}, z${header.minZoom}–${header.maxZoom}, sha256 ${sha256.slice(0, 16)}…`);
  const tilesVersion =
    opts.tilesVersion ?? (/(\d{8})/.exec(path.basename(opts.source))?.[1] ?? null);

  if (!opts.upload) return;
  const cfg = storageConfig();
  const limit = await maxObjectBytes(cfg);
  if (limit !== null && bytes > limit)
    throw new Error(
      `the pack (${mb(bytes)}) is larger than the storage limit (${mb(limit)}): lower --maxzoom, choose a smaller area, or raise [storage] file_size_limit`,
    );
  await uploadFile(cfg, out, storagePath);
  await verifyPublic(cfg, storagePath, bytes);
  log(`uploaded  tiles/${storagePath}`);

  if (!opts.register) return;
  const row = mapPackRow({ area, code, storagePath, bytes, sha256, header, tilesVersion });
  const id = await upsertMapPack(client, row);
  log(`map_packs ${code} (${id}) — devices see it after their next sync`);
}

async function main(): Promise<void> {
  let opts: BuildOptions;
  try {
    opts = parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('\n' + HELP);
    process.exit(2);
  }
  if (opts.help) {
    log(HELP);
    return;
  }
  const client = await connect(opts);
  try {
    if (opts.command === 'list') await list(client, opts);
    else await build(client, opts);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(error instanceof UsageError ? 2 : 1);
});

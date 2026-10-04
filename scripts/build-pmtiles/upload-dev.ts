/**
 * Publishes the development basemap to the local Storage bucket `tiles` as
 * `basemap/east-africa.pmtiles`, where the app reads it (VITE_TILES_URL), with the
 * service-role key. Checks the archive first: an interrupted `pmtiles extract` leaves a file of
 * the expected size that is mostly zeros, and uploading it would only move the failure into the
 * browser.
 *
 *   npx tsx scripts/build-pmtiles/upload-dev.ts                       .local/tiles/east-africa.pmtiles
 *   npx tsx scripts/build-pmtiles/upload-dev.ts --file .local/tiles/dev-basemap.pmtiles
 *   npx tsx scripts/build-pmtiles/upload-dev.ts --fit                 too big for the storage limit?
 *                                                                     extract a lower max zoom first
 *
 * Nothing is downloaded: the source is a local file.
 */
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_SOURCE, DEFAULT_TOOL, ROOT, UsageError } from './cli.ts';
import { InvalidArchiveError } from './header.ts';
import { readArchiveHeader, runExtract } from './pmtiles.ts';
import { maxObjectBytes, publicUrl, storageConfig, uploadFile, verifyPublic } from './storage.ts';

export const BASEMAP_OBJECT = 'basemap/east-africa.pmtiles';

interface Options {
  file: string;
  object: string;
  fit: boolean;
  tool: string;
}

function parse(argv: string[]): Options {
  const opts: Options = { file: DEFAULT_SOURCE, object: BASEMAP_OBJECT, fit: false, tool: DEFAULT_TOOL };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--fit') {
      opts.fit = true;
      continue;
    }
    const value = argv[++i];
    if (!value) throw new UsageError(`${flag} needs a value`);
    if (flag === '--file') opts.file = path.resolve(value);
    else if (flag === '--object') opts.object = value.replace(/^\/+/, '');
    else if (flag === '--tool') opts.tool = path.resolve(value);
    else throw new UsageError(`unknown option ${flag}`);
  }
  return opts;
}

const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`;

async function main(): Promise<void> {
  const opts = parse(process.argv.slice(2));
  if (!existsSync(opts.file)) throw new UsageError(`archive not found: ${opts.file}`);

  let file = opts.file;
  let checked: Awaited<ReturnType<typeof readArchiveHeader>>;
  try {
    checked = await readArchiveHeader(file);
  } catch (error) {
    if (error instanceof InvalidArchiveError) {
      throw new UsageError(
        `${path.relative(ROOT, file)} is not a usable PMTiles archive: ${error.message}.\n` +
          'Re-run the extract (it needs the network once), or publish the development basemap made\n' +
          'from the local boundaries instead:\n' +
          '  npx tsx scripts/build-pmtiles/dev-basemap.ts\n' +
          '  npx tsx scripts/build-pmtiles/upload-dev.ts --file .local/tiles/dev-basemap.pmtiles',
      );
    }
    throw error;
  }
  const { header } = checked;
  console.log(
    `archive   ${path.relative(ROOT, file)} — ${mb(checked.bytes)}, z${header.minZoom}–${header.maxZoom}, ` +
      `bounds ${header.minLon},${header.minLat},${header.maxLon},${header.maxLat}`,
  );

  const cfg = storageConfig();
  const limit = await maxObjectBytes(cfg);
  if (limit !== null && checked.bytes > limit) {
    if (!opts.fit)
      throw new UsageError(
        `the archive (${mb(checked.bytes)}) exceeds the storage object limit (${mb(limit)}).\n` +
          'Either restart the local gateway with a larger STORAGE_FILE_SIZE_LIMIT (e.g. 200MiB),\n' +
          'or pass --fit to publish an extract with a lower max zoom.',
      );
    if (!existsSync(opts.tool)) throw new UsageError(`pmtiles CLI not found: ${opts.tool}`);
    const fitted = file.replace(/\.pmtiles$/, '.fit.pmtiles');
    let ok = false;
    for (let z = header.maxZoom - 1; z >= Math.max(header.minZoom, 5); z--) {
      await rm(fitted, { force: true });
      console.log(`fit       extracting z${header.minZoom}–${z} …`);
      await runExtract({
        tool: opts.tool,
        source: file,
        out: fitted,
        bbox: [header.minLon, header.minLat, header.maxLon, header.maxLat],
        minZoom: 0,
        maxZoom: z,
      });
      const result = await readArchiveHeader(fitted);
      if (result.bytes <= limit) {
        file = fitted;
        checked = result;
        ok = true;
        console.log(`fit       z${result.header.minZoom}–${result.header.maxZoom}: ${mb(result.bytes)}`);
        break;
      }
    }
    if (!ok) throw new Error('no max zoom ≥ 5 fits under the storage limit');
  }

  await uploadFile(cfg, file, opts.object);
  await verifyPublic(cfg, opts.object, checked.bytes);
  console.log(`uploaded  ${publicUrl(cfg, opts.object)}`);
  console.log('verified  public Range request answered 206 with the expected size');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(error instanceof UsageError ? 2 : 1);
});

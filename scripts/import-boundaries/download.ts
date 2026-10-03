/**
 * geoBoundaries download with an on-disk cache.
 *
 * API: https://www.geoboundaries.org/api/current/<release>/<ISO3>/ADM<level>/
 *   -> JSON metadata with gjDownloadURL (full) and simplifiedGeometryGeoJSON (simplified).
 *
 * Cache layout (git-ignored, default scripts/import-boundaries/data):
 *   <ISO3>-ADM<level>.meta.json                 API metadata (source, licence, build date)
 *   <ISO3>-ADM<level>.simplified.geojson        or .full.geojson
 *   <ISO3>-ADM<level>.<variant>.geojson.done    marker: the download completed and parsed
 *   <ISO3>-ADM<level>.<variant>.geojson.part    partial download, resumed with HTTP Range
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { Release } from './cli.ts';

const DEFAULT_API_BASE = 'https://www.geoboundaries.org/api/current';
/** Hosts geoBoundaries serves its API and files from. Nothing else is ever contacted. */
const ALLOWED_HOSTS = new Set([
  'www.geoboundaries.org',
  'geoboundaries.org',
  'github.com',
  'raw.githubusercontent.com',
  'media.githubusercontent.com',
]);

/**
 * GEOBOUNDARIES_API_BASE points the importer at a mirror of the API (an internal mirror, or a
 * local test server). Only that one extra origin is trusted, and only it may use plain http.
 */
function apiBase(): string {
  return (process.env.GEOBOUNDARIES_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, '');
}

function mirrorOrigin(): string | null {
  const base = process.env.GEOBOUNDARIES_API_BASE;
  return base ? new URL(base).origin : null;
}
const META_TIMEOUT_MS = 60_000;
/** A download is aborted when no byte arrives for this long (the link can be very slow). */
const STALL_TIMEOUT_MS = 120_000;

export type Variant = 'simplified' | 'full';

/** The fields of the API response that the importer uses or records. */
export interface BoundaryMeta {
  boundaryID?: string;
  boundaryName?: string;
  boundaryISO?: string;
  boundaryYearRepresented?: string;
  boundaryType?: string;
  boundaryCanonical?: string;
  boundarySource?: string;
  boundaryLicense?: string;
  licenseDetail?: string;
  licenseSource?: string;
  boundarySourceURL?: string;
  buildDate?: string;
  gjDownloadURL?: string;
  simplifiedGeometryGeoJSON?: string;
}

export type Obtained =
  | { status: 'ok'; file: string; variant: Variant; meta: BoundaryMeta | null; fromCache: boolean }
  | { status: 'no-data' } // geoBoundaries has no such level for the country
  | { status: 'not-cached' }; // --offline and nothing usable in the cache

export interface ObtainOptions {
  cacheDir: string;
  release: Release;
  offline: boolean;
  full: boolean;
  refresh: boolean;
  retries: number;
  log: (message: string) => void;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function assertAllowed(url: string): URL {
  const parsed = new URL(url);
  const official = parsed.protocol === 'https:' && ALLOWED_HOSTS.has(parsed.hostname);
  if (!official && parsed.origin !== mirrorOrigin()) {
    throw new Error(`refusing to download from ${parsed.origin}`);
  }
  return parsed;
}

function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function isFeatureCollectionFile(file: string): boolean {
  const parsed = readJsonFile<{ type?: unknown; features?: unknown }>(file);
  return parsed !== null && parsed.type === 'FeatureCollection' && Array.isArray(parsed.features);
}

async function withRetries<T>(
  label: string,
  retries: number,
  log: (message: string) => void,
  attempt: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let i = 1; i <= retries; i++) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      // A missing file will not appear by trying again.
      if (error instanceof HttpError && (error.status === 404 || error.status === 410)) throw error;
      if (i < retries) {
        const wait = Math.min(60_000, 2_000 * 2 ** (i - 1));
        log(
          `  ${label}: attempt ${i}/${retries} failed (${String(error)}); retrying in ${wait / 1000}s`,
        );
        await sleep(wait);
      }
    }
  }
  throw lastError;
}

/** Fetches the API metadata. Returns null when geoBoundaries has no such country/level. */
async function fetchMeta(
  iso3: string,
  level: number,
  opts: ObtainOptions,
): Promise<BoundaryMeta | null> {
  const url = `${apiBase()}/${opts.release}/${iso3}/ADM${level}/`;
  assertAllowed(url);
  try {
    return await withRetries(`${iso3} ADM${level} metadata`, opts.retries, opts.log, async () => {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        redirect: 'follow',
        signal: AbortSignal.timeout(META_TIMEOUT_MS),
      });
      if (!res.ok) throw new HttpError(res.status, url);
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        // The API answers unknown levels with an HTML error page.
        throw new HttpError(404, url);
      }
      // A list is returned when the level is "ALL"; a single object otherwise.
      const meta = (Array.isArray(parsed) ? parsed[0] : parsed) as BoundaryMeta | undefined;
      if (!meta || (!meta.gjDownloadURL && !meta.simplifiedGeometryGeoJSON)) {
        throw new HttpError(404, url);
      }
      return meta;
    });
  } catch (error) {
    if (error instanceof HttpError && (error.status === 404 || error.status === 410)) return null;
    throw error;
  }
}

/** Size in bytes the finished file must have, when the response headers tell. */
function expectedSize(res: Response, resumed: boolean): number | null {
  if (resumed) {
    // Content-Range: bytes <first>-<last>/<total>
    const total = /\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '')?.[1];
    return total === undefined ? null : Number(total);
  }
  const encoding = res.headers.get('content-encoding');
  if (encoding !== null && encoding !== 'identity') return null; // length of the compressed body
  const length = res.headers.get('content-length');
  return length !== null && /^\d+$/.test(length) ? Number(length) : null;
}

/** One download attempt; continues a `.part` file with an HTTP Range request when possible. */
async function downloadOnce(url: string, dest: string): Promise<void> {
  assertAllowed(url);
  const part = `${dest}.part`;
  const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  const headers: Record<string, string> = { accept: 'application/geo+json, application/json, */*' };
  if (have > 0) {
    // Byte offsets only make sense on the unencoded representation.
    headers.range = `bytes=${have}-`;
    headers['accept-encoding'] = 'identity';
  }

  let expected: number | null;
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(new Error('download stalled')), STALL_TIMEOUT_MS);
  const alive = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error('download stalled')), STALL_TIMEOUT_MS);
  };

  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
    if (res.status === 416) {
      // The partial file is not a prefix of the remote file (any more): start over.
      fs.rmSync(part, { force: true });
      throw new Error('stale partial download discarded');
    }
    if (!res.ok || res.body === null) throw new HttpError(res.status, url);
    const append = res.status === 206 && have > 0;
    expected = expectedSize(res, append);
    const body = Readable.fromWeb(res.body as unknown as NodeReadableStream<Uint8Array>);
    body.on('data', alive);
    await pipeline(body, fs.createWriteStream(part, { flags: append ? 'a' : 'w' }));
  } finally {
    clearTimeout(timer);
  }

  // A connection that closed early leaves a usable prefix: keep it and resume on the next attempt.
  if (expected !== null && fs.statSync(part).size < expected) {
    throw new Error(`incomplete download (${fs.statSync(part).size} of ${expected} bytes)`);
  }
  if (!isFeatureCollectionFile(part)) {
    fs.rmSync(part, { force: true });
    throw new Error('downloaded file is not a complete GeoJSON FeatureCollection');
  }
  fs.renameSync(part, dest);
  fs.writeFileSync(`${dest}.done`, new Date().toISOString());
}

/**
 * Returns the GeoJSON file of one country/level: from the cache when it holds a completed
 * download, otherwise from geoBoundaries (simplified geometry first, then full).
 */
export async function obtainBoundary(
  iso3: string,
  level: number,
  opts: ObtainOptions,
): Promise<Obtained> {
  const base = path.join(opts.cacheDir, `${iso3}-ADM${level}`);
  const metaFile = `${base}.meta.json`;
  const dataFile = (variant: Variant): string => `${base}.${variant}.geojson`;
  const variants: Variant[] = opts.full ? ['full'] : ['simplified', 'full'];

  if (!opts.refresh) {
    for (const variant of variants) {
      const file = dataFile(variant);
      if (fs.existsSync(`${file}.done`) && fs.existsSync(file) && fs.statSync(file).size > 0) {
        return {
          status: 'ok',
          file,
          variant,
          meta: readJsonFile<BoundaryMeta>(metaFile),
          fromCache: true,
        };
      }
    }
  }
  if (opts.offline) return { status: 'not-cached' };

  fs.mkdirSync(opts.cacheDir, { recursive: true });
  const meta = await fetchMeta(iso3, level, opts);
  if (meta === null) return { status: 'no-data' };
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));

  let lastError: unknown = new Error('the API returned no download URL');
  for (const variant of variants) {
    const url = variant === 'simplified' ? meta.simplifiedGeometryGeoJSON : meta.gjDownloadURL;
    if (!url) continue;
    const file = dataFile(variant);
    if (opts.refresh) {
      fs.rmSync(`${file}.done`, { force: true });
      fs.rmSync(`${file}.part`, { force: true });
    }
    try {
      opts.log(`  downloading ${iso3} ADM${level} (${variant})`);
      await withRetries(`${iso3} ADM${level} ${variant}`, opts.retries, opts.log, () =>
        downloadOnce(url, file),
      );
      return { status: 'ok', file, variant, meta, fromCache: false };
    } catch (error) {
      lastError = error;
      opts.log(`  ${iso3} ADM${level}: ${variant} geometry unavailable (${String(error)})`);
    }
  }
  throw new Error(`${iso3} ADM${level}: download failed: ${String(lastError)}`);
}

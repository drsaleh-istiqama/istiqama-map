/**
 * Map fonts (glyph PBFs) that keep working offline.
 *
 * The 26 glyph files under `public/map/fonts` (3 MB) are not in the service-worker precache,
 * and without them MapLibre draws no label at all — not even the counts in the cluster circles.
 * The style therefore points at `istiqama-glyphs://{fontstack}/{range}`, served here:
 *
 *   1. the module's own Cache Storage bucket (`istiqama-map-glyphs`) first;
 *   2. online: the self-hosted file, stored in that bucket for next time;
 *   3. offline and not cached: an immediate failure (no request is started, contract §1) —
 *      MapLibre then skips those labels.
 *
 * `prefetchGlyphs()` fills the bucket with the ranges every screen needs (Latin digits, Arabic
 * letters and presentation forms) once the map is up, so a device that has opened the map once
 * online labels it offline too.
 */

export const GLYPH_PROTOCOL = 'istiqama-glyphs';
export const GLYPH_CACHE = 'istiqama-map-glyphs';

/** Fonts shipped in public/map/fonts (anything else is refused without a request). */
export const SHIPPED_FONTS = ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic'] as const;

/** Ranges every map screen needs: Latin + digits, punctuation, Arabic, Arabic presentation forms. */
export const ESSENTIAL_GLYPHS: ReadonlyArray<[string, string]> = [
  ['Noto Sans Regular', '0-255'],
  ['Noto Sans Regular', '1536-1791'],
  ['Noto Sans Regular', '8192-8447'],
  ['Noto Sans Regular', '64256-64511'],
  ['Noto Sans Regular', '64512-64767'],
  ['Noto Sans Regular', '64768-65023'],
  ['Noto Sans Regular', '65024-65279'],
  ['Noto Sans Medium', '0-255'],
  ['Noto Sans Medium', '1536-1791'],
  ['Noto Sans Medium', '65024-65279'],
];

export function glyphTemplate(): string {
  return `${GLYPH_PROTOCOL}://{fontstack}/{range}`;
}

/** `istiqama-glyphs://Noto%20Sans%20Regular/0-255` → font and range, or null when invalid. */
export function parseGlyphUrl(url: string): { font: string; range: string } | null {
  const m = /^istiqama-glyphs:\/\/([^/]+)\/(\d{1,5})-(\d{1,5})(?:\.pbf)?$/.exec(url);
  if (!m) return null;
  let font: string;
  try {
    font = decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
  const start = Number(m[2]);
  const end = Number(m[3]);
  if (start % 256 !== 0 || end !== start + 255 || end > 65535) return null;
  return { font, range: `${start}-${end}` };
}

/** Same-origin file of a glyph range (`<base>map/fonts/<font>/<range>.pbf`). */
export function glyphFileUrl(base: string, font: string, range: string): string {
  return `${base}map/fonts/${encodeURIComponent(font)}/${range}.pbf`;
}

export interface CacheLike {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
}

export interface GlyphDeps {
  /** App base URL with a trailing slash (`https://app.example/`). */
  base: string;
  fetch: typeof fetch;
  online: () => boolean;
  /** The Cache Storage bucket, or null where Cache Storage is unavailable. */
  cache: () => Promise<CacheLike | null>;
}

export class GlyphUnavailableError extends Error {
  constructor(url: string) {
    super(`glyphs not available offline: ${url}`);
    this.name = 'GlyphUnavailableError';
  }
}

async function load(
  deps: GlyphDeps,
  font: string,
  range: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const url = glyphFileUrl(deps.base, font, range);
  const cache = await deps.cache().catch(() => null);
  const hit = await cache?.match(url).catch(() => undefined);
  if (hit) return hit.arrayBuffer();
  if (!deps.online()) throw new GlyphUnavailableError(url);
  const response = await deps.fetch(url, signal ? { signal } : undefined);
  if (!response.ok) throw new GlyphUnavailableError(url);
  const data = await response.arrayBuffer();
  await cache
    ?.put(
      url,
      new Response(data.slice(0), { headers: { 'content-type': 'application/x-protobuf' } }),
    )
    .catch(() => undefined);
  return data;
}

/** MapLibre `addProtocol` handler for `istiqama-glyphs://`. */
export function createGlyphHandler(
  deps: GlyphDeps,
): (request: { url: string }, abort?: AbortController) => Promise<{ data: ArrayBuffer }> {
  return async (request, abort) => {
    const parsed = parseGlyphUrl(request.url);
    if (!parsed || !(SHIPPED_FONTS as readonly string[]).includes(parsed.font))
      throw new GlyphUnavailableError(request.url);
    return { data: await load(deps, parsed.font, parsed.range, abort?.signal) };
  };
}

/** Stores the essential ranges (skips what is cached; does nothing offline). Returns how many were fetched. */
export async function prefetchGlyphs(
  deps: GlyphDeps,
  ranges: ReadonlyArray<[string, string]> = ESSENTIAL_GLYPHS,
): Promise<number> {
  const cache = await deps.cache().catch(() => null);
  if (!cache || !deps.online()) return 0;
  let fetched = 0;
  for (const [font, range] of ranges) {
    if (!deps.online()) break;
    const url = glyphFileUrl(deps.base, font, range);
    if (await cache.match(url).catch(() => undefined)) continue;
    try {
      await load(deps, font, range);
      fetched++;
    } catch {
      // Best effort: the next map visit tries again.
    }
  }
  return fetched;
}

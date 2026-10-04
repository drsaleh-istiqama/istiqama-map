import { describe, expect, it, vi } from 'vitest';
import {
  createGlyphHandler,
  ESSENTIAL_GLYPHS,
  GlyphUnavailableError,
  glyphFileUrl,
  parseGlyphUrl,
  prefetchGlyphs,
  type CacheLike,
  type GlyphDeps,
} from './glyphs';

const BASE = 'http://127.0.0.1:4173/';

function memoryCache(): CacheLike & { store: Map<string, ArrayBuffer> } {
  const store = new Map<string, ArrayBuffer>();
  return {
    store,
    match: async (url) => (store.has(url) ? new Response(store.get(url)!.slice(0)) : undefined),
    put: async (url, response) => void store.set(url, await response.arrayBuffer()),
  };
}

function deps(overrides: Partial<GlyphDeps> = {}) {
  const cache = memoryCache();
  const online = { value: true };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    return url.includes('missing')
      ? new Response('', { status: 404 })
      : new Response(new TextEncoder().encode(url));
  });
  const d: GlyphDeps = {
    base: BASE,
    fetch: fetchMock as unknown as typeof fetch,
    online: () => online.value,
    cache: async () => cache,
    ...overrides,
  };
  return { d, cache, online, fetchMock };
}

describe('glyph protocol (offline-capable map fonts)', () => {
  it('parses MapLibre glyph URLs and refuses anything else', () => {
    expect(parseGlyphUrl('istiqama-glyphs://Noto%20Sans%20Regular/0-255')).toEqual({
      font: 'Noto Sans Regular',
      range: '0-255',
    });
    expect(parseGlyphUrl('istiqama-glyphs://Noto%20Sans%20Medium/65024-65279')?.range).toBe(
      '65024-65279',
    );
    expect(parseGlyphUrl('istiqama-glyphs://..%2F..%2Fsecret/0-255')?.font).toBe('../../secret');
    expect(parseGlyphUrl('istiqama-glyphs://Noto/0-100')).toBeNull();
    expect(parseGlyphUrl('https://fonts.example/Noto/0-255')).toBeNull();
    expect(glyphFileUrl(BASE, 'Noto Sans Regular', '0-255')).toBe(
      'http://127.0.0.1:4173/map/fonts/Noto%20Sans%20Regular/0-255.pbf',
    );
  });

  it('fetches a range once from our own origin, then serves it from the cache', async () => {
    const { d, fetchMock, online } = deps();
    const handler = createGlyphHandler(d);
    const url = 'istiqama-glyphs://Noto%20Sans%20Regular/1536-1791';
    const first = await handler({ url });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4173/map/fonts/Noto%20Sans%20Regular/1536-1791.pbf',
      undefined,
    );
    online.value = false;
    const second = await handler({ url });
    expect(new Uint8Array(second.data)).toEqual(new Uint8Array(first.data));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('offline and not cached: fails at once without a request', async () => {
    const { d, fetchMock, online } = deps();
    online.value = false;
    await expect(
      createGlyphHandler(d)({ url: 'istiqama-glyphs://Noto%20Sans%20Regular/0-255' }),
    ).rejects.toBeInstanceOf(GlyphUnavailableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses fonts that are not shipped (no request, no path tricks)', async () => {
    const { d, fetchMock } = deps();
    const handler = createGlyphHandler(d);
    await expect(
      handler({ url: 'istiqama-glyphs://Noto%20Sans%20Devanagari%20Regular%20v1/0-255' }),
    ).rejects.toThrow();
    await expect(
      handler({ url: 'istiqama-glyphs://..%2F..%2Findex.html/0-255' }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('works without Cache Storage (plain fetch)', async () => {
    const { d, fetchMock } = deps({ cache: async () => null });
    await createGlyphHandler(d)({ url: 'istiqama-glyphs://Noto%20Sans%20Italic/0-255' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('prefetch stores the essential ranges once and does nothing offline', async () => {
    const { d, cache, fetchMock, online } = deps();
    expect(await prefetchGlyphs(d)).toBe(ESSENTIAL_GLYPHS.length);
    expect(cache.store.size).toBe(ESSENTIAL_GLYPHS.length);
    expect(await prefetchGlyphs(d)).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(ESSENTIAL_GLYPHS.length);
    online.value = false;
    const offline = deps();
    offline.online.value = false;
    expect(await prefetchGlyphs(offline.d)).toBe(0);
    expect(offline.fetchMock).not.toHaveBeenCalled();
  });

  it('every essential range exists in public/map/fonts', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const root = path.resolve(__dirname, '..', '..', 'public', 'map', 'fonts');
    for (const [font, range] of ESSENTIAL_GLYPHS)
      expect(fs.existsSync(path.join(root, font, `${range}.pbf`)), `${font}/${range}`).toBe(true);
  });
});

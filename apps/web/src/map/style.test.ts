import { describe, expect, it } from 'vitest';
import { spriteUrl } from './config';
import { glyphTemplate } from './glyphs';
import { CLICKABLE_LAYERS, LAYER, SOURCE, serverPointsFilter } from './layers';
import { basemapTileJsonUrl, buildMapStyle, urlsInStyle, type MapStyleOptions } from './style';
import { projectTilesUrl, tileFilters } from './tiles';

const APP = 'http://127.0.0.1:4173/';
const SUPABASE = 'http://127.0.0.1:54321';

function options(overrides: Partial<MapStyleOptions> = {}): MapStyleOptions {
  return {
    lang: 'ar',
    glyphs: glyphTemplate(),
    sprite: spriteUrl(APP),
    basemapTileJson: basemapTileJsonUrl(1),
    projectTiles: projectTilesUrl(`${SUPABASE}/functions/v1`, tileFilters({}, false), 'abc'),
    heat: null,
    numberLocale: 'ar-u-nu-latn',
    ...overrides,
  };
}

const ALLOWED = [APP, `${SUPABASE}/`, 'istiqama-basemap://', 'istiqama-glyphs://'];

describe('buildMapStyle', () => {
  it('contains no external URL anywhere (glyphs, sprite, sources, attribution, expressions)', () => {
    for (const lang of ['ar', 'sw', 'en'] as const) {
      for (const heat of [null, 'maintenance', 'quran_need', 'housing'] as const) {
        const style = buildMapStyle(options({ lang, heat }));
        const urls = urlsInStyle(style);
        expect(urls.length).toBeGreaterThanOrEqual(4);
        const foreign = urls.filter((u) => !ALLOWED.some((prefix) => u.startsWith(prefix)));
        expect(foreign).toEqual([]);
        const text = JSON.stringify(style);
        expect(text).not.toMatch(/openstreetmap\.org|protomaps\.(com|github\.io)|mapbox\.com/i);
        expect(text).not.toMatch(/fonts\.googleapis|maptiler|carto/i);
      }
    }
  });

  it('reads glyphs through the offline-capable protocol and the sprite from the app', () => {
    const style = buildMapStyle(options());
    expect(style.glyphs).toBe('istiqama-glyphs://{fontstack}/{range}');
    expect(style.sprite).toBe(`${APP}map/sprites/light`);
  });

  it('uses only the fonts shipped in public/map/fonts', () => {
    const shipped = new Set(['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic']);
    // Devanagari only appears in a per-feature "case" branch that East African data never takes.
    const optional = new Set(['Noto Sans Devanagari Regular v1']);
    const fonts = new Set<string>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') {
        for (const [key, v] of Object.entries(value)) {
          if (key === 'text-font') {
            const collect = (x: unknown): void => {
              if (typeof x === 'string' && x.startsWith('Noto')) fonts.add(x);
              else if (Array.isArray(x)) x.forEach(collect);
            };
            collect(v);
          }
          visit(v);
        }
      }
    };
    for (const lang of ['ar', 'sw', 'en'] as const) visit(buildMapStyle(options({ lang })));
    expect(fonts.size).toBeGreaterThan(0);
    for (const font of fonts) expect(shipped.has(font) || optional.has(font), font).toBe(true);
  });

  it('labels the basemap in the interface language (Arabic names in Arabic)', () => {
    const ar = JSON.stringify(buildMapStyle(options({ lang: 'ar' })).layers);
    const en = JSON.stringify(buildMapStyle(options({ lang: 'en' })).layers);
    const sw = JSON.stringify(buildMapStyle(options({ lang: 'sw' })).layers);
    expect(ar).toContain('name:ar');
    expect(en).toContain('name:en');
    expect(sw).toContain('name:sw');
    expect(en).not.toContain('name:ar');
  });

  it('declares the basemap and project sources with the expected zoom ranges', () => {
    const style = buildMapStyle(options());
    const basemap = style.sources[SOURCE.basemap] as { type: string; url: string };
    expect(basemap.type).toBe('vector');
    expect(basemap.url).toBe('istiqama-basemap://tilejson/1');
    const projects = style.sources[SOURCE.projects] as {
      type: string;
      tiles: string[];
      maxzoom: number;
    };
    expect(projects.type).toBe('vector');
    expect(projects.maxzoom).toBe(14);
    expect(projects.tiles[0]).toMatch(
      /^http:\/\/127\.0\.0\.1:54321\/functions\/v1\/tiles\/\{z\}\/\{x\}\/\{y\}\?f=/,
    );
    expect(style.sources[SOURCE.local]).toMatchObject({ type: 'geojson', promoteId: 'id' });
  });

  it('draws project layers above the basemap, in a stable order', () => {
    const ids = buildMapStyle(options()).layers.map((l) => l.id);
    const first = ids.indexOf(LAYER.heat);
    expect(first).toBeGreaterThan(10); // basemap layers come first
    expect(ids.slice(first)).toEqual([
      LAYER.heat,
      LAYER.clusters,
      LAYER.clusterCount,
      LAYER.clusterSingle,
      LAYER.serverPoints,
      LAYER.localPoints,
      LAYER.localLabels,
      LAYER.selection,
      LAYER.locateAccuracy,
      LAYER.locateDot,
      LAYER.pick,
    ]);
    for (const id of CLICKABLE_LAYERS) expect(ids).toContain(id);
  });

  it('server point layer starts at z14 and reads the "points" layer; clusters read "clusters"', () => {
    const layers = buildMapStyle(options()).layers as Array<Record<string, unknown>>;
    const byId = new Map(layers.map((l) => [l.id, l]));
    expect(byId.get(LAYER.serverPoints)).toMatchObject({ minzoom: 14, 'source-layer': 'points' });
    expect(byId.get(LAYER.clusters)).toMatchObject({ 'source-layer': 'clusters' });
    expect(byId.get(LAYER.heat)).toMatchObject({ 'source-layer': 'needs' });
  });

  it('shows exactly the chosen heat map', () => {
    const hidden = buildMapStyle(options({ heat: null })).layers.find((l) => l.id === LAYER.heat);
    expect((hidden as { layout: { visibility: string } }).layout.visibility).toBe('none');
    const shown = buildMapStyle(options({ heat: 'quran_need' })).layers.find(
      (l) => l.id === LAYER.heat,
    ) as { layout: { visibility: string }; paint: Record<string, unknown> };
    expect(shown.layout.visibility).toBe('visible');
    expect(JSON.stringify(shown.paint['heatmap-weight'])).toContain('quran_need');
  });

  it('without a basemap or a session still renders a background and the local layers', () => {
    const style = buildMapStyle(options({ basemapTileJson: null, projectTiles: null }));
    expect(style.sources[SOURCE.basemap]).toBeUndefined();
    expect(style.sources[SOURCE.projects]).toBeUndefined();
    const ids = style.layers.map((l) => l.id);
    expect(ids[0]).toBe('background');
    expect(ids).toContain(LAYER.localPoints);
    expect(ids).not.toContain(LAYER.clusters);
  });

  it('server points exclude the projects drawn from the local database', () => {
    expect(serverPointsFilter([])).toEqual(['has', 'id']);
    expect(serverPointsFilter(['a', 'b'])).toEqual([
      '!',
      ['in', ['get', 'id'], ['literal', ['a', 'b']]],
    ]);
  });
});

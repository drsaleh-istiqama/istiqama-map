/**
 * The complete MapLibre style: Protomaps basemap (flavour "light", labels in the interface
 * language) + the project layers. Pure: the same inputs give the same JSON, and nothing in it
 * points outside our own origins (unit-tested).
 *
 * The basemap source is served by the `istiqama-basemap://` protocol (basemapProtocol.ts):
 * an installed offline pack first, then the online archive on our storage.
 */
import { layers as protomapsLayers, namedFlavor } from '@protomaps/basemaps';
import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';
import type { Locale } from '../i18n';
import { BASEMAP_ATTRIBUTION } from './config';
import { projectLayers, projectSources, SOURCE, type HeatKind } from './layers';

export const BASEMAP_PROTOCOL = 'istiqama-basemap';

export { BASEMAP_ATTRIBUTION };

/**
 * Basemap label language. Arabic and English have their own `name:*` tags in OpenStreetMap;
 * Swahili names exist for many East African places and fall back to English otherwise.
 */
export function basemapLanguage(l: Locale): string {
  return l;
}

/** TileJSON URL of the basemap source. `revision` changes force MapLibre to ask again. */
export function basemapTileJsonUrl(revision: number): string {
  return `${BASEMAP_PROTOCOL}://tilejson/${revision}`;
}

export interface MapStyleOptions {
  lang: Locale;
  glyphs: string;
  sprite: string;
  /** null = no basemap at all (VITE_TILES_URL not configured and no pack installed). */
  basemapTileJson: string | null;
  projectTiles: string | null;
  heat: HeatKind | null;
  numberLocale: string;
}

export function basemapLayers(lang: Locale): LayerSpecification[] {
  return protomapsLayers(SOURCE.basemap, namedFlavor('light'), {
    lang: basemapLanguage(lang),
  }) as LayerSpecification[];
}

export function buildMapStyle(opts: MapStyleOptions): StyleSpecification {
  const base: LayerSpecification[] = opts.basemapTileJson
    ? basemapLayers(opts.lang)
    : [
        {
          id: 'background',
          type: 'background',
          paint: { 'background-color': '#e2dfda' },
        },
      ];
  const sources: StyleSpecification['sources'] = {
    ...projectSources({
      projectTiles: opts.projectTiles,
      lang: opts.lang,
      heat: opts.heat,
      numberLocale: opts.numberLocale,
    }),
  };
  if (opts.basemapTileJson) {
    sources[SOURCE.basemap] = {
      type: 'vector',
      url: opts.basemapTileJson,
      attribution: BASEMAP_ATTRIBUTION,
    };
  }
  return {
    version: 8,
    glyphs: opts.glyphs,
    sprite: opts.sprite,
    sources,
    layers: [
      ...base,
      ...projectLayers({
        projectTiles: opts.projectTiles,
        lang: opts.lang,
        heat: opts.heat,
        numberLocale: opts.numberLocale,
      }),
    ],
  };
}

/** Every URL-like string in a style (used by the tests and by a dev-time guard). */
export function urlsInStyle(style: unknown): string[] {
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith('//')) found.push(value);
      else for (const m of value.matchAll(/https?:\/\/[^\s"'<>)]+/gi)) found.push(m[0]);
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(style);
  return found;
}

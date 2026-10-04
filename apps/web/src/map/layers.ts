/**
 * Project layers on top of the basemap: server clusters (z < 14), server points (z ≥ 14,
 * fallback for projects that are not on the device), local points from IndexedDB (z ≥ 14 and
 * projects created on this device that the server does not know yet), heat maps of needs,
 * the "my location" marker, the selection ring and the pick-mode marker.
 *
 * Colours keep v2's legend semantics (docs/V2_PARITY.md 1.2–1.3): one colour per project type
 * and a dedicated colour for "needs maintenance", which wins over the type colour.
 * Pure data — the specs are plain JSON and unit-tested.
 */
import type { FeatureCollection } from 'geojson';
import type {
  ExpressionSpecification,
  FilterSpecification,
  LayerSpecification,
  SourceSpecification,
} from 'maplibre-gl';

export const TYPE_COLORS = {
  mosque: '#0d5c4b',
  school: '#286c98',
  combined: '#72528b',
} as const;
/** Contract status colour of "maintenance" (docs/contracts/web.md §1). */
export const MAINTENANCE_COLOR = '#b54708';
export const CLUSTER_COLOR = '#0f2545';
export const GOLD = '#c8a24a';
export const LOCATE_COLOR = '#175cd3';
export const CLUSTER_TEXT_FONT = ['Noto Sans Medium'];
export const LABEL_FONT = ['Noto Sans Regular'];

/** Legend entries in display order (v2: mosque, school, combined, maintenance). */
export const LEGEND: ReadonlyArray<{ key: string; color: string; labelKey: string }> = [
  { key: 'mosque', color: TYPE_COLORS.mosque, labelKey: 'enum.project_type.mosque' },
  { key: 'school', color: TYPE_COLORS.school, labelKey: 'enum.project_type.school' },
  { key: 'combined', color: TYPE_COLORS.combined, labelKey: 'enum.project_type.combined' },
  {
    key: 'maintenance',
    color: MAINTENANCE_COLOR,
    labelKey: 'enum.project_status.maintenance',
  },
];

/** Needs that have a heat map (brief §9.2) and the scale at which a cell counts as "hot". */
export const HEAT_KINDS = ['maintenance', 'quran_need', 'housing'] as const;
export type HeatKind = (typeof HEAT_KINDS)[number];
const HEAT_SCALE: Record<HeatKind, number> = { maintenance: 2, quran_need: 100, housing: 2 };

export function isHeatKind(value: unknown): value is HeatKind {
  return typeof value === 'string' && (HEAT_KINDS as readonly string[]).includes(value);
}

// --- ids -------------------------------------------------------------------------------------

export const SOURCE = {
  basemap: 'basemap',
  projects: 'projects',
  local: 'local-projects',
  locate: 'locate',
  selection: 'selection',
  pick: 'pick',
} as const;

export const LAYER = {
  heat: 'projects-heat',
  clusters: 'clusters-multi',
  clusterCount: 'clusters-count',
  clusterSingle: 'clusters-single',
  serverPoints: 'server-points',
  localPoints: 'local-points',
  localLabels: 'local-labels',
  selection: 'selection-ring',
  locateAccuracy: 'locate-accuracy',
  locateDot: 'locate-dot',
  pick: 'pick-point',
} as const;

/** Layers whose features open a project when tapped. */
export const CLICKABLE_LAYERS: readonly string[] = [
  LAYER.clusters,
  LAYER.clusterSingle,
  LAYER.serverPoints,
  LAYER.localPoints,
];

// --- expressions -----------------------------------------------------------------------------

/** Maintenance colour first, then the type colour (v2 marker rule). */
export const projectColor: ExpressionSpecification = [
  'case',
  ['==', ['get', 'status'], 'maintenance'],
  MAINTENANCE_COLOR,
  [
    'match',
    ['get', 'type'],
    'mosque',
    TYPE_COLORS.mosque,
    'school',
    TYPE_COLORS.school,
    'combined',
    TYPE_COLORS.combined,
    CLUSTER_COLOR,
  ],
];

const clusterRadius: ExpressionSpecification = [
  'step',
  ['get', 'count'],
  12,
  10,
  16,
  100,
  20,
  1000,
  25,
];

export function heatWeight(kind: HeatKind): ExpressionSpecification {
  return ['min', 1, ['/', ['coalesce', ['get', kind], 0], HEAT_SCALE[kind]]];
}

export function heatFilter(kind: HeatKind): FilterSpecification {
  return ['>', ['coalesce', ['get', kind], 0], 0];
}

/** Server points minus the projects drawn from the local database (no double markers). */
export function serverPointsFilter(localIds: readonly string[]): FilterSpecification {
  if (localIds.length === 0) return ['has', 'id'];
  return ['!', ['in', ['get', 'id'], ['literal', [...localIds]]]];
}

/** Label of a local point in the interface language (Arabic name first in Arabic). */
export function nameExpression(lang: 'ar' | 'sw' | 'en'): ExpressionSpecification {
  return lang === 'ar'
    ? ['coalesce', ['get', 'name_ar'], ['get', 'name_latin'], '']
    : ['coalesce', ['get', 'name_latin'], ['get', 'name_ar'], ''];
}

// --- sources and layers ------------------------------------------------------------------------

const emptyCollection = (): FeatureCollection => ({ type: 'FeatureCollection', features: [] });

export interface ProjectLayerOptions {
  /** Tile URL template of the project tiles, or null (not signed in / not configured). */
  projectTiles: string | null;
  lang: 'ar' | 'sw' | 'en';
  /** Heat map to show (null = none). */
  heat: HeatKind | null;
  /** `Intl` locale used to format cluster counts. */
  numberLocale: string;
}

export function projectSources(opts: ProjectLayerOptions): Record<string, SourceSpecification> {
  const sources: Record<string, SourceSpecification> = {
    [SOURCE.local]: { type: 'geojson', data: emptyCollection(), promoteId: 'id' },
    [SOURCE.locate]: { type: 'geojson', data: emptyCollection() },
    [SOURCE.selection]: { type: 'geojson', data: emptyCollection() },
    [SOURCE.pick]: { type: 'geojson', data: emptyCollection() },
  };
  if (opts.projectTiles) {
    sources[SOURCE.projects] = {
      type: 'vector',
      tiles: [opts.projectTiles],
      minzoom: 0,
      // z > 14 over-zooms the z14 tile ("points" layer), §6.
      maxzoom: 14,
    };
  }
  return sources;
}

export function projectLayers(opts: ProjectLayerOptions): LayerSpecification[] {
  const layers: LayerSpecification[] = [];
  if (opts.projectTiles) {
    const heat = opts.heat;
    layers.push(
      {
        id: LAYER.heat,
        type: 'heatmap',
        source: SOURCE.projects,
        'source-layer': 'needs',
        // Hidden layers are not evaluated; the filter only matters once a heat map is chosen.
        filter: heatFilter(heat ?? 'maintenance'),
        layout: { visibility: heat ? 'visible' : 'none' },
        paint: {
          'heatmap-weight': heatWeight(heat ?? 'maintenance'),
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 4, 1.5, 14, 3],
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 4, 25, 10, 40, 14, 55],
          'heatmap-opacity': 0.75,
          'heatmap-color': [
            'interpolate',
            ['linear'],
            ['heatmap-density'],
            0,
            'rgba(255,255,255,0)',
            0.2,
            '#fde7b0',
            0.45,
            '#f6b24a',
            0.7,
            '#d9661f',
            1,
            '#9a2a0a',
          ],
        },
      },
      {
        id: LAYER.clusters,
        type: 'circle',
        source: SOURCE.projects,
        'source-layer': 'clusters',
        filter: ['>', ['get', 'count'], 1],
        paint: {
          'circle-color': CLUSTER_COLOR,
          'circle-radius': clusterRadius,
          'circle-opacity': 0.92,
          // A maintenance ring tells at a glance where something needs attention.
          'circle-stroke-color': [
            'case',
            ['>', ['coalesce', ['get', 'st_maintenance'], 0], 0],
            MAINTENANCE_COLOR,
            '#ffffff',
          ],
          'circle-stroke-width': [
            'case',
            ['>', ['coalesce', ['get', 'st_maintenance'], 0], 0],
            3,
            2,
          ],
        },
      },
      {
        id: LAYER.clusterCount,
        type: 'symbol',
        source: SOURCE.projects,
        'source-layer': 'clusters',
        filter: ['>', ['get', 'count'], 1],
        layout: {
          'text-field': ['number-format', ['get', 'count'], { locale: opts.numberLocale }],
          'text-font': CLUSTER_TEXT_FONT,
          'text-size': 12,
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: { 'text-color': '#ffffff' },
      },
      {
        id: LAYER.clusterSingle,
        type: 'circle',
        source: SOURCE.projects,
        'source-layer': 'clusters',
        filter: ['==', ['get', 'count'], 1],
        paint: {
          'circle-color': projectColor,
          'circle-radius': 7,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      },
      {
        id: LAYER.serverPoints,
        type: 'circle',
        source: SOURCE.projects,
        'source-layer': 'points',
        minzoom: 14,
        filter: serverPointsFilter([]),
        paint: {
          'circle-color': projectColor,
          'circle-radius': 8,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      },
    );
  }
  layers.push(
    {
      id: LAYER.localPoints,
      type: 'circle',
      source: SOURCE.local,
      paint: {
        'circle-color': projectColor,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 6, 14, 8, 18, 10],
        // Gold ring: saved on this device, not uploaded yet.
        'circle-stroke-color': ['case', ['==', ['get', 'dirty'], true], GOLD, '#ffffff'],
        'circle-stroke-width': ['case', ['==', ['get', 'dirty'], true], 3, 2],
      },
    },
    {
      id: LAYER.localLabels,
      type: 'symbol',
      source: SOURCE.local,
      minzoom: 15,
      layout: {
        'text-field': nameExpression(opts.lang),
        'text-font': LABEL_FONT,
        'text-size': 12,
        'text-offset': [0, 1.3],
        'text-anchor': 'top',
        'text-max-width': 10,
        'text-optional': true,
      },
      paint: {
        'text-color': '#1b2433',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.5,
      },
    },
    {
      id: LAYER.selection,
      type: 'circle',
      source: SOURCE.selection,
      paint: {
        'circle-radius': 15,
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': GOLD,
        'circle-stroke-width': 4,
      },
    },
    {
      id: LAYER.locateAccuracy,
      type: 'fill',
      source: SOURCE.locate,
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: {
        'fill-color': LOCATE_COLOR,
        'fill-opacity': 0.12,
        'fill-outline-color': LOCATE_COLOR,
      },
    },
    {
      id: LAYER.locateDot,
      type: 'circle',
      source: SOURCE.locate,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': 7,
        'circle-color': LOCATE_COLOR,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 3,
      },
    },
    {
      id: LAYER.pick,
      type: 'circle',
      source: SOURCE.pick,
      paint: {
        'circle-radius': 9,
        'circle-color': CLUSTER_COLOR,
        'circle-stroke-color': GOLD,
        'circle-stroke-width': 4,
      },
    },
  );
  return layers;
}

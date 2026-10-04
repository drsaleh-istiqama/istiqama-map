/**
 * The imperative MapLibre side of <MapView>: creates the map, keeps its style in step with the
 * view state (language, filter, heat map, basemap revision), feeds the local project layer
 * from IndexedDB, and turns taps into "open this project" or "this point was picked".
 *
 * Only this file (and MapView.tsx) import maplibre-gl, so MapLibre lives in the lazy map
 * chunk (docs/contracts/web.md §1).
 */
import { liveQuery, type Subscription } from 'dexie';
import {
  addProtocol,
  AttributionControl,
  Map as MapLibreMap,
  NavigationControl,
  setWorkerUrl,
  type GeoJSONSource,
  type MapGeoJSONFeature,
  type StyleSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// The worker is bundled by Vite into a self-contained same-origin file (CSP worker-src 'self').
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { ProjectFilter } from '../db';
import type { Locale } from '../i18n';
import type { BBox, LonLat } from '../lib/geo';
import { basemapProvider } from './basemapRuntime';
import { PROTOCOL } from './basemapProtocol';
import { appBase, POINTS_MIN_ZOOM, PROJECT_ZOOM, spriteUrl } from './config';
import {
  createGlyphHandler,
  GLYPH_CACHE,
  GLYPH_PROTOCOL,
  glyphTemplate,
  prefetchGlyphs,
  type GlyphDeps,
} from './glyphs';
import { inVisiblePart, NO_INSETS, sameInsets, visibleCentre, type Insets } from './insets';
import { CLICKABLE_LAYERS, LAYER, serverPointsFilter, SOURCE, type HeatKind } from './layers';
import { LocateController, locateFeatures, zoomForAccuracy, type LocateResult } from './locate';
import { localCollection, localProjectsInView, pendingNewProjects } from './queries';
import { basemapTileJsonUrl, buildMapStyle } from './style';
import { createTransformRequest, projectTilesUrl, tileFilters, type TransformDeps } from './tiles';

let globalsReady = false;
let glyphsPrefetched = false;

const glyphDeps: GlyphDeps = {
  base: appBase(),
  fetch: (input, init) => fetch(input, init),
  online: () => typeof navigator === 'undefined' || navigator.onLine !== false,
  cache: async () => (typeof caches === 'undefined' ? null : caches.open(GLYPH_CACHE)),
};

/** Worker URL and the custom protocols are global to MapLibre: set them once per page. */
function setupGlobals(): void {
  if (globalsReady) return;
  globalsReady = true;
  setWorkerUrl(workerUrl);
  const provider = basemapProvider();
  addProtocol(
    PROTOCOL,
    (params, abort) =>
      provider.handle(params, abort) as Promise<{ data: ArrayBuffer | Uint8Array | object }>,
  );
  addProtocol(GLYPH_PROTOCOL, createGlyphHandler(glyphDeps));
}

/** Once per page, after the first map is up: keep the essential label fonts for offline use. */
function prefetchGlyphsOnce(): void {
  if (glyphsPrefetched) return;
  glyphsPrefetched = true;
  setTimeout(() => void prefetchGlyphs(glyphDeps), 3000);
}

export interface EngineView {
  center: LonLat;
  zoom: number;
}

export interface EngineCallbacks {
  /** A project was tapped; `point` is where it is drawn (tiles carry no coordinates otherwise). */
  onSelectProject?: (id: string, properties: Record<string, unknown>, point?: LonLat) => void;
  onPick?: (p: LonLat) => void;
  /** `center` is the middle of the whole map (not of the padded part), so it can be restored. */
  onMoveEnd?: (view: EngineView) => void;
  onReady?: () => void;
  /** WebGL missing / context lost: the view shows a text fallback. */
  onFatal?: (error: unknown) => void;
}

export interface EngineOptions {
  container: HTMLElement;
  mode: 'browse' | 'pick';
  lang: Locale;
  numberLocale: string;
  filter: ProjectFilter;
  heat: HeatKind | null;
  /** Project tiles are fetched only for a signed-in user with a known scope. */
  tiles: (TransformDeps & { scopeEpoch: string | null }) | null;
  basemapRevision: number;
  initial: { center: LonLat; zoom: number } | { bounds: BBox };
  /** MapLibre control labels in the interface language. */
  controlLabels: Record<string, string>;
  callbacks: EngineCallbacks;
}

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const point = (p: LonLat): GeoJSON.FeatureCollection => ({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } },
  ],
});

export class MapEngine {
  readonly map: MapLibreMap;
  private opts: EngineOptions;
  private destroyed = false;
  private localSub: Subscription | null = null;
  private localTimer: ReturnType<typeof setTimeout> | null = null;
  private localIds: string[] = [];
  private data: Record<string, GeoJSON.FeatureCollection> = {
    [SOURCE.local]: EMPTY,
    [SOURCE.locate]: EMPTY,
    [SOURCE.selection]: EMPTY,
    [SOURCE.pick]: EMPTY,
  };
  readonly locator: LocateController<true>;
  /** Camera padding: the parts of the map hidden by panels (insets.ts). */
  private insets: Insets = { ...NO_INSETS };
  /** New insets arrived while the user was moving the map: applied at the next moveend. */
  private insetsPending = false;
  /** Our own flight to a project, re-aimed when the insets change on the way. */
  private flight: { center: LonLat; zoom: number } | null = null;
  private selection: LonLat | null = null;

  constructor(opts: EngineOptions) {
    setupGlobals();
    this.opts = opts;
    const transform = opts.tiles ? createTransformRequest(opts.tiles) : undefined;
    const initial = opts.initial;
    this.map = new MapLibreMap({
      container: opts.container,
      style: this.buildStyle(),
      ...('bounds' in initial
        ? { bounds: initial.bounds, fitBoundsOptions: { padding: 40, maxZoom: 12 } }
        : { center: [initial.center.lon, initial.center.lat], zoom: initial.zoom }),
      maxZoom: 19,
      // Added below at the inline end, the corner of "my location" (map.css keeps them apart).
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      maxPitch: 0,
      locale: opts.controlLabels,
      ...(transform ? { transformRequest: transform } : {}),
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.keyboard.disableRotation();
    const rtl = opts.lang === 'ar';
    this.map.addControl(
      new NavigationControl({ showCompass: false }),
      rtl ? 'top-left' : 'top-right',
    );
    this.map.addControl(
      new AttributionControl({ compact: true }),
      rtl ? 'bottom-left' : 'bottom-right',
    );

    this.locator = new LocateController<true>(
      {
        createMarker: (p, accuracy) => {
          this.setData(SOURCE.locate, locateFeatures(p, accuracy));
          return true;
        },
        updateMarker: (_m, p, accuracy) => this.setData(SOURCE.locate, locateFeatures(p, accuracy)),
        removeMarker: () => this.setData(SOURCE.locate, EMPTY),
        focus: (p, accuracy) =>
          this.map.flyTo({
            center: [p.lon, p.lat],
            zoom: Math.max(this.map.getZoom(), zoomForAccuracy(accuracy)),
          }),
      },
      typeof navigator !== 'undefined' ? navigator.geolocation : null,
    );

    // MapLibre logs every failed resource with console.error unless someone listens.
    this.map.on('error', (event) => {
      const message = (event as { error?: { message?: string } }).error?.message ?? '';
      if (/webgl|context/i.test(message)) opts.callbacks.onFatal?.(event);
    });
    // Ready as soon as the style is usable — not on 'load', which waits for every tile and
    // never comes while one source is unreachable (offline, a dropped 3G link).
    let ready = false;
    this.map.on('style.load', () => {
      this.reapplyDynamic();
      if (ready) return;
      ready = true;
      this.scheduleLocalRefresh(0);
      prefetchGlyphsOnce();
      opts.callbacks.onReady?.();
    });
    this.map.on('moveend', () => {
      // Also fired synchronously when one of our animations is replaced by the next one:
      // startFlight() records its flight after starting it.
      this.flight = null;
      if (this.insetsPending && !this.map.isMoving()) this.applyInsets();
      this.scheduleLocalRefresh(150);
      const { clientWidth: w, clientHeight: h } = this.map.getContainer();
      const c = w > 0 && h > 0 ? this.map.unproject([w / 2, h / 2]) : this.map.getCenter();
      opts.callbacks.onMoveEnd?.({ center: { lon: c.lng, lat: c.lat }, zoom: this.map.getZoom() });
    });
    this.map.on('click', (event) => this.onClick(event.point, event.lngLat));
    this.map.on('mousemove', (event) => {
      if (this.opts.mode === 'pick') return;
      const hit = this.featuresAt(event.point).length > 0;
      this.map.getCanvas().style.cursor = hit ? 'pointer' : '';
    });
    this.map.on('webglcontextlost', () =>
      opts.callbacks.onFatal?.(new Error('webgl context lost')),
    );
  }

  // --- style -------------------------------------------------------------------------------

  private buildStyle(): StyleSpecification {
    const o = this.opts;
    return buildMapStyle({
      lang: o.lang,
      glyphs: glyphTemplate(),
      sprite: spriteUrl(),
      basemapTileJson: basemapTileJsonUrl(o.basemapRevision),
      projectTiles: o.tiles
        ? projectTilesUrl(
            o.tiles.functionsBase,
            tileFilters(o.filter, o.heat !== null),
            o.tiles.scopeEpoch,
          )
        : null,
      heat: o.mode === 'pick' ? null : o.heat,
      numberLocale: o.numberLocale,
    });
  }

  /** Applies a changed view state; the style diff touches only what changed. */
  update(patch: Partial<Omit<EngineOptions, 'container' | 'callbacks' | 'initial'>>): void {
    const before = this.opts;
    this.opts = { ...before, ...patch };
    const styleChanged =
      patch.lang !== undefined ||
      patch.heat !== undefined ||
      patch.basemapRevision !== undefined ||
      patch.numberLocale !== undefined ||
      patch.tiles !== undefined ||
      patch.filter !== undefined;
    if (patch.tiles !== undefined && patch.tiles)
      this.map.setTransformRequest(createTransformRequest(patch.tiles));
    if (styleChanged) {
      this.map.setStyle(this.buildStyle(), { diff: true });
      this.reapplyDynamic();
    }
    if (patch.filter !== undefined) this.scheduleLocalRefresh(0);
  }

  // --- dynamic sources -------------------------------------------------------------------------

  private setData(source: string, data: GeoJSON.FeatureCollection): void {
    this.data[source] = data;
    const s = this.map.getSource(source) as GeoJSONSource | undefined;
    s?.setData(data);
  }

  /** After any style (re)load: GeoJSON data and the de-duplication filter come back. */
  private reapplyDynamic(): void {
    if (this.destroyed) return;
    for (const [id, data] of Object.entries(this.data)) {
      (this.map.getSource(id) as GeoJSONSource | undefined)?.setData(data);
    }
    if (this.map.getLayer(LAYER.serverPoints))
      this.map.setFilter(LAYER.serverPoints, serverPointsFilter(this.localIds));
  }

  private scheduleLocalRefresh(delay: number): void {
    if (this.localTimer) clearTimeout(this.localTimer);
    this.localTimer = setTimeout(() => this.refreshLocal(), delay);
  }

  /**
   * Local projects: at z ≥ 14 every project of the viewport (unsynced ones included), at any
   * zoom the projects created on this device and not uploaded yet. Live: re-runs when the
   * local rows change (a sync, an edit).
   */
  private refreshLocal(): void {
    if (this.destroyed) return;
    this.localSub?.unsubscribe();
    const zoom = this.map.getZoom();
    const b = this.map.getBounds();
    const padX = (b.getEast() - b.getWest()) * 0.1;
    const padY = (b.getNorth() - b.getSouth()) * 0.1;
    const bbox: BBox = [
      b.getWest() - padX,
      b.getSouth() - padY,
      b.getEast() + padX,
      b.getNorth() + padY,
    ];
    const filter = this.opts.filter;
    const inView = zoom >= POINTS_MIN_ZOOM;
    this.localSub = liveQuery(async () => {
      const [rows, pending] = await Promise.all([
        inView ? localProjectsInView(bbox, filter, 2000) : Promise.resolve([]),
        pendingNewProjects(filter),
      ]);
      return { rows, pending };
    }).subscribe({
      next: ({ rows, pending }) => {
        if (this.destroyed) return;
        const collection = localCollection(rows, pending);
        this.localIds = collection.features.map((f) => f.properties.id);
        this.setData(SOURCE.local, collection);
        if (this.map.getLayer(LAYER.serverPoints))
          this.map.setFilter(LAYER.serverPoints, serverPointsFilter(this.localIds));
      },
      error: () => undefined,
    });
  }

  // --- interaction ---------------------------------------------------------------------------

  private featuresAt(p: { x: number; y: number }): MapGeoJSONFeature[] {
    const layers = CLICKABLE_LAYERS.filter((id) => this.map.getLayer(id));
    if (layers.length === 0) return [];
    // A 24 px box: easier to hit with a thumb than the exact pixel.
    return this.map.queryRenderedFeatures(
      [
        [p.x - 12, p.y - 12],
        [p.x + 12, p.y + 12],
      ],
      { layers },
    );
  }

  private onClick(p: { x: number; y: number }, lngLat: { lng: number; lat: number }): void {
    if (this.opts.mode === 'pick') {
      this.opts.callbacks.onPick?.({ lon: lngLat.lng, lat: lngLat.lat });
      return;
    }
    const features = this.featuresAt(p);
    if (features.length === 0) return;
    const order: string[] = [
      LAYER.localPoints,
      LAYER.serverPoints,
      LAYER.clusterSingle,
      LAYER.clusters,
    ];
    const rank = (f: MapGeoJSONFeature): number => order.indexOf(f.layer.id);
    const best = [...features].sort((a, b) => rank(a) - rank(b))[0]!;
    const props = (best.properties ?? {}) as Record<string, unknown>;
    if (best.layer.id === LAYER.clusters) {
      const geometry = best.geometry as GeoJSON.Point;
      const [lon, lat] = geometry.coordinates as [number, number];
      this.map.easeTo({ center: [lon, lat], zoom: Math.min(this.map.getZoom() + 2, 18) });
      return;
    }
    const id = typeof props.id === 'string' ? props.id : null;
    if (!id) return;
    const geometry = best.geometry as GeoJSON.Geometry;
    const at =
      geometry.type === 'Point'
        ? { lon: geometry.coordinates[0] as number, lat: geometry.coordinates[1] as number }
        : undefined;
    this.opts.callbacks.onSelectProject?.(id, props, at);
  }

  // --- camera and markers --------------------------------------------------------------------

  flyTo(p: LonLat, zoom: number = PROJECT_ZOOM): void {
    this.startFlight({ lon: p.lon, lat: p.lat }, zoom);
  }

  /** Flies so that `center` ends in the middle of the visible part of the map. */
  private startFlight(center: LonLat, zoom: number): void {
    this.insetsPending = false;
    this.map.flyTo({
      center: [center.lon, center.lat],
      zoom,
      padding: this.insets,
      essential: true,
    });
    this.flight = { center, zoom };
  }

  /**
   * The panels over the map changed (the project card opened, closed or grew; the heat bar
   * wrapped). The camera keeps clear of them: a flight on its way is re-aimed, a map the user
   * is dragging gets them when it stops, otherwise they apply at once without moving what is
   * on screen — and a selected project hidden by the new panel is brought into view.
   */
  setInsets(next: Insets): void {
    if (this.destroyed || sameInsets(next, this.insets, 0)) return;
    this.insets = { ...next };
    if (this.flight) this.startFlight(this.flight.center, this.flight.zoom);
    else if (this.map.isMoving()) this.insetsPending = true;
    else this.applyInsets();
  }

  getInsets(): Insets {
    return { ...this.insets };
  }

  private applyInsets(): void {
    this.insetsPending = false;
    const { clientWidth: w, clientHeight: h } = this.map.getContainer();
    if (w <= 0 || h <= 0) return;
    const at = visibleCentre(w, h, this.insets);
    this.map.jumpTo({ center: this.map.unproject([at.x, at.y]), padding: this.insets });
    const s = this.selection;
    if (s && !inVisiblePart(this.map.project([s.lon, s.lat]), w, h, this.insets)) {
      this.map.easeTo({ center: [s.lon, s.lat], duration: 400, essential: true });
    }
  }

  fitBounds(bounds: BBox, maxZoom = 12): void {
    const [w, s, e, n] = bounds;
    if (w === e && s === n) {
      this.flyTo({ lon: w, lat: s }, Math.min(maxZoom, PROJECT_ZOOM));
      return;
    }
    this.map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      { padding: 48, maxZoom, duration: 600 },
    );
  }

  setSelection(p: LonLat | null): void {
    this.selection = p ? { lon: p.lon, lat: p.lat } : null;
    this.setData(SOURCE.selection, p ? point(p) : EMPTY);
  }

  setPickPoint(p: LonLat | null): void {
    this.setData(SOURCE.pick, p ? point(p) : EMPTY);
  }

  locate(): Promise<LocateResult> {
    return this.locator.locate();
  }

  resize(): void {
    this.map.resize();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.localTimer) clearTimeout(this.localTimer);
    this.localSub?.unsubscribe();
    this.map.remove();
  }
}

/** Probe without creating a map (2 GB phones with WebGL disabled still get the list). */
export function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

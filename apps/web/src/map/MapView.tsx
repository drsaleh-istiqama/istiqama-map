/**
 * <MapView filter onSelectProject /> (docs/contracts/web.md §3.8) — the MapLibre map with the
 * self-hosted Protomaps basemap, the project layers, the legend, heat maps of needs and
 * "my location". Also used by pick mode (`mode="pick"`).
 *
 * Default export of a lazy chunk: MapLibre and the basemap style never reach the shell.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { accessToken, deviceId, me, session } from '../auth';
import type { ProjectFilter } from '../db';
import { env } from '../env';
import { INTL_LOCALE, locale, t } from '../i18n';
import type { LonLat } from '../lib/geo';
import { getPref, setPref } from '../lib/prefs';
import { Link, Spinner, toast } from '../ui';
import { basemapReady, basemapRevision, basemapView } from './basemapRuntime';
import { DEFAULT_VIEW, functionsUrl } from './config';
import { registerMap, takePendingCamera, type CameraRequest } from './controller';
import { IconLayers, IconLocate } from './icons';
import { clampInsets, coveredInsets } from './insets';
import { HEAT_KINDS, isHeatKind, LEGEND, type HeatKind } from './layers';
import { MapEngine, webglAvailable, type EngineOptions } from './mapEngine';
import './map.css';

export interface MapViewProps {
  filter: ProjectFilter;
  /** A project was tapped; `point` is where it is drawn on the map (when known). */
  onSelectProject?: (id: string, properties: Record<string, unknown>, point?: LonLat) => void;
  /** `pick`: taps report a point instead of opening projects (no heat maps). */
  mode?: 'browse' | 'pick';
  onPick?: (p: LonLat) => void;
  /** Pick mode: the chosen point (marker). */
  pickPoint?: LonLat | null;
  /** Ring around the selected project. */
  selected?: LonLat | null;
  /**
   * A panel drawn over the map (the selected project's card). The camera keeps the selection
   * and every fly / fit in the part of the map it does not hide, and the bottom controls (legend,
   * "my location", attribution) move above it when it covers the bottom of the map.
   */
  cover?: HTMLElement | null;
  /** Camera on start (otherwise: a waiting camera request, the last camera, the default). */
  initialView?: { center: LonLat; zoom: number };
  /** Registers as the map moved by flyToProject / fitToFilter (default: browse mode). */
  register?: boolean;
  /** Remember the camera between visits (default: browse mode). */
  rememberCamera?: boolean;
  /** Filled with a small imperative API once the map is ready (pick mode: "use the centre"). */
  apiRef?: { current: MapViewApi | null };
  testId?: string;
}

export interface MapViewApi {
  center(): LonLat;
  flyTo(p: LonLat, zoom?: number): void;
}

const CAMERA_PREF = 'map.camera';
const HEAT_PREF = 'map.heat';

interface SavedCamera {
  lon: number;
  lat: number;
  zoom: number;
}

function savedCamera(): SavedCamera | null {
  const c = getPref<SavedCamera | null>(CAMERA_PREF, null);
  return c &&
    Number.isFinite(c.lon) &&
    Number.isFinite(c.lat) &&
    Number.isFinite(c.zoom) &&
    Math.abs(c.lat) <= 85
    ? c
    : null;
}

function initialFor(props: MapViewProps, pending: CameraRequest | null): EngineOptions['initial'] {
  if (props.initialView) return props.initialView;
  if (pending?.kind === 'fly') return { center: pending.point, zoom: pending.zoom ?? 16 };
  if (pending?.kind === 'fit') return { bounds: pending.bounds };
  // Reading the last camera is harmless even for maps that do not save theirs (pick mode).
  const saved = savedCamera();
  if (saved) return { center: { lon: saved.lon, lat: saved.lat }, zoom: saved.zoom };
  return {
    center: { lon: DEFAULT_VIEW.center[0], lat: DEFAULT_VIEW.center[1] },
    zoom: DEFAULT_VIEW.zoom,
  };
}

function controlLabels(): Record<string, string> {
  return {
    'NavigationControl.ZoomIn': t('map.zoomIn'),
    'NavigationControl.ZoomOut': t('map.zoomOut'),
    'NavigationControl.ResetBearing': t('map.resetNorth'),
    'AttributionControl.ToggleAttribution': t('map.attribution'),
    'Map.Title': t('map.canvasLabel'),
  };
}

function tilesDeps(): EngineOptions['tiles'] {
  if (!session.value || !env.supabaseUrl) return null;
  return {
    functionsBase: functionsUrl(),
    anonKey: env.supabaseAnonKey,
    deviceId,
    token: accessToken,
    scopeEpoch: me.value?.scope_epoch ?? null,
  };
}

const LOCATE_ERRORS: Record<string, string> = {
  unsupported: 'map.locateUnsupported',
  denied: 'map.locateDenied',
  unavailable: 'map.locateUnavailable',
  timeout: 'map.locateTimeout',
};

export default function MapView(props: MapViewProps) {
  const mode = props.mode ?? 'browse';
  const register = props.register ?? mode === 'browse';
  const remember = props.rememberCamera ?? mode === 'browse';
  const root = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const engine = useRef<MapEngine | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'fatal'>('loading');
  const [heat, setHeat] = useState<HeatKind | null>(() => {
    const saved = getPref<unknown>(HEAT_PREF, null);
    return isHeatKind(saved) ? saved : null;
  });
  const [locating, setLocating] = useState(false);
  // Open on wide screens; on a phone the legend would cover a third of the map.
  const [legendOpen, setLegendOpen] = useState(
    () => typeof window === 'undefined' || window.innerWidth >= 600,
  );
  const latest = useRef(props);
  latest.current = props;

  const lang = locale.value;
  const scopeEpoch = me.value?.scope_epoch ?? null;
  const signedIn = Boolean(session.value);
  const revision = basemapRevision.value;
  const [basemapState, basemapRemote] = basemapView.value.split('|') as [string, string];
  const filterKey = JSON.stringify(props.filter);

  // --- create / destroy ------------------------------------------------------------------------
  useEffect(() => {
    if (!container.current) return;
    if (!webglAvailable()) {
      setState('fatal');
      return;
    }
    let alive = true;
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const pending = register ? takePendingCamera() : null;
    void basemapReady().then(() => {
      if (!alive || !container.current) return;
      try {
        const created = new MapEngine({
          container: container.current,
          mode,
          lang: locale.peek(),
          numberLocale: INTL_LOCALE[locale.peek()],
          filter: latest.current.filter,
          heat: mode === 'pick' ? null : heat,
          tiles: tilesDeps(),
          basemapRevision: basemapRevision.peek(),
          initial: initialFor(latest.current, pending),
          controlLabels: controlLabels(),
          callbacks: {
            onSelectProject: (id, properties, point) =>
              latest.current.onSelectProject?.(id, properties, point),
            onPick: (p) => latest.current.onPick?.(p),
            onMoveEnd: (view) => {
              if (!remember) return;
              if (saveTimer) clearTimeout(saveTimer);
              saveTimer = setTimeout(
                () =>
                  setPref<SavedCamera>(CAMERA_PREF, {
                    lon: Math.round(view.center.lon * 1e5) / 1e5,
                    lat: Math.round(view.center.lat * 1e5) / 1e5,
                    zoom: Math.round(view.zoom * 100) / 100,
                  }),
                500,
              );
            },
            onReady: () => {
              if (!alive) return;
              setState('ready');
              const p = latest.current;
              created.setSelection(p.selected ?? null);
              created.setPickPoint(p.pickPoint ?? null);
              if (p.apiRef) {
                p.apiRef.current = {
                  center: () => {
                    const c = created.map.getCenter();
                    return { lon: c.lng, lat: c.lat };
                  },
                  flyTo: (point, zoom) => created.flyTo(point, zoom),
                };
              }
              // Registered (and a waiting fly / fit applied) by the effect below, once the
              // panels over the map are on screen and measured.
            },
            onFatal: () => alive && setState('fatal'),
          },
        });
        engine.current = created;
      } catch {
        setState('fatal');
      }
    });
    const observer =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => engine.current?.resize())
        : null;
    observer?.observe(container.current);
    return () => {
      alive = false;
      observer?.disconnect();
      if (saveTimer) clearTimeout(saveTimer);
      if (latest.current.apiRef) latest.current.apiRef.current = null;
      engine.current?.destroy();
      engine.current = null;
    };
    // The map is created once; later changes go through engine.update().
  }, []);

  // --- panels over the map → camera padding (browse mode; pick mode keeps its crosshair centred) ---
  useEffect(() => {
    const created = engine.current;
    if (mode !== 'browse' || state !== 'ready' || !created || !container.current) return;
    const cover = props.cover ?? null;
    const measure = (): void => {
      const area = container.current?.getBoundingClientRect();
      if (!area || !engine.current) return;
      const panels = [top.current, cover?.isConnected ? cover : null].map(
        (el) => el?.getBoundingClientRect() ?? null,
      );
      const covered = coveredInsets(area, panels);
      // Legend and "my location" float above a card that covers the bottom of the map (map.css).
      const el = root.current;
      if (el) {
        el.style.setProperty('--map-cover-bottom', `${covered.bottom}px`);
        if (covered.bottom > 0) el.dataset.cover = 'bottom';
        else delete el.dataset.cover;
      }
      engine.current.setInsets(clampInsets(covered, area.width, area.height));
    };
    measure();
    const observer =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => measure()) : null;
    for (const el of [container.current, top.current, cover]) if (el) observer?.observe(el);
    return () => observer?.disconnect();
  }, [state, props.cover]);

  // After the padding: the controller may now move this map (flyToProject / fitToFilter).
  useEffect(() => {
    const created = engine.current;
    if (!register || state !== 'ready' || !created) return;
    return registerMap({
      flyTo: (point, zoom) => created.flyTo(point, zoom),
      fitBounds: (bounds, maxZoom) => created.fitBounds(bounds, maxZoom),
    });
  }, [state]);

  // --- view state → engine -----------------------------------------------------------------------
  useEffect(() => {
    engine.current?.update({ lang, numberLocale: INTL_LOCALE[lang] });
  }, [lang]);
  useEffect(() => {
    engine.current?.update({ tiles: tilesDeps() });
  }, [scopeEpoch, signedIn]);
  useEffect(() => {
    engine.current?.update({ basemapRevision: revision });
  }, [revision]);
  useEffect(() => {
    engine.current?.update({ filter: props.filter });
  }, [filterKey]);
  useEffect(() => {
    if (mode !== 'pick') engine.current?.update({ heat });
  }, [heat]);
  useEffect(() => {
    engine.current?.setSelection(props.selected ?? null);
  }, [props.selected?.lon, props.selected?.lat, state]);
  useEffect(() => {
    engine.current?.setPickPoint(props.pickPoint ?? null);
  }, [props.pickPoint?.lon, props.pickPoint?.lat, state]);

  const toggleHeat = (kind: HeatKind): void => {
    const next = heat === kind ? null : kind;
    setHeat(next);
    setPref(HEAT_PREF, next);
  };

  const locate = async (): Promise<void> => {
    if (!engine.current || locating) return;
    setLocating(true);
    try {
      const result = await engine.current.locate();
      if (!result.ok) toast(t(LOCATE_ERRORS[result.error] ?? 'map.locateUnavailable'), 'error');
      else if (result.accuracyM > 30)
        toast(t('map.locateInaccurate', { meters: Math.round(result.accuracyM) }), 'info');
    } finally {
      setLocating(false);
    }
  };

  const notice =
    state === 'ready' && basemapState === 'unavailable'
      ? basemapRemote === 'offline'
        ? 'map.basemapOffline'
        : 'map.basemapUnavailable'
      : null;

  return (
    <div
      ref={root}
      class={`mapview mapview--${mode}`}
      data-testid={props.testId ?? 'map-view'}
      data-state={state}
      data-basemap={basemapState}
    >
      <div
        ref={container}
        class="mapview__canvas"
        dir="ltr"
        role="region"
        aria-label={t('map.canvasLabel')}
      />

      {state === 'loading' && (
        <div class="mapview__cover">
          <Spinner size={32} label={t('map.loading')} />
        </div>
      )}
      {state === 'fatal' && (
        <div class="mapview__cover mapview__cover--fatal" role="status" data-testid="map-fatal">
          <p>{t('map.noWebgl')}</p>
        </div>
      )}

      <div class="mapview__top" ref={top}>
        {notice && (
          <div class="mapview__notice" role="status" data-testid="map-basemap-notice">
            <span>{t(notice)}</span>
            {mode === 'browse' && (
              <Link href="/settings" class="mapview__notice-link" testId="map-packs-link">
                {t('map.openPacks')}
              </Link>
            )}
          </div>
        )}
        {mode === 'browse' && state === 'ready' && (
          <div class="mapview__heat" role="group" aria-label={t('map.heatTitle')}>
            <span class="mapview__heat-title" title={t('map.heatTitle')} aria-hidden="true">
              <IconLayers size={18} />
            </span>
            {HEAT_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                class={`mapview__chip${heat === kind ? ' mapview__chip--on' : ''}`}
                aria-pressed={heat === kind ? 'true' : 'false'}
                data-testid={`map-heat-${kind}`}
                onClick={() => toggleHeat(kind)}
              >
                {t(`map.heat_${kind}`)}
              </button>
            ))}
          </div>
        )}
      </div>

      {mode === 'browse' && state === 'ready' && (
        <div class="mapview__legend" data-testid="map-legend">
          <button
            type="button"
            class="mapview__legend-toggle"
            aria-expanded={legendOpen ? 'true' : 'false'}
            data-testid="map-legend-toggle"
            onClick={() => setLegendOpen((v) => !v)}
          >
            {t('map.legend')}
          </button>
          {legendOpen && (
            <ul class="mapview__legend-items">
              {LEGEND.map((item) => (
                <li key={item.key}>
                  <span class="mapview__swatch" style={{ backgroundColor: item.color }} />
                  {t(item.labelKey)}
                </li>
              ))}
              <li>
                <span class="mapview__swatch mapview__swatch--cluster" />
                {t('map.legendCluster')}
              </li>
              <li>
                <span class="mapview__swatch mapview__swatch--pending" />
                {t('map.legendPending')}
              </li>
              {heat && (
                <li class="mapview__legend-heat">
                  <span class="mapview__heat-ramp" />
                  {t(`map.heat_${heat}`)}
                </li>
              )}
            </ul>
          )}
        </div>
      )}

      {state === 'ready' && (
        <button
          type="button"
          class="mapview__locate"
          data-testid="map-locate"
          aria-label={t('map.locate')}
          title={t('map.locate')}
          aria-busy={locating ? 'true' : undefined}
          onClick={() => void locate()}
        >
          {locating ? <Spinner size={20} /> : <IconLocate size={22} />}
        </button>
      )}
    </div>
  );
}

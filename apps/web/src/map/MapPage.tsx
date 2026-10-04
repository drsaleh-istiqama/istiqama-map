/**
 * Map page (routes `/` and `/map`): the project register of the projects module (search,
 * filters, "visible of total") beside the map — on phones a Map / List switch — and the card
 * of the selected project. Filters are remembered for this view only (`viewKey="map"`,
 * brief §12).
 *
 * Fitting (v2 parity 1.5, v2 `fitFiltered`): the first map of an app session shows the user's
 * projects (the remembered filter's) — on a fresh device as soon as the first sync has brought
 * them; every filter change the user makes — clearing included — fits the map to the matching
 * projects. Later visits in the same session keep the camera the user left; a "show on map"
 * request waiting for the map, a project the user selects or a filter they change end the start
 * fit.
 *
 * MapLibre is loaded lazily inside the page: search and list work while the map chunk is
 * still downloading on a slow connection.
 */
import type { ComponentType } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ProjectFilter } from '../db';
import { t } from '../i18n';
import { ProjectList } from '../projects/ProjectList';
import { Button, EmptyState, IconList, IconMap, Spinner, useMediaQuery } from '../ui';
import { PROJECT_ZOOM } from './config';
import { hasPendingCamera, requestCamera } from './controller';
import { syncStatus } from '../sync';
import { fitToFilter, fitToFilterIfAny } from './index';
import type { MapViewProps } from './MapView';
import { projectSummary } from './queries';
import { SelectedProjectCard, type SelectedProject } from './SelectedProjectCard';
import './map.css';

let mapViewModule: Promise<{ default: ComponentType<MapViewProps> }> | null = null;
const loadMapView = (): Promise<{ default: ComponentType<MapViewProps> }> =>
  (mapViewModule ??= import('./MapView'));

/**
 * The start fit of this app session: `waiting` until it found projects to show (a fresh device
 * has none before its first sync) or the user took the camera over.
 */
let startFit: 'waiting' | 'done' = 'waiting';

/** Test helper: a new app session. */
export function resetStartFit(): void {
  startFit = 'waiting';
}

/** The user chose what to look at (a project, a filter): no start fit any more this session. */
export function endStartFit(): void {
  startFit = 'done';
}

export function startFitWaiting(): boolean {
  return startFit === 'waiting';
}

/**
 * What the map does when the list reports its filter. `first` = the filter restored from the
 * last visit (the list's first report on this page). `fit`: fit to it (a change the user made);
 * `start`: try the start fit (it ends once projects were found); `keep`: leave the camera.
 */
export function fitDecision(first: boolean): 'fit' | 'start' | 'keep' {
  if (!first) {
    endStartFit();
    return 'fit';
  }
  if (startFit === 'done') return 'keep';
  if (hasPendingCamera()) {
    endStartFit();
    return 'keep';
  }
  return 'start';
}

/** Tries the start fit; it ends when projects were found (otherwise the next sync retries). */
function tryStartFit(filter: ProjectFilter): void {
  void fitToFilterIfAny(filter).then((applied) => {
    if (applied) endStartFit();
  });
}

export default function MapPage() {
  const [MapView, setMapView] = useState<ComponentType<MapViewProps> | null>(null);
  const [mapFailed, setMapFailed] = useState(false);
  const [filter, setFilter] = useState<ProjectFilter>({});
  const [selected, setSelected] = useState<SelectedProject | null>(null);
  const [selectedPoint, setSelectedPoint] = useState<{ lon: number; lat: number } | null>(null);
  const [card, setCard] = useState<HTMLElement | null>(null);
  const [tab, setTab] = useState<'map' | 'list'>('map');
  const wide = useMediaQuery('(min-width: 900px)');
  const restored = useRef(true);
  const currentFilter = useRef<ProjectFilter>({});

  useEffect(() => {
    let alive = true;
    loadMapView()
      .then((module) => alive && setMapView(() => module.default))
      .catch(() => alive && setMapFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  // A fresh device opens the map before its first sync: the start fit waits for the projects.
  const lastSyncAt = syncStatus.value.lastSyncAt;
  const syncAtMount = useRef(lastSyncAt);
  useEffect(() => {
    if (lastSyncAt === syncAtMount.current) return;
    syncAtMount.current = lastSyncAt;
    if (startFitWaiting() && !restored.current) {
      if (hasPendingCamera()) endStartFit();
      else tryStartFit(currentFilter.current);
    }
  }, [lastSyncAt]);

  const onFilterChange = (next: ProjectFilter): void => {
    setFilter(next);
    currentFilter.current = next;
    const first = restored.current;
    restored.current = false;
    const decision = fitDecision(first);
    if (decision === 'fit') void fitToFilter(next);
    else if (decision === 'start') tryStartFit(next);
  };

  const selectById = (id: string): void => {
    endStartFit();
    setSelected({ id });
    void projectSummary(id).then((summary) => {
      if (summary && summary.lon !== null && summary.lat !== null) {
        const point = { lon: summary.lon, lat: summary.lat };
        setSelectedPoint(point);
        requestCamera({ kind: 'fly', point, zoom: PROJECT_ZOOM });
      } else setSelectedPoint(null);
    });
    if (!wide) setTab('map');
  };

  const listOnlyBar = !wide && tab === 'map';
  const showMap = wide || tab === 'map';

  return (
    <div class={`mappage${wide ? ' mappage--wide' : ''}`} data-testid="map-page">
      <h1 class="sr-only">{t('map.title')}</h1>
      {!wide && (
        <div class="mappage__tabs" role="group" aria-label={t('map.viewLabel')}>
          <Button
            size="sm"
            variant={tab === 'map' ? 'primary' : 'secondary'}
            icon={<IconMap size={18} />}
            aria-pressed={tab === 'map' ? 'true' : 'false'}
            testId="map-show-map"
            onClick={() => setTab('map')}
          >
            {t('map.tabMap')}
          </Button>
          <Button
            size="sm"
            variant={tab === 'list' ? 'primary' : 'secondary'}
            icon={<IconList size={18} />}
            aria-pressed={tab === 'list' ? 'true' : 'false'}
            testId="map-show-list"
            onClick={() => setTab('list')}
          >
            {t('map.tabList')}
          </Button>
        </div>
      )}
      <div class={`mappage__body${!wide && tab === 'list' ? ' mappage__body--list' : ''}`}>
        {/* On the phone's map tab only the search bar, filters and counter of the list show. */}
        <div class={`mappage__list${listOnlyBar ? ' mappage__list--bar' : ''}`}>
          <ProjectList viewKey="map" onSelect={selectById} onFilterChange={onFilterChange} />
        </div>
        {/* The map stays mounted while the list tab is shown: no re-initialisation on phones. */}
        <div class={`mappage__map${showMap ? '' : ' mappage__map--hidden'}`}>
          {MapView ? (
            <MapView
              filter={filter}
              selected={selectedPoint}
              cover={card}
              onSelectProject={(id, properties, point) => {
                endStartFit();
                setSelected({ id, properties });
                setSelectedPoint(point ?? null);
              }}
            />
          ) : mapFailed ? (
            <EmptyState title={t('map.loadFailedTitle')} message={t('map.loadFailedBody')} />
          ) : (
            <div class="mapview__cover">
              <Spinner size={32} label={t('map.loading')} />
            </div>
          )}
          {selected && (
            <SelectedProjectCard
              selected={selected}
              elementRef={setCard}
              onClose={() => {
                setSelected(null);
                setSelectedPoint(null);
              }}
              onLoaded={(summary) => {
                if (summary.lon !== null && summary.lat !== null)
                  setSelectedPoint({ lon: summary.lon, lat: summary.lat });
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Public API of the map module (docs/contracts/web.md §3.8, §5). Safe to import from any
 * module: nothing here pulls MapLibre, PMTiles or the basemap style — those load lazily.
 *
 *   const point = await pickLocation(current);          // project form
 *   flyToProject({ lon, lat });                          // "show on map"
 *   await fitToFilter(filter);                           // fit the map to a list filter
 *
 * <MapView filter onSelectProject /> is the default export of ./MapView (lazy chunk) and
 * <PacksSection /> the default export of ./PacksSection (offline packs, for Settings).
 */
import type { ProjectFilter } from '../db';
import type { LonLat } from '../lib/geo';
import { currentRoute, navigate } from '../routes';
import { hasActiveMap, requestCamera } from './controller';
import type { PickResult } from './pick';
import { PROJECT_ZOOM } from './config';

export type { PickResult } from './pick';
export type { MapViewProps } from './MapView';

/**
 * Opens pick mode (tap → "confirm and return" / "return without change"). Resolves with the
 * chosen point (`source: 'map'`) or null when the user returned without change.
 */
export async function pickLocation(initial: LonLat | null): Promise<PickResult | null> {
  const { openPicker } = await import('./PickerDialog');
  return openPicker(initial);
}

const onMapRoute = (): boolean => {
  const path = currentRoute.peek().path;
  return path === '/' || path === '/map';
};

/**
 * Centres the map on a project. From another page (details, lists) it opens the map page,
 * which applies the request as soon as its map is ready.
 */
export function flyToProject(p: LonLat): void {
  requestCamera({ kind: 'fly', point: { lon: p.lon, lat: p.lat }, zoom: PROJECT_ZOOM });
  if (!hasActiveMap() && !onMapRoute()) navigate('/map');
}

/**
 * Fits the map to the projects matching a filter (v2 parity 1.5), from the local database.
 * Resolves once the request was applied or queued; does nothing when no project matches.
 */
export async function fitToFilter(filter: ProjectFilter): Promise<void> {
  await fitToFilterIfAny(filter);
}

/** fitToFilter that tells whether a project matched (false: the camera was left alone). */
export async function fitToFilterIfAny(filter: ProjectFilter): Promise<boolean> {
  const { boundsOfFilter } = await import('./queries');
  const bounds = await boundsOfFilter(filter);
  if (!bounds) return false;
  requestCamera({ kind: 'fit', bounds, maxZoom: 12 });
  return true;
}

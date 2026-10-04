/** In-app links into the reports module (tiny: safe to import from the shell or other features). */
import { setPref } from '../lib/prefs';
import { navigate } from '../routes';

export type PrintKind = 'project' | 'donor' | 'country';

/** Path of a print view, e.g. `printPath('project', id)` for the project details page. */
export function printPath(kind: PrintKind, id: string): string {
  return `/reports/print/${kind}/${encodeURIComponent(id)}`;
}

/** Heat maps of the map view (src/map/layers.ts HEAT_KINDS). */
export type HeatKind = 'maintenance' | 'quran_need' | 'housing';
/** The preference the map view reads when it opens (src/map/MapView.tsx). */
export const MAP_HEAT_PREF = 'map.heat';

/** Opens the map with the heat map of `kind` switched on. */
export function openHeatMap(kind: HeatKind): void {
  setPref(MAP_HEAT_PREF, kind);
  navigate('/map');
}

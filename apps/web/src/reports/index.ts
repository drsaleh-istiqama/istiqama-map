/**
 * Public pieces of the reports module (docs/contracts/web.md §2: dashboard, heat-map links,
 * print / PDF views, export). The pages themselves are lazy route chunks
 * (`reports/ReportsPage`, `reports/PrintPage`). Everything exported here is small enough for
 * the shell:
 *
 *   <NotificationsBell />                       top bar, next to <SyncBadge />
 *   printPath('project', id)                    link for the project details page
 *   openHeatMap('maintenance')                  map with a heat map switched on
 */
export { NotificationsBell } from './NotificationsBell';
export { printPath, openHeatMap, MAP_HEAT_PREF, type HeatKind, type PrintKind } from './paths';
export { clearDashboardCache } from './cache';

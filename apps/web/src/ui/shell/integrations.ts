/**
 * Components of other feature modules that the shell mounts — ONE place, so that the initial
 * bundle stays free of them (every loader below is a lazy chunk, also precached for offline
 * use) and so that wiring them is a single, reviewable list:
 *
 *   NotificationsBell   src/reports/NotificationsBell.tsx      top bar, next to <SyncBadge />
 *   V2MigrationPrompt   src/migration/V2MigrationPrompt.tsx    shell, first run with v2 data
 *
 * (`V2ImportSection` of src/migration is imported statically by src/settings/SettingsPage.tsx,
 * which is itself a lazy route chunk.)
 *
 * Mounted through `<LazySlot>`: until a chunk is loaded — or when it cannot be loaded or throws
 * while rendering — the slot shows its fallback and the rest of the app keeps working.
 */
import { LEGACY_V2_KEYS, hasLegacyV2 } from '../../lib/prefs';
import type { ComponentLoader } from './LazySlot';

/** Notifications menu (brief §9.3: export ready → notification with a download link). */
export const loadNotificationsBell: ComponentLoader = () =>
  import('../../reports/NotificationsBell').then((m) => m.NotificationsBell);

/** v2 → v3 migration offer (brief §10). Mount it only when `v2MigrationWanted()` says so. */
export const loadV2MigrationPrompt: ComponentLoader = () =>
  import('../../migration/V2MigrationPrompt').then((m) => m.default);

/**
 * Brief §10: the migration is offered "on the first start of v3 on a device that has
 * `istiqama-projects-v2` or `istiqama-people-v1` in localStorage" — and v2's keys are removed
 * only after a successful upload, so an interrupted run is offered again on the next start.
 * Checked by key name, without reading the (possibly multi-megabyte) values; on every other
 * device the migration chunk is never loaded.
 */
/** Pages that offer importing a v2 export file (settings, import). */
export const V2_IMPORT_ROUTES = /^\/(import|settings)(\/|$)/;

export function v2MigrationWanted(): boolean {
  return LEGACY_V2_KEYS.some((key) => hasLegacyV2(key));
}

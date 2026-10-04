/**
 * v2 → v3 migration (brief §10, acceptance criterion 6).
 *
 * Integration points for other modules (they mount, this module owns the behaviour):
 *  - shell (src/ui/shell): the first-run offer, on every screen, lazily —
 *      <LazySlot load={() => import('../../migration/V2MigrationPrompt').then((m) => m.default)} />
 *    (`hasLegacyV2()` of src/lib/prefs may decide whether to mount it at all; the component
 *    also completes pending runs after each sync, so mount it whenever the keys exist);
 *  - settings (src/settings/SettingsPage.tsx): replace the placeholder section with
 *      <V2ImportSection />   (default export of './V2ImportSection'; same section test id).
 *
 * The rest of the API (pure mapping, runner) is exported for tests and tools.
 */
export { V2ImportSection } from './V2ImportSection';
export { V2MigrationPanel } from './V2MigrationPanel';
export { deviceHasV2Keys, deviceV2Summary, v2Changed } from './local';
export { mapV2, type MapContext, type MigrationPlan, type MigrationWarning } from './v2map';
export { parseV2Json, readV2Local, hasV2LocalData } from './v2read';
export {
  V2_PEOPLE_KEY,
  V2_PROJECTS_KEY,
  type V2Data,
  type V2Project,
  type V2Person,
} from './v2types';

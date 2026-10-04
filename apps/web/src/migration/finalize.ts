/**
 * Background completion of migration runs whose upload was not confirmed when the dialog
 * closed (offline, slow network, app restarted): after a sync, every unfinished run of the
 * signed-in user is checked against the queue (read-only) and — once all its operations are
 * acknowledged — its v2 keys are removed (runner.finalizeMigration). Light on purpose: no
 * photo pipeline, no geofill; the shell's prompt loads it after a sync.
 */
import { me, session } from '../auth';
import { readLegacyV2, removeLegacyV2, type LegacyV2Key } from '../lib/prefs';
import { syncNow } from '../sync';
import { notifyV2Changed } from './local';
import { fileMergeSuggestion } from './merge';
import { finalizeMigration, type RunnerDeps } from './runner';
import { unfinishedRuns } from './state';

type FinalizeDeps = Pick<
  RunnerDeps,
  'online' | 'syncNow' | 'readLegacy' | 'removeLegacy' | 'requestMerge'
> & {
  userId(): string | null;
};

export const finalizeDeps: FinalizeDeps = {
  online: () => typeof navigator === 'undefined' || navigator.onLine !== false,
  syncNow,
  readLegacy: (key) => readLegacyV2(key as LegacyV2Key),
  removeLegacy: (key) => removeLegacyV2(key as LegacyV2Key),
  userId: () => me.peek()?.user_id ?? session.peek()?.user.id ?? null,
  requestMerge: fileMergeSuggestion,
};

let running: Promise<number> | null = null;

/**
 * Finalizes what can be finalized; resolves to the number of runs that are now complete
 * (keys removed / upload confirmed). Never syncs by itself and never throws.
 */
export function finalizePendingRuns(deps: FinalizeDeps = finalizeDeps): Promise<number> {
  running ??= (async () => {
    let completed = 0;
    try {
      const runs = await unfinishedRuns(deps.userId());
      for (const state of runs) {
        // A run interrupted before everything was stored is resumed from the dialog only.
        if (state.savedAt === null) continue;
        const fin = await finalizeMigration(state, deps, { sync: false });
        if (fin.push.done) completed++;
      }
    } catch {
      /* the next sync tries again */
    }
    if (completed > 0) notifyV2Changed();
    return completed;
  })().finally(() => {
    running = null;
  });
  return running;
}

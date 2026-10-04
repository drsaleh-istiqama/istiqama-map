/**
 * Nothing of a user may stay readable for the next person on a shared device: once the app
 * reaches the signed-out state — through "sign out" in Settings, a revoked session, a
 * "forgot PIN" or an expired refresh token — the saved per-view filters (a search text can be
 * a person's name) and the per-user runtime caches (photo thumbnails, project tiles) go.
 * Records and unsent work are the sync module's business (`resetLocalData`), not this one's.
 */
import { effect, type ReadonlySignal } from '@preact/signals';
import { clearViewFilters } from '../../routes';
import { purgeUserCaches } from '../pwa/register';

/** Forget the UI traces of the previous user (idempotent). */
export async function clearUserTraces(): Promise<void> {
  clearViewFilters();
  await purgeUserCaches();
}

/**
 * Calls `onSignedOut` each time `state` enters `'signed_out'` (also right at start-up when the
 * device has no session). Returns the unsubscribe function.
 */
export function watchSignedOut(
  state: ReadonlySignal<string>,
  onSignedOut: () => void | Promise<void>,
): () => void {
  let previous: string | null = null;
  return effect(() => {
    const current = state.value;
    if (current === 'signed_out' && previous !== 'signed_out') {
      Promise.resolve()
        .then(onSignedOut)
        .catch(() => undefined);
    }
    previous = current;
  });
}

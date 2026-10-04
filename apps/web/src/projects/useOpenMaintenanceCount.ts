import { useEffect, useState } from 'preact/hooks';
import { useRoute } from '../routes';
import { syncStatus } from '../sync';
import { countOpenMaintenance } from './queries';

/**
 * Open / in-progress maintenance entries on the device — the badge of the maintenance nav
 * item (v2 parity 6.4). Recounted on navigation, after a local edit (pending ops change) and
 * after each sync; a native index count, no rows are read. Deliberately not a live query, so a
 * large first pull does not trigger hundreds of recounts on a low-end phone.
 */
export function useOpenMaintenanceCount(): number {
  const [count, setCount] = useState(0);
  const { path } = useRoute();
  const { lastSyncAt, pendingOps } = syncStatus.value;
  useEffect(() => {
    let alive = true;
    countOpenMaintenance()
      .then((n) => {
        if (alive) setCount(n);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [path, lastSyncAt, pendingOps]);
  return count;
}

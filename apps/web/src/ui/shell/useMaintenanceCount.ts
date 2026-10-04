import { useEffect, useState } from 'preact/hooks';
import { listProjects } from '../../db';
import { syncStatus } from '../../sync';

/**
 * Number of projects with open maintenance in the local database (v2 parity: the count
 * badge on the maintenance entry). Recounted on navigation, after a local edit and after
 * each sync — deliberately not a live query, so a large first pull does not trigger
 * hundreds of recounts on a low-end phone.
 */
export function useMaintenanceCount(routePath: string): number {
  const [count, setCount] = useState(0);
  const { lastSyncAt, pendingOps } = syncStatus.value;
  useEffect(() => {
    let alive = true;
    listProjects({ openMaintenance: true }, null, 1)
      .then((page) => {
        if (alive) setCount(page.total);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [routePath, lastSyncAt, pendingOps]);
  return count;
}

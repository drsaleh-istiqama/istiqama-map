import { useEffect, useState } from 'preact/hooks';
import { acquirePhotoUrl, releasePhotoUrl, type PhotoKind } from './urls';
import type { PhotoRow } from './queries';

export type PhotoUrlStatus =
  /** Resolving (local blob lookup, download, signing). */
  | 'loading'
  | 'ready'
  /** Not available offline (no local blob, not in the thumbnail cache). */
  | 'offline'
  /** The object does not exist (yet): upload pending on another device, purged, blob lost. */
  | 'missing';

export interface PhotoUrlState {
  url: string | null;
  status: PhotoUrlStatus;
  /** Resolve again (after an image load error, e.g. an expired signed URL). */
  retry: () => void;
}

const isOffline = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false;

/**
 * The display URL of a photo, held while the component is mounted and released (object URL
 * revoked when nobody else holds it) on unmount or when the photo changes. Re-resolves when
 * the device comes back online.
 */
export function usePhotoUrl(photo: PhotoRow | null | undefined, kind: PhotoKind): PhotoUrlState {
  const [state, setState] = useState<{ url: string | null; status: PhotoUrlStatus }>({
    url: null,
    status: photo ? 'loading' : 'missing',
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const onOnline = (): void => setAttempt((n) => n + 1);
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);

  const path = kind === 'full' ? photo?.storage_path_full : photo?.storage_path_thumb;
  useEffect(() => {
    if (!photo) {
      setState({ url: null, status: 'missing' });
      return;
    }
    let alive = true;
    let held: string | null = null;
    setState((s) =>
      s.status === 'loading' && s.url === null ? s : { url: null, status: 'loading' },
    );
    void acquirePhotoUrl(photo, kind).then(
      (url) => {
        if (!alive) {
          releasePhotoUrl(url);
          return;
        }
        held = url;
        setState({ url, status: url ? 'ready' : isOffline() ? 'offline' : 'missing' });
      },
      () => {
        if (alive) setState({ url: null, status: isOffline() ? 'offline' : 'missing' });
      },
    );
    return () => {
      alive = false;
      releasePhotoUrl(held);
    };
  }, [photo?.id, kind, path, photo?.upload_state, photo?.purged_at, attempt]);

  return { ...state, retry: () => setAttempt((n) => n + 1) };
}

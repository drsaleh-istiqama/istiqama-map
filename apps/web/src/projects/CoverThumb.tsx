import { useEffect, useState } from 'preact/hooks';
import type { Row } from '../db';
import { usePhotoUrl } from '../photos';
import { coverPhoto } from './queries';

/**
 * Wait before a mounted row resolves its thumbnail: rows that only fly past while the user
 * scrolls a long register never start a lookup or a download (2 GB phones, metered data).
 */
export const COVER_DELAY_MS = 150;

/**
 * The cover photo of a project as a small square thumbnail (brief §6: lists show thumbnails
 * only, never the full image). Local blob first, else the uploaded thumbnail (`photoUrl`).
 * Decorative: the row already names the project. Renders nothing when there is no cover.
 */
export function CoverThumb({ photoId, class: extra }: { photoId: string | null; class?: string }) {
  const [photo, setPhoto] = useState<Row<'project_photos'> | null>(null);

  useEffect(() => {
    setPhoto(null);
    if (!photoId) return;
    let alive = true;
    const timer = setTimeout(() => {
      coverPhoto(photoId).then(
        (row) => {
          if (alive) setPhoto(row ?? null);
        },
        () => undefined,
      );
    }, COVER_DELAY_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [photoId]);

  const { url } = usePhotoUrl(photo, 'thumb');
  if (!photoId) return null;
  return (
    <span
      class={extra ? `pthumb ${extra}` : 'pthumb'}
      data-testid="project-cover"
      data-state={url ? 'ready' : 'empty'}
      aria-hidden="true"
    >
      {url && <img src={url} alt="" loading="lazy" decoding="async" draggable={false} />}
    </span>
  );
}

/**
 * Photo gallery of the project details page (v2 parity 5.9): a grid of thumbnails with their
 * type and description; a tap opens the full image in a viewer — fetched on demand through a
 * short-lived signed URL (or the local blob of a photo not uploaded yet), with a loading
 * state and an offline message that keeps the thumbnail visible. Keyboard: arrow keys move
 * between thumbnails and, in the viewer, between photos (mirrored in right-to-left layouts);
 * Home / End jump to the first / last one; Esc closes the viewer.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { dir, fmt, t } from '../i18n';
import { Button, Modal, Spinner } from '../ui';
import { isLivePhoto, type PhotoRow } from './model';
import { PhotoThumb } from './PhotoThumb';
import { usePhotoUrl, type PhotoUrlStatus } from './usePhotoUrl';
import './photos.css';

export interface GalleryProps {
  photos: PhotoRow[];
  testId?: string;
}

/** Visible text of a photo: its type (unless unspecified) and its description. */
export function photoCaption(photo: PhotoRow): string {
  const parts: string[] = [];
  if (photo.category && photo.category !== 'unspecified')
    parts.push(t(`enum.photo_category.${photo.category}`));
  if (photo.caption) parts.push(photo.caption);
  return parts.join(' — ');
}

/** Index after a navigation key, or null when the key does not navigate. */
export function navigateIndex(
  key: string,
  index: number,
  count: number,
  rtl: boolean,
): number | null {
  if (count === 0) return null;
  const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
  const backward = rtl ? 'ArrowRight' : 'ArrowLeft';
  switch (key) {
    case forward:
      return Math.min(count - 1, index + 1);
    case backward:
      return Math.max(0, index - 1);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

export function Gallery({ photos, testId = 'photo-gallery' }: GalleryProps) {
  const live = photos.filter(isLivePhoto);
  const [open, setOpen] = useState<number | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const openIndex = open !== null && open < live.length ? open : null;

  if (live.length === 0) {
    return (
      <p class="photo-gallery__empty" data-testid={`${testId}-empty`}>
        {t('photos.galleryEmpty')}
      </p>
    );
  }

  const label = (index: number): string =>
    t('photos.photoLabel', { n: index + 1, total: live.length });

  const onGridKey = (event: KeyboardEvent): void => {
    const buttons = [
      ...(listRef.current?.querySelectorAll<HTMLButtonElement>('.photo-tile') ?? []),
    ];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0) return;
    const next = navigateIndex(event.key, current, buttons.length, dir() === 'rtl');
    if (next === null) return;
    event.preventDefault();
    buttons[next]?.focus();
  };

  return (
    <div class="photo-gallery" data-testid={testId}>
      <ul class="photo-grid" ref={listRef} onKeyDown={onGridKey}>
        {live.map((photo, index) => {
          const caption = photoCaption(photo);
          return (
            <li key={photo.id} class="photo-grid__item">
              <button
                type="button"
                class="photo-tile"
                data-testid="photo-gallery-item"
                data-photo-id={photo.id}
                aria-label={t('photos.open', {
                  label: caption ? `${label(index)}: ${caption}` : label(index),
                })}
                onClick={() => setOpen(index)}
              >
                <PhotoThumb photo={photo} alt="" />
                {photo.is_cover && (
                  <span class="badge badge--gold photo-tile__badge">{t('photos.cover')}</span>
                )}
              </button>
              {caption && <span class="photo-grid__caption">{caption}</span>}
            </li>
          );
        })}
      </ul>
      {openIndex !== null && (
        <PhotoViewer
          photos={live}
          index={openIndex}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
          label={label(openIndex)}
        />
      )}
    </div>
  );
}

interface PhotoViewerProps {
  photos: PhotoRow[];
  index: number;
  label: string;
  onIndex: (index: number) => void;
  onClose: () => void;
}

function PhotoViewer({ photos, index, label, onIndex, onClose }: PhotoViewerProps) {
  const photo = photos[index] as PhotoRow;
  const count = photos.length;

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      const next = navigateIndex(event.key, index, count, dir() === 'rtl');
      if (next === null || next === index) return;
      event.preventDefault();
      onIndex(next);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [index, count]);

  const caption = photoCaption(photo);
  return (
    <Modal
      open
      title={label}
      onClose={onClose}
      closeOnBackdrop
      size="lg"
      testId="photo-viewer"
      footer={
        count > 1 ? (
          <>
            <Button
              testId="photo-viewer-prev"
              disabled={index === 0}
              onClick={() => onIndex(index - 1)}
            >
              {t('photos.prev')}
            </Button>
            <Button
              testId="photo-viewer-next"
              disabled={index === count - 1}
              onClick={() => onIndex(index + 1)}
            >
              {t('photos.next')}
            </Button>
          </>
        ) : undefined
      }
    >
      <FullImage key={photo.id} photo={photo} alt={caption || label} />
      <div class="photo-viewer__meta">
        {caption && <p class="photo-viewer__caption">{caption}</p>}
        {photo.taken_at && (
          <p class="photo-viewer__date">
            {t('photos.takenAt', { date: fmt.dateTime(photo.taken_at) })}
          </p>
        )}
        {count > 1 && <p class="sr-only">{t('photos.keyboardHint')}</p>}
      </div>
    </Modal>
  );
}

/**
 * Notice under the viewer when the full image cannot be shown. It says the thumbnail is
 * shown only when one actually is on screen.
 */
export function fullImageNotice(
  photo: Pick<PhotoRow, 'upload_state'>,
  fullStatus: PhotoUrlStatus,
  failed: boolean,
  thumbShown: boolean,
): string | null {
  if (fullStatus === 'offline')
    return t(thumbShown ? 'photos.fullOffline' : 'photos.fullOfflineNoThumb');
  if (fullStatus === 'missing') {
    if (photo.upload_state !== 'uploaded')
      return t(thumbShown ? 'photos.fullMissing' : 'photos.fullMissingNoThumb');
    return t(thumbShown ? 'photos.fullUnavailable' : 'photos.fullUnavailableNoThumb');
  }
  return failed ? t('photos.fullError') : null;
}

function FullImage({ photo, alt }: { photo: PhotoRow; alt: string }) {
  const full = usePhotoUrl(photo, 'full');
  const thumb = usePhotoUrl(photo, 'thumb');
  // Load state per URL: a new (re-signed) URL starts unloaded without an effect racing it.
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const loaded = full.url !== null && loadedUrl === full.url;
  const failed = full.url !== null && failedUrl === full.url;

  const showThumb = !full.url || failed || !loaded;
  const notice = fullImageNotice(photo, full.status, failed, showThumb && thumb.url !== null);

  return (
    <figure
      class="photo-viewer"
      data-testid="photo-viewer-figure"
      data-state={failed ? 'error' : full.status}
      data-thumb={thumb.url ? 'shown' : thumb.status}
    >
      <div class="photo-viewer__stage">
        {showThumb && (
          <div class="photo-viewer__placeholder">
            <PhotoThumb photo={photo} alt={alt} state={thumb} />
          </div>
        )}
        {full.url && !failed && (
          <img
            class={
              loaded ? 'photo-viewer__image' : 'photo-viewer__image photo-viewer__image--loading'
            }
            src={full.url}
            alt={alt}
            data-testid="photo-viewer-image"
            onLoad={() => setLoadedUrl(full.url)}
            onError={() => setFailedUrl(full.url)}
          />
        )}
        {(full.status === 'loading' || (full.url && !loaded && !failed)) && (
          <div class="photo-viewer__spinner">
            <Spinner label={t('photos.loading')} />
          </div>
        )}
      </div>
      {notice && (
        <figcaption class="photo-viewer__notice" data-testid="photo-viewer-notice">
          <span role="status">{notice}</span>
          {failed && (
            <Button testId="photo-viewer-retry" onClick={() => full.retry()}>
              {t('photos.retry')}
            </Button>
          )}
        </figcaption>
      )}
    </figure>
  );
}

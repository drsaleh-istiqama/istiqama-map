import { t } from '../i18n';
import { Spinner } from '../ui';
import type { PhotoRow } from './model';
import { usePhotoUrl, type PhotoUrlStatus } from './usePhotoUrl';

export function IconImages({ size = 24 }: { size?: number }) {
  return (
    <svg
      class="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8.500" cy="10" r="1.500" />
      <path d="M21 16l-5-5-8 8" />
    </svg>
  );
}

export interface PhotoThumbProps {
  photo: PhotoRow;
  alt: string;
  /**
   * The thumbnail URL state when the caller already resolves it (the viewer needs it to word
   * its notice); the component then does not resolve it a second time.
   */
  state?: { url: string | null; status: PhotoUrlStatus };
}

/** A photo's thumbnail (never the full image) with loading / offline / missing states. */
export function PhotoThumb({ photo, alt, state }: PhotoThumbProps) {
  const own = usePhotoUrl(state ? null : photo, 'thumb');
  const { url, status } = state ?? own;
  return (
    <div class="photo-thumb" data-status={status} data-testid="photo-thumb">
      {url ? (
        <img src={url} alt={alt} decoding="async" loading="lazy" draggable={false} />
      ) : status === 'loading' ? (
        <Spinner size={20} label={t('photos.loading')} />
      ) : (
        <span class="photo-thumb__empty">
          <IconImages size={28} />
          <span>{t(status === 'offline' ? 'photos.offline' : 'photos.unavailable')}</span>
        </span>
      )}
    </div>
  );
}

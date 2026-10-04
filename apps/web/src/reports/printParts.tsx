/** Building blocks shared by the three printed reports. */
import type { ComponentChildren } from 'preact';
import { t } from '../i18n';
import { enumLabel } from '../projects/labels';
import { usePhotoUrl, type PhotoRow } from '../photos';
import type { ReportPhoto } from './types';

export function PSection({
  id,
  title,
  children,
  class: extra,
}: {
  id: string;
  title: string;
  children: ComponentChildren;
  class?: string;
}) {
  return (
    <section
      class={`psec${extra ? ` ${extra}` : ''}`}
      aria-labelledby={`ps-${id}`}
      data-testid={`print-section-${id}`}
    >
      <h2 id={`ps-${id}`} class="psec__title">
        {title}
      </h2>
      {children}
    </section>
  );
}

export interface KvItem {
  key: string;
  label: string;
  value: ComponentChildren;
}

/** Definition list of the facts that have a value (empty values are left out, not printed as blanks). */
export function Kv({ items, testId }: { items: KvItem[]; testId?: string }) {
  const shown = items.filter((i) => i.value !== null && i.value !== undefined && i.value !== '');
  if (shown.length === 0) return <p class="muted">{t('reports.printNothing')}</p>;
  return (
    <dl class="pkv" data-testid={testId}>
      {shown.map((i) => (
        <div key={i.key} class="pkv__row" data-key={i.key}>
          <dt>{i.label}</dt>
          <dd>{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Yes / no / unknown of a nullable boolean, translated. */
export function yesNo(v: unknown): string {
  return v === true
    ? enumLabel('boolean', 'true')
    : v === false
      ? enumLabel('boolean', 'false')
      : '';
}

/** A report photo as the photo module's row type (only the fields `photoUrl` reads). */
export function asPhotoRow(p: ReportPhoto): PhotoRow {
  return {
    id: p.id,
    storage_path_full: p.storage_path_full,
    storage_path_thumb: p.storage_path_thumb,
    upload_state: 'uploaded',
    purged_at: null,
    is_cover: p.is_cover,
    category: p.category,
    caption: p.caption,
    taken_at: p.taken_at,
  } as unknown as PhotoRow;
}

export function photoText(p: ReportPhoto): string {
  const parts: string[] = [];
  if (p.category && p.category !== 'unspecified')
    parts.push(enumLabel('photo_category', p.category));
  if (p.caption) parts.push(p.caption);
  return parts.join(' — ');
}

export function PhotoImg({
  photo,
  kind,
  class: cls,
  alt,
}: {
  photo: ReportPhoto;
  kind: 'thumb' | 'full';
  class?: string;
  alt: string;
}) {
  const { url, status } = usePhotoUrl(asPhotoRow(photo), kind);
  if (!url) {
    return (
      <span
        class={`pphoto pphoto--empty ${cls ?? ''}`}
        data-status={status}
        role="img"
        aria-label={alt}
      >
        {status === 'loading' ? '' : t('reports.photoUnavailable')}
      </span>
    );
  }
  return <img class={`pphoto ${cls ?? ''}`} src={url} alt={alt} loading="eager" decoding="async" />;
}

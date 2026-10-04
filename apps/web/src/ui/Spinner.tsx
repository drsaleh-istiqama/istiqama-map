import { t } from '../i18n';

export interface SpinnerProps {
  size?: number;
  /** Accessible name. Omit inside a control that already has one (the spinner is then decorative). */
  label?: string;
  /** Centre the spinner in a block of its own with the default "loading" label. */
  block?: boolean;
}

export function Spinner({ size = 24, label, block }: SpinnerProps) {
  const name = label ?? (block ? t('ui.loading') : undefined);
  const ring = (
    <span
      class="spinner"
      style={{ inlineSize: `${size}px`, blockSize: `${size}px` }}
      role={name ? 'status' : undefined}
      aria-label={name}
      aria-hidden={name ? undefined : 'true'}
    />
  );
  return block ? <div class="spinner-block">{ring}</div> : ring;
}

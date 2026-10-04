import type { ComponentChildren } from 'preact';

/** Project status tones use the contract colours; the others are generic feedback tones. */
export type BadgeTone =
  | 'neutral'
  | 'active'
  | 'maintenance'
  | 'building'
  | 'inactive'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger'
  | 'gold';

export interface BadgeProps {
  tone?: BadgeTone;
  testId?: string;
  title?: string;
  children?: ComponentChildren;
}

export function Badge({ tone = 'neutral', testId, title, children }: BadgeProps) {
  return (
    <span class={`badge badge--${tone}`} data-testid={testId} title={title}>
      {children}
    </span>
  );
}

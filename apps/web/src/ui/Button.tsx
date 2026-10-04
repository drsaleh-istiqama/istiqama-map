import type { ButtonHTMLAttributes, ComponentChildren } from 'preact';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'gold' | 'danger' | 'ghost';

export interface ButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'class' | 'className' | 'size' | 'icon'
> {
  /** primary = navy, gold = the single main action of a screen, secondary = outlined, danger, ghost = text only. */
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  /** Full inline width (forms on phones). */
  block?: boolean;
  /** Shows a spinner and blocks clicks while an action runs. */
  busy?: boolean;
  /** Icon placed before the label. */
  icon?: ComponentChildren;
  testId?: string;
  class?: string;
  children?: ComponentChildren;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  block,
  busy,
  icon,
  testId,
  class: extra,
  type = 'button',
  disabled,
  children,
  ...rest
}: ButtonProps) {
  const classes = [
    'btn',
    `btn--${variant}`,
    size === 'sm' && 'btn--sm',
    block && 'btn--block',
    extra,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      {...rest}
      type={type}
      class={classes}
      data-testid={testId}
      disabled={disabled || busy}
      aria-busy={busy ? 'true' : undefined}
    >
      {busy ? <Spinner size={18} /> : icon}
      {children != null && <span class="btn__label">{children}</span>}
    </button>
  );
}

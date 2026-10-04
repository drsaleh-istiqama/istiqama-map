import type { ComponentChildren } from 'preact';
import { navigate } from '../routes';

export interface LinkProps {
  /** In-app path, e.g. `/projects/new`. */
  href: string;
  /** Replace the current history entry instead of adding one. */
  replace?: boolean;
  /** Runs before navigation; call `event.preventDefault()` to cancel it. */
  onClick?: (event: MouseEvent) => void;
  testId?: string;
  class?: string;
  title?: string;
  'aria-current'?: 'page' | undefined;
  'aria-label'?: string;
  children?: ComponentChildren;
}

/** A real <a href> (long-press, "open in new tab" and keyboard all work) that navigates in-app on a plain click. */
export function Link({
  href,
  replace,
  onClick,
  testId,
  class: className,
  children,
  ...rest
}: LinkProps) {
  return (
    <a
      {...rest}
      href={href}
      class={className}
      data-testid={testId}
      onClick={(event) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        navigate(href, { replace });
      }}
    >
      {children}
    </a>
  );
}

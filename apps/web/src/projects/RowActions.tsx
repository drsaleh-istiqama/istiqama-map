import type { ComponentChildren } from 'preact';

/**
 * Buttons and links inside a row of `<VirtualList>` (whose rows are the interactive unit:
 * a click, Enter or Space on the row opens it).
 *
 * - A click on an action never also activates the row underneath.
 * - Focusing an action (Tab) makes its row the list's active row, so the arrow keys, Page
 *   Up/Down, Home and End continue from the row the user is on, and Shift+Tab returns to it.
 */
export function RowActions({
  children,
  class: extra,
}: {
  children: ComponentChildren;
  class?: string;
}) {
  return (
    <div
      class={extra ? `rrow__actions ${extra}` : 'rrow__actions'}
      onClick={(event) => event.stopPropagation()}
      onFocusIn={(event) => {
        const row = (event.currentTarget as HTMLElement).closest<HTMLElement>('[data-index]');
        if (row && event.target !== row) row.dispatchEvent(new FocusEvent('focus'));
      }}
    >
      {children}
    </div>
  );
}

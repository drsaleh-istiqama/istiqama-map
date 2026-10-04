/**
 * Keyboard model of an ARIA 1.2 combobox with a listbox popup (input keeps DOM focus, the
 * active option is announced through `aria-activedescendant`). Used by the person picker
 * and the merge tool's person search.
 *
 *   ArrowDown / ArrowUp  open the list and move the active option (wraps)
 *   Home / End           first / last option (only while the list is open)
 *   Enter                choose the active option — never an option the user did not reach
 *   Escape               close the list (the surrounding dialog stays open)
 */
import { useEffect, useState } from 'preact/hooks';

export interface Combobox {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** -1 = no active option (Enter then does nothing). */
  active: number;
  setActive: (index: number) => void;
  optionId: (index: number) => string;
  /** Value for `aria-activedescendant` on the input. */
  activeId: string | undefined;
  onKeyDown: (event: KeyboardEvent) => void;
}

export function useCombobox(opts: {
  baseId: string;
  count: number;
  onChoose: (index: number) => void;
}): Combobox {
  const { baseId, count, onChoose } = opts;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  // A new result list starts without an active option: nothing is pre-selected for the user.
  useEffect(() => {
    setActive(-1);
  }, [count]);

  const optionId = (index: number): string => `${baseId}-opt-${index}`;
  const move = (next: number): void => {
    setOpen(true);
    setActive(next);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing) return;
    switch (event.key) {
      case 'ArrowDown':
        if (count === 0) return;
        event.preventDefault();
        move(!open || active < 0 ? 0 : (active + 1) % count);
        break;
      case 'ArrowUp':
        if (count === 0) return;
        event.preventDefault();
        move(!open || active <= 0 ? count - 1 : active - 1);
        break;
      case 'Home':
      case 'End':
        if (!open || count === 0) return;
        event.preventDefault();
        setActive(event.key === 'Home' ? 0 : count - 1);
        break;
      case 'Enter':
        if (open && active >= 0 && active < count) {
          event.preventDefault();
          onChoose(active);
        }
        break;
      case 'Escape':
        if (open) {
          // Close the popup only; the dialog around the picker must not see this Escape.
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          setActive(-1);
        }
        break;
      default:
        break;
    }
  };

  return {
    open,
    setOpen,
    active,
    setActive,
    optionId,
    activeId: open && active >= 0 && active < count ? optionId(active) : undefined,
    onKeyDown,
  };
}

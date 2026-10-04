import { liveQuery } from 'dexie';
import type { RefObject } from 'preact';
import { useEffect, useLayoutEffect, useState, type Inputs } from 'preact/hooks';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Elements inside `container` that take keyboard focus, in DOM order. */
export function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.closest('[hidden]') && el.getAttribute('aria-hidden') !== 'true',
  );
}

/** Open traps, innermost last. Only the innermost one reacts (nested dialogs). */
const trapStack: HTMLElement[] = [];

/**
 * Keeps keyboard focus inside `ref` while `active`: moves focus in (to `[data-autofocus]`,
 * else the first focusable element, else the container), wraps Tab / Shift+Tab, pulls focus
 * back when it escapes, and returns it to the previously focused element afterwards.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active = true): void {
  // Layout effect: Preact defers passive clean-ups until after paint, but focus must be back
  // on the opener (and the trap gone) in the same commit that removes the dialog.
  useLayoutEffect(() => {
    const container = ref.current;
    if (!active || !container) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    trapStack.push(container);

    const isInnermost = (): boolean => trapStack[trapStack.length - 1] === container;
    const first = (): HTMLElement => focusableElements(container)[0] ?? container;
    if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
    (container.querySelector<HTMLElement>('[data-autofocus]') ?? first()).focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' || !isInnermost()) return;
      const items = focusableElements(container);
      const current = document.activeElement;
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (!firstItem || !lastItem) {
        event.preventDefault();
        container.focus();
      } else if (
        event.shiftKey &&
        (current === firstItem || current === container || !container.contains(current))
      ) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && (current === lastItem || !container.contains(current))) {
        event.preventDefault();
        firstItem.focus();
      }
    };
    const onFocusIn = (event: FocusEvent): void => {
      if (isInnermost() && event.target instanceof Node && !container.contains(event.target))
        first().focus();
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn);
      const index = trapStack.lastIndexOf(container);
      if (index >= 0) trapStack.splice(index, 1);
      if (opener && opener.isConnected) opener.focus();
    };
  }, [ref, active]);
}

/** The value, but only after it stopped changing for `ms` milliseconds (search boxes: 250 ms). */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(() => value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/**
 * Runs a Dexie query and re-runs it whenever the rows it read change (Dexie `liveQuery`).
 * Returns `initial` (default `undefined`) until the first result arrives; the subscription
 * is closed on unmount and whenever `deps` change.
 */
export function useLiveQuery<T>(
  query: () => T | Promise<T>,
  deps: Inputs = [],
  initial?: T,
): T | undefined {
  const [value, setValue] = useState<T | undefined>(initial);
  useEffect(() => {
    const subscription = liveQuery(query).subscribe({
      next: (result) => setValue(() => result),
      error: (error: unknown) => console.error('[useLiveQuery]', error),
    });
    return () => subscription.unsubscribe();
    // The caller lists what the query depends on, exactly like useEffect.
  }, deps);
  return value;
}

/** Tracks a CSS media query (used to render either the sidebar or the mobile navigation). */
export function useMediaQuery(query: string): boolean {
  const read = (): boolean =>
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(query).matches;
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const onChange = (): void => setMatches(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

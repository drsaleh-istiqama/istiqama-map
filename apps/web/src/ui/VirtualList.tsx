import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { computeWindow, isNearEnd, nextIndexForKey, scrollTopToReveal } from './virtualWindow';

interface VirtualListBase {
  /** Fixed row height in px. Keep `rows × rowHeight` under ~16 million px (browser limit). */
  rowHeight: number;
  /** Called once per list length when the user nears the end: fetch the next keyset page. */
  onEndReached?: () => void;
  /** Rows before the end at which `onEndReached` fires (default 10). */
  endThreshold?: number;
  overscan?: number;
  /** Enter / Space / click on a row. Rows are the interactive unit: avoid nested tab stops. */
  onActivate?: (index: number) => void;
  /** Accessible name of the list. */
  label?: string;
  testId?: string;
  class?: string;
}

export interface VirtualListItemsProps<T> extends VirtualListBase {
  items: readonly T[];
  renderRow: (item: T, index: number) => ComponentChildren;
  /** Stable identity of a row (defaults to its index). */
  rowKey?: (item: T, index: number) => string | number;
}

export interface VirtualListCountProps extends VirtualListBase {
  itemCount: number;
  renderRow: (index: number) => ComponentChildren;
}

export type VirtualListProps<T> = VirtualListItemsProps<T> | VirtualListCountProps;

/** Viewport height assumed before the element is measured (and where layout is unavailable). */
const FALLBACK_VIEWPORT = 600;

/**
 * Windowed list for very long registers (100,000 rows): only the rows in view plus a small
 * overscan exist in the DOM. The element fills its parent — give the parent a height.
 * Keyboard: one tab stop; Arrow keys, Page Up/Down, Home and End move between rows.
 */
export function VirtualList<T>(props: VirtualListItemsProps<T>): ComponentChildren;
export function VirtualList(props: VirtualListCountProps): ComponentChildren;
export function VirtualList<T>(props: VirtualListProps<T>): ComponentChildren {
  const { rowHeight, onEndReached, endThreshold = 10, overscan, onActivate, label, testId } = props;
  const count = 'items' in props ? props.items.length : props.itemCount;

  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(FALLBACK_VIEWPORT);
  const [active, setActive] = useState(0);
  const focusActive = useRef(false);
  const notifiedFor = useRef(-1);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = (): void => {
      if (element.clientHeight > 0) setViewport(element.clientHeight);
    };
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const range = computeWindow({ scrollTop, viewportHeight: viewport, rowHeight, count, overscan });
  const activeIndex = Math.min(active, Math.max(0, count - 1));

  useEffect(() => {
    if (!onEndReached || !isNearEnd(range, count, endThreshold) || notifiedFor.current === count)
      return;
    notifiedFor.current = count;
    onEndReached();
  }, [range.end, count, endThreshold, onEndReached]);

  // After a keyboard move the target row may only now exist in the DOM: focus it.
  useEffect(() => {
    if (!focusActive.current) return;
    focusActive.current = false;
    scroller.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.focus();
  });

  const onKeyDown = (event: KeyboardEvent): void => {
    const row =
      event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>('[data-index]')
        : null;
    if ((event.key === 'Enter' || event.key === ' ') && row && event.target === row) {
      event.preventDefault();
      onActivate?.(Number(row.dataset.index));
      return;
    }
    const pageSize = Math.max(1, Math.floor(viewport / rowHeight) - 1);
    const next = nextIndexForKey(event.key, activeIndex, count, pageSize);
    if (next === null) return;
    event.preventDefault();
    const element = scroller.current;
    if (element) {
      const top = scrollTopToReveal(next, element.scrollTop, viewport, rowHeight);
      if (top !== element.scrollTop) {
        element.scrollTop = top;
        setScrollTop(top);
      }
    }
    focusActive.current = true;
    setActive(next);
  };

  const rows: ComponentChildren[] = [];
  for (let index = range.start; index < range.end; index++) {
    let key: string | number = index;
    let content: ComponentChildren;
    if ('items' in props) {
      const item = props.items[index] as T;
      key = props.rowKey ? props.rowKey(item, index) : index;
      content = props.renderRow(item, index);
    } else {
      content = props.renderRow(index);
    }
    rows.push(
      <div
        key={key}
        class={index === activeIndex ? 'vlist__row vlist__row--active' : 'vlist__row'}
        role="listitem"
        aria-setsize={count}
        aria-posinset={index + 1}
        data-index={index}
        tabIndex={index === activeIndex ? 0 : -1}
        style={{ blockSize: `${rowHeight}px`, transform: `translateY(${index * rowHeight}px)` }}
        onFocus={() => setActive(index)}
        onClick={onActivate ? () => onActivate(index) : undefined}
      >
        {content}
      </div>,
    );
  }

  return (
    <div
      ref={scroller}
      class={props.class ? `vlist ${props.class}` : 'vlist'}
      data-testid={testId}
      // Snap to row boundaries: the state (and so the render) changes only when a row scrolls in or out.
      onScroll={(event) =>
        setScrollTop(Math.floor(event.currentTarget.scrollTop / rowHeight) * rowHeight)
      }
      onKeyDown={onKeyDown}
    >
      <div
        class="vlist__sizer"
        role="list"
        aria-label={label}
        style={{ blockSize: `${range.totalHeight}px` }}
      >
        {rows}
      </div>
    </div>
  );
}

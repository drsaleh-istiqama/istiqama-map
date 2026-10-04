/** Window maths of <VirtualList>: pure functions, unit-tested without a DOM. */

export interface WindowInput {
  /** Scroll offset of the viewport in px. */
  scrollTop: number;
  /** Visible height of the viewport in px. */
  viewportHeight: number;
  /** Fixed height of every row in px. */
  rowHeight: number;
  /** Total number of rows. */
  count: number;
  /** Extra rows rendered above and below the visible ones (smooth scrolling, keyboard focus). */
  overscan?: number;
}

export interface WindowRange {
  /** Index of the first rendered row. */
  start: number;
  /** Index after the last rendered row (exclusive). */
  end: number;
  /** Height of the whole list in px (what the scrollbar represents). */
  totalHeight: number;
}

export const DEFAULT_OVERSCAN = 4;

/** Which rows must exist in the DOM for the current scroll position. */
export function computeWindow({
  scrollTop,
  viewportHeight,
  rowHeight,
  count,
  overscan = DEFAULT_OVERSCAN,
}: WindowInput): WindowRange {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0, totalHeight: 0 };
  const totalHeight = count * rowHeight;
  const maxScroll = Math.max(0, totalHeight - viewportHeight);
  const top = Math.min(Math.max(0, scrollTop), maxScroll);
  const firstVisible = Math.floor(top / rowHeight);
  // +1: a partially visible row at each edge.
  const visibleRows = Math.ceil(Math.max(0, viewportHeight) / rowHeight) + 1;
  const start = Math.max(0, firstVisible - overscan);
  const end = Math.min(count, firstVisible + visibleRows + overscan);
  return { start, end, totalHeight };
}

/** Smallest scroll offset change that brings row `index` fully into view. */
export function scrollTopToReveal(
  index: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
): number {
  const rowTop = index * rowHeight;
  const rowBottom = rowTop + rowHeight;
  if (rowTop < scrollTop) return rowTop;
  if (rowBottom > scrollTop + viewportHeight) return Math.max(0, rowBottom - viewportHeight);
  return scrollTop;
}

/** Row reached by a navigation key, or null when the key is not a navigation key. */
export function nextIndexForKey(
  key: string,
  index: number,
  count: number,
  pageSize: number,
): number | null {
  if (count <= 0) return null;
  const last = count - 1;
  const clamp = (i: number): number => Math.min(last, Math.max(0, i));
  switch (key) {
    case 'ArrowDown':
      return clamp(index + 1);
    case 'ArrowUp':
      return clamp(index - 1);
    case 'PageDown':
      return clamp(index + Math.max(1, pageSize));
    case 'PageUp':
      return clamp(index - Math.max(1, pageSize));
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return null;
  }
}

/** True when the rendered window is within `threshold` rows of the end (time to fetch the next keyset page). */
export function isNearEnd(range: WindowRange, count: number, threshold: number): boolean {
  return count > 0 && range.end >= count - threshold;
}

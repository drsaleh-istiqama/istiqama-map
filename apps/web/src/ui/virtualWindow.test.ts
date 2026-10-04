import { describe, expect, it } from 'vitest';
import { computeWindow, isNearEnd, nextIndexForKey, scrollTopToReveal } from './virtualWindow';

describe('computeWindow', () => {
  const base = { rowHeight: 64, viewportHeight: 640, overscan: 4 };

  it('renders nothing for an empty list or a zero row height', () => {
    expect(computeWindow({ ...base, scrollTop: 0, count: 0 })).toEqual({
      start: 0,
      end: 0,
      totalHeight: 0,
    });
    expect(computeWindow({ ...base, rowHeight: 0, scrollTop: 0, count: 10 })).toEqual({
      start: 0,
      end: 0,
      totalHeight: 0,
    });
  });

  it('renders the visible rows plus overscan at the top of the list', () => {
    // 640 / 64 = 10 visible rows, +1 partial row, +4 overscan below.
    expect(computeWindow({ ...base, scrollTop: 0, count: 100_000 })).toEqual({
      start: 0,
      end: 15,
      totalHeight: 6_400_000,
    });
  });

  it('keeps the DOM small in the middle of 100,000 rows', () => {
    const range = computeWindow({ ...base, scrollTop: 50_000 * 64, count: 100_000 });
    expect(range.start).toBe(50_000 - 4);
    expect(range.end).toBe(50_000 + 11 + 4);
    expect(range.end - range.start).toBe(19);
  });

  it('handles a scroll offset between two rows', () => {
    const range = computeWindow({ ...base, scrollTop: 64 * 7 + 30, count: 1000 });
    expect(range.start).toBe(3);
    expect(range.end).toBe(7 + 11 + 4);
  });

  it('clamps at the end of the list and when over-scrolled', () => {
    const count = 1000;
    const atEnd = computeWindow({ ...base, scrollTop: count * 64 - 640, count });
    expect(atEnd.end).toBe(count);
    expect(atEnd.start).toBe(count - 10 - 4);
    const beyond = computeWindow({ ...base, scrollTop: 10_000_000, count });
    expect(beyond).toEqual(atEnd);
    expect(computeWindow({ ...base, scrollTop: -500, count }).start).toBe(0);
  });

  it('renders every row of a list shorter than the viewport', () => {
    expect(computeWindow({ ...base, scrollTop: 0, count: 3 })).toEqual({
      start: 0,
      end: 3,
      totalHeight: 192,
    });
  });

  it('respects a custom overscan', () => {
    const range = computeWindow({ ...base, overscan: 0, scrollTop: 640, count: 1000 });
    expect(range.start).toBe(10);
    expect(range.end).toBe(21);
  });

  it('never renders more than a screenful plus overscan, whatever the scroll position', () => {
    for (const scrollTop of [0, 1, 63, 64, 65, 9_999, 123_456, 6_399_999]) {
      const { start, end } = computeWindow({ ...base, scrollTop, count: 100_000 });
      expect(end - start).toBeLessThanOrEqual(10 + 1 + 8);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(100_000);
    }
  });
});

describe('scrollTopToReveal', () => {
  it('does not move when the row is already fully visible', () => {
    expect(scrollTopToReveal(5, 0, 640, 64)).toBe(0);
    expect(scrollTopToReveal(9, 0, 640, 64)).toBe(0);
  });

  it('scrolls down just enough to show a row below the viewport', () => {
    expect(scrollTopToReveal(10, 0, 640, 64)).toBe(64);
    expect(scrollTopToReveal(99, 0, 640, 64)).toBe(100 * 64 - 640);
  });

  it('scrolls up to a row above the viewport', () => {
    expect(scrollTopToReveal(2, 640, 640, 64)).toBe(128);
    expect(scrollTopToReveal(0, 999, 640, 64)).toBe(0);
  });
});

describe('nextIndexForKey', () => {
  it('moves by one row with the arrow keys and stops at the ends', () => {
    expect(nextIndexForKey('ArrowDown', 0, 10, 5)).toBe(1);
    expect(nextIndexForKey('ArrowDown', 9, 10, 5)).toBe(9);
    expect(nextIndexForKey('ArrowUp', 0, 10, 5)).toBe(0);
    expect(nextIndexForKey('ArrowUp', 4, 10, 5)).toBe(3);
  });

  it('moves by a page and jumps to the ends', () => {
    expect(nextIndexForKey('PageDown', 2, 100, 9)).toBe(11);
    expect(nextIndexForKey('PageUp', 2, 100, 9)).toBe(0);
    expect(nextIndexForKey('Home', 57, 100, 9)).toBe(0);
    expect(nextIndexForKey('End', 57, 100, 9)).toBe(99);
  });

  it('ignores other keys and empty lists', () => {
    expect(nextIndexForKey('a', 0, 10, 5)).toBeNull();
    expect(nextIndexForKey('Tab', 0, 10, 5)).toBeNull();
    expect(nextIndexForKey('ArrowDown', 0, 0, 5)).toBeNull();
  });
});

describe('isNearEnd', () => {
  it('is true only within the threshold of the last row', () => {
    expect(isNearEnd({ start: 0, end: 15, totalHeight: 0 }, 50, 10)).toBe(false);
    expect(isNearEnd({ start: 26, end: 40, totalHeight: 0 }, 50, 10)).toBe(true);
    expect(isNearEnd({ start: 0, end: 0, totalHeight: 0 }, 0, 10)).toBe(false);
  });
});

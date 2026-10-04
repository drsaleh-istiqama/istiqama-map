import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { debounce, latestOnly } from './debounce';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('debounce', () => {
  it('runs once, waitMs after the last call, with the last arguments', () => {
    const fn = vi.fn();
    const d = debounce(fn, 250);
    d('م');
    vi.advanceTimersByTime(200);
    d('مس');
    vi.advanceTimersByTime(200);
    d('مسجد');
    expect(fn).not.toHaveBeenCalled();
    expect(d.pending()).toBe(true);
    vi.advanceTimersByTime(250);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('مسجد');
    expect(d.pending()).toBe(false);
  });

  it('cancel drops the pending call; flush runs it now', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d(1);
    d.cancel();
    vi.advanceTimersByTime(500);
    expect(fn).not.toHaveBeenCalled();
    d(2);
    d.flush();
    expect(fn).toHaveBeenCalledWith(2);
    d.flush(); // nothing pending: no second call
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('latestOnly', () => {
  it('delivers only the answer of the latest call', async () => {
    vi.useRealTimers();
    const slow = (q: string, ms: number): Promise<string> =>
      new Promise((r) => setTimeout(() => r(q), ms));
    const search = latestOnly(slow);
    const first = search('old', 30);
    const second = search('new', 5);
    expect(await second).toBe('new');
    expect(await first).toBeUndefined();
  });
});

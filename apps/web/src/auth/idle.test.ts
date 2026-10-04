import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_IDLE_MINUTES, createIdleTracker, idleMinutesFromSetting } from './idle';
import { Vault } from './vault';

const FIFTEEN_MINUTES = 15 * 60_000;

/** Minimal stand-ins for window/document so that visibility can be scripted. */
function fakeDom() {
  const target = new EventTarget();
  const doc = Object.assign(new EventTarget(), {
    visibilityState: 'visible' as DocumentVisibilityState,
  });
  return {
    target: target as unknown as Window,
    doc: doc as unknown as Document,
    press: (type = 'pointerdown') => target.dispatchEvent(new Event(type)),
    setVisibility(state: DocumentVisibilityState) {
      doc.visibilityState = state;
      doc.dispatchEvent(new Event('visibilitychange'));
    },
  };
}

describe('idle tracker', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-10-03T08:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires once after the limit without activity', () => {
    const dom = fakeDom();
    const onIdle = vi.fn();
    const tracker = createIdleTracker({ timeoutMs: FIFTEEN_MINUTES, onIdle, ...dom });
    tracker.start();
    vi.advanceTimersByTime(FIFTEEN_MINUTES - 1);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(tracker.running).toBe(false);
    vi.advanceTimersByTime(FIFTEEN_MINUTES * 3);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('pointer and key activity restart the clock', () => {
    const dom = fakeDom();
    const onIdle = vi.fn();
    const tracker = createIdleTracker({ timeoutMs: FIFTEEN_MINUTES, onIdle, ...dom });
    tracker.start();
    vi.advanceTimersByTime(10 * 60_000);
    dom.press('pointerdown');
    vi.advanceTimersByTime(10 * 60_000);
    dom.press('keydown');
    vi.advanceTimersByTime(FIFTEEN_MINUTES - 1);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('time spent hidden counts as idle, even when timers were frozen', () => {
    const dom = fakeDom();
    const onIdle = vi.fn();
    const tracker = createIdleTracker({ timeoutMs: FIFTEEN_MINUTES, onIdle, ...dom });
    tracker.start();
    vi.advanceTimersByTime(5 * 60_000);
    dom.setVisibility('hidden');
    dom.press(); // events in a hidden tab are not "use"
    // The phone sleeps: the wall clock moves on, no timer runs.
    vi.setSystemTime(Date.now() + 20 * 60_000);
    expect(onIdle).not.toHaveBeenCalled();
    dom.setVisibility('visible');
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('a short absence does not lock, and coming back counts as activity', () => {
    const dom = fakeDom();
    const onIdle = vi.fn();
    const tracker = createIdleTracker({ timeoutMs: FIFTEEN_MINUTES, onIdle, ...dom });
    tracker.start();
    dom.setVisibility('hidden');
    vi.advanceTimersByTime(5 * 60_000);
    dom.setVisibility('visible');
    vi.advanceTimersByTime(FIFTEEN_MINUTES - 1);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('a tap that arrives after the limit (timer was late) locks instead of rescuing', () => {
    const dom = fakeDom();
    const onIdle = vi.fn();
    const tracker = createIdleTracker({ timeoutMs: FIFTEEN_MINUTES, onIdle, ...dom });
    tracker.start();
    vi.setSystemTime(Date.now() + FIFTEEN_MINUTES + 5);
    dom.press();
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('stop() cancels, a new limit applies immediately', () => {
    const dom = fakeDom();
    const onIdle = vi.fn();
    const tracker = createIdleTracker({ timeoutMs: FIFTEEN_MINUTES, onIdle, ...dom });
    tracker.start();
    tracker.stop();
    vi.advanceTimersByTime(FIFTEEN_MINUTES * 2);
    dom.press();
    expect(onIdle).not.toHaveBeenCalled();

    tracker.start();
    vi.advanceTimersByTime(3 * 60_000);
    tracker.setTimeoutMs(2 * 60_000); // already exceeded
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('reads security.pin_lock_minutes defensively (default 15)', () => {
    expect(DEFAULT_IDLE_MINUTES).toBe(15);
    expect(idleMinutesFromSetting(15)).toBe(15);
    expect(idleMinutesFromSetting('5')).toBe(5);
    expect(idleMinutesFromSetting(0)).toBe(15);
    expect(idleMinutesFromSetting(-3)).toBe(15);
    expect(idleMinutesFromSetting(null)).toBe(15);
    expect(idleMinutesFromSetting({ minutes: 5 })).toBe(15);
    expect(idleMinutesFromSetting(100_000)).toBe(240);
    expect(idleMinutesFromSetting(0.2)).toBe(1);
  });
});

describe('lock after idle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops the key and the in-memory session after 15 minutes without use', async () => {
    const key = 'istiqama-auth';
    const vault = new Vault({
      sessionKey: key,
      dbName: `idle-vault-${Math.random().toString(36).slice(2)}`,
    });
    await vault.storage.setItem(
      key,
      JSON.stringify({ access_token: 'a', refresh_token: 'r', user: { id: 'u' } }),
    );
    await vault.setPin('4071');
    expect(vault.isUnlocked()).toBe(true);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const dom = fakeDom();
    const tracker = createIdleTracker({
      timeoutMs: DEFAULT_IDLE_MINUTES * 60_000,
      onIdle: () => vault.lock(),
      ...dom,
    });
    tracker.start();
    vi.advanceTimersByTime(14 * 60_000);
    dom.press();
    vi.advanceTimersByTime(14 * 60_000);
    expect(vault.locked.value).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(vault.locked.value).toBe(true);
    expect(vault.isUnlocked()).toBe(false);
    expect(vault.storage.getItem(key)).toBeNull();

    vi.useRealTimers();
    expect(await vault.unlock('4071')).toBe('ok');
  });
});

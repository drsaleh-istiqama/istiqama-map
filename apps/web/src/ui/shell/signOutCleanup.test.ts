import { signal } from '@preact/signals';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prefs: new Map<string, unknown>(),
  purge: vi.fn(async () => undefined),
}));

vi.mock('../../lib/prefs', () => ({
  getPref: <T>(key: string, fallback: T): T =>
    mocks.prefs.has(key) ? (mocks.prefs.get(key) as T) : fallback,
  setPref: (key: string, value: unknown): void => {
    if (value === null || value === undefined) mocks.prefs.delete(key);
    else mocks.prefs.set(key, value);
  },
}));
vi.mock('../pwa/register', () => ({ purgeUserCaches: mocks.purge }));

import { useViewFilters } from '../../routes';
import { clearUserTraces, watchSignedOut } from './signOutCleanup';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  mocks.prefs.clear();
  mocks.purge.mockClear();
});

describe('sign-out clean-up', () => {
  it('clearUserTraces forgets the saved filters and empties the per-user caches', async () => {
    const [, set] = useViewFilters('projects', { q: '' });
    set({ q: 'a person name' });
    expect(mocks.prefs.get('filters.projects')).toEqual({ q: 'a person name' });

    await clearUserTraces();
    expect(mocks.prefs.has('filters.projects')).toBe(false);
    expect(useViewFilters('projects', { q: '' })[0]).toEqual({ q: '' });
    expect(mocks.purge).toHaveBeenCalledTimes(1);
  });

  it('runs whenever the app enters the signed-out state, never on a PIN lock', async () => {
    const state = signal('loading');
    const onSignedOut = vi.fn();
    const stop = watchSignedOut(state, onSignedOut);

    state.value = 'ready';
    state.value = 'locked'; // PIN lock: the user is coming back
    state.value = 'ready';
    await flush();
    expect(onSignedOut).not.toHaveBeenCalled();

    state.value = 'signed_out'; // sign-out, revocation, forgotten PIN…
    await flush();
    expect(onSignedOut).toHaveBeenCalledTimes(1);

    state.value = 'signed_out';
    await flush();
    expect(onSignedOut).toHaveBeenCalledTimes(1); // once per transition

    state.value = 'ready';
    state.value = 'signed_out';
    await flush();
    expect(onSignedOut).toHaveBeenCalledTimes(2);

    stop();
    state.value = 'ready';
    state.value = 'signed_out';
    await flush();
    expect(onSignedOut).toHaveBeenCalledTimes(2);
  });

  it('also cleans up at start-up on a device without a session, and swallows failures', async () => {
    const state = signal('signed_out');
    const onSignedOut = vi.fn(async () => {
      throw new Error('caches unavailable');
    });
    const stop = watchSignedOut(state, onSignedOut);
    await flush();
    expect(onSignedOut).toHaveBeenCalledTimes(1);
    stop();
  });
});

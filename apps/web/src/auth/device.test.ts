import { beforeEach, describe, expect, it, vi } from 'vitest';

const prefs = vi.hoisted(() => new Map<string, unknown>());

vi.mock('../lib/prefs', () => ({
  getPref: <T>(key: string, fallback: T): T => (prefs.has(key) ? (prefs.get(key) as T) : fallback),
  setPref: (key: string, value: unknown): void => {
    prefs.set(key, value);
  },
}));

import { deviceId, resetDeviceIdCache } from './device';

const SERVER_RULE = /^[A-Za-z0-9._:-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('deviceId', () => {
  beforeEach(() => {
    prefs.clear();
    resetDeviceIdCache();
  });

  it('creates a uuid that satisfies the server rule and stores it through prefs', () => {
    const id = deviceId();
    expect(id).toMatch(UUID);
    expect(id).toMatch(SERVER_RULE);
    expect(prefs.get('auth.device_id')).toBe(id);
  });

  it('is stable within a session', () => {
    expect(deviceId()).toBe(deviceId());
  });

  it('is stable across restarts of the app (read back from prefs)', () => {
    const first = deviceId();
    resetDeviceIdCache(); // a new page load: module state is gone, prefs are not
    expect(deviceId()).toBe(first);
    expect(prefs.size).toBe(1);
  });

  it('differs between installations', () => {
    const first = deviceId();
    prefs.clear();
    resetDeviceIdCache();
    expect(deviceId()).not.toBe(first);
  });

  it('replaces a stored value the server would reject', () => {
    prefs.set('auth.device_id', 'has spaces & symbols!');
    const id = deviceId();
    expect(id).toMatch(UUID);
    expect(prefs.get('auth.device_id')).toBe(id);
  });

  it('works without crypto.randomUUID (insecure context)', () => {
    const own = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID');
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    try {
      const id = deviceId();
      expect(id).toMatch(UUID);
      expect(id[14]).toBe('4'); // version nibble of a v4 uuid
    } finally {
      if (own) Object.defineProperty(globalThis.crypto, 'randomUUID', own);
      else delete (globalThis.crypto as { randomUUID?: unknown }).randomUUID;
    }
    expect(typeof globalThis.crypto.randomUUID).toBe('function');
  });
});

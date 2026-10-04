/**
 * UI preferences — the only localStorage access of the app: namespaced JSON values, safe when
 * storage is unavailable or full.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEGACY_V2_KEYS,
  clearPrefs,
  getPref,
  onPrefChange,
  readLegacyV2,
  removeLegacyV2,
  removePref,
  setPref,
} from './prefs';

const realStorage = globalThis.localStorage;

function useStorage(storage: Storage | undefined | 'throw'): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      if (storage === 'throw') throw new DOMException('denied', 'SecurityError');
      return storage;
    },
  });
}

beforeEach(() => {
  useStorage(realStorage);
  realStorage.clear();
  clearPrefs();
});

afterEach(() => {
  useStorage(realStorage);
});

describe('getPref / setPref', () => {
  it('stores JSON under the namespaced key and reads it back', () => {
    setPref('lang', 'sw');
    setPref('filters.projects', { type: 'mosque', status: ['active'] });
    expect(realStorage.getItem('istiqama.pref.lang')).toBe('"sw"');
    expect(getPref('lang', 'ar')).toBe('sw');
    expect(getPref('filters.projects', {})).toEqual({ type: 'mosque', status: ['active'] });
    expect(getPref('wifiOnly', false)).toBe(false);
  });

  it('never touches keys outside its namespace', () => {
    realStorage.setItem('lang', '"en"');
    expect(getPref('lang', 'ar')).toBe('ar');
    setPref('lang', 'sw');
    expect(realStorage.getItem('lang')).toBe('"en"');
  });

  it('falls back on corrupt values, removes on null / undefined', () => {
    realStorage.setItem('istiqama.pref.broken', '{not json');
    expect(getPref('broken', 7)).toBe(7);
    setPref('x', 1);
    setPref('x', null);
    expect(realStorage.getItem('istiqama.pref.x')).toBeNull();
    setPref('y', 1);
    removePref('y');
    expect(getPref('y', 0)).toBe(0);
  });

  it('ignores values that cannot be serialised', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => setPref('c', cyclic)).not.toThrow();
    expect(getPref('c', 'fallback')).toBe('fallback');
  });

  it('keeps working in memory when storage is missing, throws on access, or is full', () => {
    useStorage(undefined);
    setPref('a', 1);
    expect(getPref('a', 0)).toBe(1);

    useStorage('throw');
    setPref('b', 2);
    expect(getPref('b', 0)).toBe(2);
    expect(() => clearPrefs()).not.toThrow();
    expect(readLegacyV2('istiqama-projects-v2')).toBeNull();
    expect(() => removeLegacyV2('istiqama-projects-v2')).not.toThrow();

    useStorage(realStorage);
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    setPref('c', 3);
    expect(getPref('c', 0)).toBe(3);
    spy.mockRestore();
  });

  it('notifies listeners of changes in this tab; a failing listener does not stop the others', () => {
    const seen: Array<[string, unknown]> = [];
    const stopBad = onPrefChange(() => {
      throw new Error('bad');
    });
    const stop = onPrefChange((k, v) => seen.push([k, v]));
    setPref('lang', 'en');
    removePref('lang');
    stop();
    stopBad();
    setPref('lang', 'ar');
    expect(seen).toEqual([
      ['lang', 'en'],
      ['lang', null],
    ]);
  });
});

describe('clearPrefs and the v2 keys', () => {
  it('clearPrefs removes only this app’s preferences; v2 keys stay until migrated', () => {
    setPref('a', 1);
    realStorage.setItem('istiqama-projects-v2', '[]');
    realStorage.setItem('other-app', 'x');
    clearPrefs();
    expect(getPref('a', 0)).toBe(0);
    expect(realStorage.getItem('istiqama-projects-v2')).toBe('[]');
    expect(realStorage.getItem('other-app')).toBe('x');
  });

  it('reads and removes the legacy v2 keys only', () => {
    expect(LEGACY_V2_KEYS).toEqual(['istiqama-projects-v2', 'istiqama-people-v1']);
    realStorage.setItem('istiqama-people-v1', '[{"name":"x"}]');
    expect(readLegacyV2('istiqama-people-v1')).toBe('[{"name":"x"}]');
    removeLegacyV2('istiqama-people-v1');
    expect(readLegacyV2('istiqama-people-v1')).toBeNull();
  });
});

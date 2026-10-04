/**
 * UI preferences — the ONLY place in the web app that touches `localStorage`
 * (language, per-view filters, Wi-Fi-only flag, dismissed hints). Data never lives here:
 * records, drafts, queues and photos are in IndexedDB (`src/db`).
 *
 * Keys are namespaced (`istiqama.pref.<key>`), values are JSON. Every access is guarded:
 * with storage disabled (private mode, blocked cookies, quota errors) the values live in
 * memory for the session and the app keeps working.
 */

const PREFIX = 'istiqama.pref.';

/** localStorage keys written by v2; read once by the v2 → v3 migration, then removed. */
export const LEGACY_V2_KEYS = ['istiqama-projects-v2', 'istiqama-people-v1'] as const;
export type LegacyV2Key = (typeof LEGACY_V2_KEYS)[number];

const memory = new Map<string, string>();
type Listener = (key: string, value: unknown) => void;
const listeners = new Set<Listener>();

function storage(): Storage | null {
  try {
    const s = (globalThis as { localStorage?: Storage }).localStorage;
    return s ?? null;
  } catch {
    // Accessing the property itself can throw (SecurityError in sandboxed frames).
    return null;
  }
}

function readRaw(fullKey: string): string | null {
  const s = storage();
  if (s) {
    try {
      const v = s.getItem(fullKey);
      if (v !== null) return v;
    } catch {
      /* fall through to memory */
    }
  }
  return memory.get(fullKey) ?? null;
}

function writeRaw(fullKey: string, value: string | null): void {
  if (value === null) memory.delete(fullKey);
  else memory.set(fullKey, value);
  const s = storage();
  if (!s) return;
  try {
    if (value === null) s.removeItem(fullKey);
    else s.setItem(fullKey, value);
  } catch {
    /* quota exceeded or storage disabled: the in-memory copy still serves this session */
  }
}

/** Reads a preference; returns `fallback` when it is missing or unreadable. */
export function getPref<T>(key: string, fallback: T): T {
  const raw = readRaw(PREFIX + key);
  if (raw === null) return fallback;
  try {
    const parsed = JSON.parse(raw) as T | null | undefined;
    return parsed === undefined || parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/** Stores a preference. `undefined` or `null` removes it. */
export function setPref<T>(key: string, value: T): void {
  if (value === undefined || value === null) {
    writeRaw(PREFIX + key, null);
  } else {
    let raw: string;
    try {
      raw = JSON.stringify(value);
    } catch {
      return; // not serialisable: ignore instead of breaking the UI
    }
    writeRaw(PREFIX + key, raw);
  }
  for (const fn of listeners) {
    try {
      fn(key, value);
    } catch {
      /* a failing listener must not block the others */
    }
  }
}

export function removePref(key: string): void {
  setPref(key, null);
}

/** Notifies about preference changes made in this tab. Returns the unsubscribe function. */
export function onPrefChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Removes every preference of this app (sign-out on a shared device). Legacy keys stay. */
export function clearPrefs(): void {
  for (const k of Array.from(memory.keys())) {
    if (k.startsWith(PREFIX)) memory.delete(k);
  }
  const s = storage();
  if (!s) return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k !== null && k.startsWith(PREFIX)) doomed.push(k);
    }
    for (const k of doomed) s.removeItem(k);
  } catch {
    /* ignore */
  }
}

/**
 * Raw value of a v2 localStorage key (v2 kept ALL its data there). Only the v2 → v3
 * migration may call this; nothing else reads or writes un-namespaced keys.
 */
export function readLegacyV2(key: LegacyV2Key): string | null {
  const s = storage();
  if (!s) return null;
  try {
    return s.getItem(key);
  } catch {
    return null;
  }
}

/** Removes a v2 key after its content was uploaded successfully. */
export function removeLegacyV2(key: LegacyV2Key): void {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(key);
  } catch {
    /* ignore */
  }
}

// TEMPORARY STUB of src/lib/prefs.ts (docs/contracts/web.md §3.1) — see ../README.md.
const PREFIX = 'istiqama.pref.';

function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function getPref<T>(key: string, fallback: T): T {
  try {
    const raw = store()?.getItem(PREFIX + key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function setPref<T>(key: string, value: T): void {
  try {
    store()?.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Private mode or quota: preferences are best effort.
  }
}

/**
 * Key/value stores: `meta` (sync cursors, cached settings, local session), `drafts` (form
 * autosave) and the cached public `app_settings`.
 */
import { db } from './dexie';

// ---------------------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------------------

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const rec = await db.meta.get(key);
  return rec?.value as T | undefined;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value });
}

export async function deleteMeta(key: string): Promise<void> {
  await db.meta.delete(key);
}

/** Entries whose key starts with `prefix`, ordered by key. */
export async function listMeta<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
  const recs = await db.meta.where('key').startsWith(prefix).toArray();
  return recs.map((r) => ({ key: r.key, value: r.value as T }));
}

/** Atomic read-modify-write. Returning `undefined` from `fn` deletes the key. */
export async function updateMeta<T>(
  key: string,
  fn: (current: T | undefined) => T | undefined,
): Promise<T | undefined> {
  return db.transaction('rw', db.meta, async () => {
    const current = (await db.meta.get(key))?.value as T | undefined;
    const next = fn(current);
    if (next === undefined) await db.meta.delete(key);
    else await db.meta.put({ key, value: next });
    return next;
  });
}

// ---------------------------------------------------------------------------------------
// drafts (web.md §3.4): autosaved forms; never touched by sync, scope resets or sign-out of
// the same user.
// ---------------------------------------------------------------------------------------

export const drafts = {
  async get(key: string): Promise<unknown> {
    return (await db.drafts.get(key))?.value;
  },
  async put(key: string, value: unknown): Promise<void> {
    await db.drafts.put({ key, value, updatedAt: Date.now() });
  },
  async remove(key: string): Promise<void> {
    await db.drafts.delete(key);
  },
  /** Newest first. */
  async list(): Promise<Array<{ key: string; updatedAt: number }>> {
    const recs = await db.drafts.orderBy('updatedAt').reverse().toArray();
    return recs.map((r) => ({ key: r.key, updatedAt: r.updatedAt }));
  },
};

// ---------------------------------------------------------------------------------------
// Local session: who is using the device and what it may hold. `src/auth` calls
// `setLocalSession()` after sign-in / `my_context()`; the value survives reloads so that an
// offline start still knows the user.
// ---------------------------------------------------------------------------------------

export interface LocalSession {
  /** `auth.users.id` of the signed-in user (stamps `created_by` locally, "mine" filter). */
  userId: string | null;
  /**
   * `capabilities.can_see_restricted` of `my_context()`. False (the safe default) keeps
   * restricted rows in `restricted_local` and purges them once acknowledged.
   */
  canSeeRestricted: boolean;
}

const SESSION_KEY = 'local_session';
const DEFAULT_SESSION: LocalSession = { userId: null, canSeeRestricted: false };
let session: LocalSession | null = null;

/** The local session (cached; read from `meta` once). Safe inside any transaction that includes `meta`. */
export async function getLocalSession(): Promise<LocalSession> {
  if (session === null) {
    const stored = await getMeta<Partial<LocalSession>>(SESSION_KEY);
    session = { ...DEFAULT_SESSION, ...(stored ?? {}) };
  }
  return session;
}

export async function setLocalSession(next: Partial<LocalSession>): Promise<void> {
  const merged = { ...(await getLocalSession()), ...next };
  session = merged;
  await setMeta(SESSION_KEY, merged);
}

// ---------------------------------------------------------------------------------------
// Public app settings (reference-data.md §5), cached for offline use.
// ---------------------------------------------------------------------------------------

const SETTINGS_KEY = 'app_settings';
let settings: Record<string, unknown> | null = null;

/** Defaults of migration 0063 — used until the settings were fetched once. */
export const DEFAULT_SETTINGS: Readonly<Record<string, unknown>> = {
  'duplicates.radius_m': 150,
  'duplicates.name_similarity': 0.6,
  'persons.name_similarity': 0.6,
  'gps.accuracy_warn_m': 30,
  'security.pin_lock_minutes': 15,
  'photos.max_per_project': 10,
  'photos.full_max_px': 1600,
  'photos.thumb_max_px': 400,
  'photos.quality': 0.8,
  'sync.push_batch_size': 50,
  'sync.pull_page_size': 500,
  'sync.interval_seconds': 120,
  'form.autosave_seconds': 5,
  'list.page_size': 50,
  'search.debounce_ms': 250,
  'map.local_points_min_zoom': 14,
};

async function loadSettings(): Promise<Record<string, unknown>> {
  if (settings === null) settings = (await getMeta<Record<string, unknown>>(SETTINGS_KEY)) ?? {};
  return settings;
}

/** Stores the `app_settings` rows fetched through PostgREST (`key`, `value`). */
export async function saveAppSettings(rows: ReadonlyArray<{ key: string; value: unknown }>): Promise<void> {
  const next: Record<string, unknown> = {};
  for (const r of rows) next[r.key] = r.value;
  settings = next;
  await setMeta(SETTINGS_KEY, next);
}

/** One setting: the cached server value, else the built-in default, else `fallback`. */
export async function getAppSetting<T>(key: string, fallback: T): Promise<T> {
  const cached = (await loadSettings())[key];
  if (cached !== undefined && cached !== null) return cached as T;
  const builtin = DEFAULT_SETTINGS[key];
  return builtin === undefined ? fallback : (builtin as T);
}

/** A numeric setting clamped to `[min, max]` (non-numeric values give the default). */
export async function getNumberSetting(key: string, fallback: number, min: number, max: number): Promise<number> {
  const raw = await getAppSetting<unknown>(key, fallback);
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
  return Math.min(max, Math.max(min, n));
}

/** Forget the in-memory caches (after a wipe, and in tests). */
export function resetMetaCaches(): void {
  session = null;
  settings = null;
}

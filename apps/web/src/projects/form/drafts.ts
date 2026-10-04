/**
 * Autosave of the form (brief §7.4): to the IndexedDB `drafts` store shortly after every field
 * change and every 5 seconds (setting `form.autosave_seconds`), and immediately when the page
 * is hidden or the form unmounts. Esc, the back button and route changes therefore never lose
 * what was typed: the next opening offers to restore it.
 */
import { drafts as draftStore } from '../../db';
import { hasChanges } from './merge';
import {
  DRAFT_PREFIX,
  draftKey,
  isFormDraft,
  parseDraftKey,
  pendingMaintenanceChanged,
  pickerDraftsPending,
  type FormDraft,
} from './model';
import { discardStagedPhotos } from './peers';

export type DraftStore = Pick<typeof draftStore, 'get' | 'put' | 'remove' | 'list'>;

export interface Autosave {
  /** A field changed: save soon (debounced). */
  changed(): void;
  /** Save now (if anything changed since the last save). */
  flush(): Promise<void>;
  /** Stop the timers; with `flush` (default) save one last time. */
  stop(opts?: { flush?: boolean }): Promise<void>;
  /** Forget the stored draft (after a successful save or "discard"). */
  discard(): Promise<void>;
  /** Epoch ms of the last successful write, or null. */
  lastSavedAt(): number | null;
  /** Change the periodic save interval (setting `form.autosave_seconds`). */
  setIntervalMs(ms: number): void;
}

export interface AutosaveOptions {
  read: () => FormDraft;
  store?: DraftStore;
  intervalMs?: number;
  /** Delay after a change before writing (coalesces fast typing). */
  changeDelayMs?: number;
  onSaved?: (at: number) => void;
  onError?: (error: unknown) => void;
}

/**
 * True when the draft holds something worth keeping (also text typed in an open dialog, or
 * in a person picker before a person was chosen).
 */
export function draftWorthKeeping(d: FormDraft): boolean {
  return (
    hasChanges(d.original, d.working) ||
    d.extras.newLocality !== null ||
    pendingMaintenanceChanged(d.extras.pendingMaintenance) ||
    pickerDraftsPending(d.extras)
  );
}

export function createAutosave(opts: AutosaveOptions): Autosave {
  const store = opts.store ?? draftStore;
  const intervalMs = opts.intervalMs ?? 5000;
  const changeDelayMs = opts.changeDelayMs ?? 300;
  let lastJson: string | null = null;
  let lastAt: number | null = null;
  let dirty = false;
  let changeTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let writing: Promise<void> = Promise.resolve();

  const write = async (): Promise<void> => {
    const { savedAt: _ignored, ...draft } = opts.read();
    const key = draftKey(draft.mode, draft.projectId);
    const keep = draftWorthKeeping(draft);
    const json = keep ? JSON.stringify(draft) : '';
    if (json === lastJson) return;
    try {
      const now = Date.now();
      if (keep) await store.put(key, { ...(JSON.parse(json) as FormDraft), savedAt: now });
      else await store.remove(key); // back to "nothing entered"
      lastJson = json;
      lastAt = now;
      dirty = false;
      if (keep) opts.onSaved?.(lastAt);
    } catch (error) {
      opts.onError?.(error);
    }
  };

  const flush = (): Promise<void> => {
    if (changeTimer) {
      clearTimeout(changeTimer);
      changeTimer = null;
    }
    writing = writing.then(write, write);
    return writing;
  };

  const tick = (): void => {
    if (dirty) void flush();
  };
  let interval = setInterval(tick, intervalMs);

  const onHide = (): void => {
    if (document.visibilityState === 'hidden') void flush();
  };
  const onPageHide = (): void => void flush();
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onHide);
  if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide);

  return {
    changed() {
      if (stopped) return;
      dirty = true;
      if (changeTimer) clearTimeout(changeTimer);
      changeTimer = setTimeout(() => void flush(), changeDelayMs);
    },
    flush,
    async stop({ flush: last = true } = {}) {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onHide);
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide);
      if (last) await flush();
      else if (changeTimer) clearTimeout(changeTimer);
      await writing;
    },
    async discard() {
      if (changeTimer) clearTimeout(changeTimer);
      dirty = false;
      await writing;
      const d = opts.read();
      await store.remove(draftKey(d.mode, d.projectId));
      lastJson = '';
    },
    lastSavedAt: () => lastAt,
    setIntervalMs(ms: number) {
      if (stopped || !(ms > 0)) return;
      clearInterval(interval);
      interval = setInterval(tick, ms);
    },
  };
}

export interface DraftSummary {
  key: string;
  updatedAt: number;
  draft: FormDraft;
}

/** Valid drafts of this user, newest first (`mode` filters new / edit forms). */
export async function listUserDrafts(
  userId: string | null,
  opts: { mode?: 'new' | 'edit'; store?: DraftStore } = {},
): Promise<DraftSummary[]> {
  const store = opts.store ?? draftStore;
  const entries = (await store.list()).filter((e) => e.key.startsWith(DRAFT_PREFIX));
  const out: DraftSummary[] = [];
  for (const e of entries) {
    const parsed = parseDraftKey(e.key);
    if (!parsed || (opts.mode && parsed.mode !== opts.mode)) continue;
    const value = await store.get(e.key);
    if (!isFormDraft(value)) continue;
    if ((value.userId ?? null) !== (userId ?? null)) continue;
    out.push({ key: e.key, updatedAt: e.updatedAt, draft: value });
  }
  return out;
}

/** The stored draft of one form, when it belongs to this user and is still readable. */
export async function readDraft(
  mode: 'new' | 'edit',
  projectId: string,
  userId: string | null,
  store: DraftStore = draftStore,
): Promise<FormDraft | null> {
  const value = await store.get(draftKey(mode, projectId));
  if (!isFormDraft(value)) return null;
  if ((value.userId ?? null) !== (userId ?? null)) return null;
  return value;
}

/**
 * Deletes a stored draft. Photos the editor staged in that form (blobs stored, row never
 * saved) are freed with it; photos whose rows are stored stay (they belong to the project).
 */
export async function discardStoredDraft(
  draft: FormDraft,
  deps: {
    store?: DraftStore;
    discardPhotos?: (rows: ReadonlyArray<{ id: string }>) => Promise<void>;
  } = {},
): Promise<void> {
  const store = deps.store ?? draftStore;
  await store.remove(draftKey(draft.mode, draft.projectId));
  try {
    await (deps.discardPhotos ?? discardStagedPhotos)(draft.working.photos);
  } catch (error) {
    console.warn('[form] could not free the photos of a discarded draft', error);
  }
}

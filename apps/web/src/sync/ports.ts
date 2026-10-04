/**
 * Narrow interfaces the sync engine needs from its neighbours (`src/db`, `src/auth`,
 * `src/lib/prefs`, the browser). The real implementations are wired in `index.ts`
 * (`dbAdapter.ts`); unit tests pass fakes. Nothing in push/pull/engine/photoQueue imports
 * `src/db` or `src/auth` directly.
 */
import type { PullChange, PushResult, OpKind } from './types';

// ---------------------------------------------------------------------------------------
// Local database (src/db)
// ---------------------------------------------------------------------------------------

/** One entry of `SYNC_TABLES`, in registry order (must match `private.sync_tables`). */
export interface SyncTableInfo {
  name: string;
  restricted?: boolean;
}

/** One queued operation as stored in the local `outbox` store. */
export interface OutboxOp {
  /** Local, monotonically increasing key = creation order. */
  seq: number;
  op_id: string;
  table: string;
  /** Row id. */
  id: string;
  kind: OpKind;
  base_version: number;
  fields: Record<string, unknown>;
  client_ts: string;
  /**
   * How many times this op was handed to the transport. `mutate()` must never coalesce a
   * new edit into an op with `attempts > 0`: the server may already have applied the
   * payload under this `op_id` (sync.md §7.3).
   */
  attempts: number;
}

export interface LocalCounts {
  /** Operations in the outbox (pending + inflight). */
  pendingOps: number;
  /** Operations parked in `failed_ops`. */
  failedOps: number;
}

export interface PageToApply {
  changes: PullChange[];
  /**
   * Meta entries (the pull cursor) that must become durable in the SAME transaction as the
   * rows: a crash can then never leave a cursor that is ahead of the stored data.
   */
  meta: Array<{ key: string; value: unknown }>;
}

export interface DbPort {
  /** Registry order = parents before children. */
  readonly tables: readonly SyncTableInfo[];

  // -- outbox ---------------------------------------------------------------------------
  /** Every op that is waiting to be sent (not inflight), in any order. */
  pendingOps(): Promise<OutboxOp[]>;
  /**
   * In ONE transaction: mark the ops as inflight, increment `attempts`, and return their
   * current payload (ops that vanished through coalescing/cancellation are skipped).
   * From this moment `mutate()` must not change them.
   */
  markInflight(seqs: readonly number[]): Promise<OutboxOp[]>;
  /** Put inflight ops back to pending, keeping `attempts`. Returns how many were requeued. */
  requeueInflight(seqs?: readonly number[]): Promise<number>;
  /**
   * Apply one server result (sync.md §4.1) atomically: drop the op; applied/merged → store
   * `version` unless a newer local edit is pending (drop the local row when `row_id` names
   * another row); conflict → overwrite the conflicting fields with `server_values`;
   * duplicate → like `original_status`; rejected → move the op to `failed_ops`;
   * restricted rows on a collector's device are purged once acknowledged. Must tolerate an
   * op that is already gone (two tabs).
   */
  ackOp(op: OutboxOp, result: PushResult): Promise<void>;
  counts(): Promise<LocalCounts>;
  /** Calls `listener` whenever outbox / failed_ops / meta change (any tab). Returns unsubscribe. */
  watch(listener: () => void): () => void;

  // -- pull -----------------------------------------------------------------------------
  /**
   * Write one pulled page and its meta entries in ONE transaction (sync.md §5). Rows with
   * pending outbox ops keep their pending fields; tombstones and `gone` ids delete rows (and
   * the children of projects). Applying the same page twice must be harmless.
   */
  applyPage(page: PageToApply): Promise<void>;
  /** Discard all synced tables; keep outbox, photo_blobs, drafts, restricted_local, failed_ops. */
  resetScopedData(): Promise<void>;
  /** Remove every local store (revoked session / device). */
  wipeAll(): Promise<void>;

  // -- meta (key/value) -----------------------------------------------------------------
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
  deleteMeta(key: string): Promise<void>;
  /** Entries whose key starts with `prefix`, ordered by key. */
  listMeta<T>(prefix: string): Promise<Array<{ key: string; value: T }>>;
  /** Atomic read-modify-write; return `undefined` from `fn` to delete the key. */
  updateMeta<T>(key: string, fn: (current: T | undefined) => T | undefined): Promise<T | undefined>;

  // -- rows and photos ------------------------------------------------------------------
  getRow(table: string, id: string): Promise<Record<string, unknown> | undefined>;
  /** `src/db` `mutate()`: optimistic local write + outbox op. */
  mutate(table: string, id: string, patch: Record<string, unknown>): Promise<void>;
  photoBlob(photoId: string, kind: PhotoKind): Promise<Blob | undefined>;
  /** Free a stored blob (the full-size image after its upload, both when the photo is gone). */
  dropPhotoBlob(photoId: string, kind: PhotoKind): Promise<void>;
}

export type PhotoKind = 'full' | 'thumb';

// ---------------------------------------------------------------------------------------
// Auth (src/auth)
// ---------------------------------------------------------------------------------------

/**
 * Raised by the sync engine when the server says this session can no longer be used.
 *  - `not_authenticated`: the JWT is missing or expired and could not be refreshed. Local
 *    data is kept; the user has to sign in again.
 *  - `session_revoked` / `device_revoked`: the account was deactivated, its sessions were
 *    revoked or this device was revoked (lost phone). The engine has ALREADY stopped and,
 *    when `wiped` is true, removed every local store; auth must lock the app and sign out.
 */
export interface SessionProblem {
  reason: 'not_authenticated' | 'session_revoked' | 'device_revoked';
  wiped: boolean;
}

export interface AuthPort {
  /** Stable installation id; also sent as `x-device-id` by the supabase client. */
  deviceId(): string;
  /** Null when nobody is signed in (the engine then idles). */
  userId(): string | null;
  /** A currently valid access token (refreshing it when needed), or null. */
  accessToken(): Promise<string | null>;
  /** Called at most once per engine run; see `SessionProblem`. */
  onSessionProblem(problem: SessionProblem): void | Promise<void>;
}

// ---------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------

export type ConnectionType = 'wifi' | 'ethernet' | 'cellular' | 'bluetooth' | 'wimax' | 'other' | 'none' | 'unknown';

/** Connectivity as the browser reports it. */
export interface NetworkPort {
  isOnline(): boolean;
  /** `navigator.connection.type` when available, else `unknown`. */
  connectionType(): ConnectionType;
  /** `navigator.connection.saveData` (false when unavailable). */
  saveData(): boolean;
  /** Fires on `online` / `offline`. Returns unsubscribe. */
  onChange(listener: (online: boolean) => void): () => void;
  /** Fires when the page becomes visible again. Returns unsubscribe. */
  onVisible(listener: () => void): () => void;
}

export interface PrefsPort {
  /** "Upload photos over Wi-Fi only" (UI preference, src/lib/prefs). */
  wifiOnly(): boolean;
}

export interface AppInfo {
  supabaseUrl: string;
  anonKey: string;
  appVersion: string;
  /** Human-readable device label for the admin's device list. */
  deviceLabel(): string;
}

/** Cross-tab mutual exclusion (navigator.locks, or the IndexedDB lease fallback). */
export interface LockPort {
  /**
   * Runs `fn` while holding the lock. `wait: false` → resolves `{ acquired: false }`
   * immediately when another tab holds it.
   */
  run<T>(fn: () => Promise<T>, opts: { wait: boolean }): Promise<{ acquired: true; value: T } | { acquired: false }>;
}

// ---------------------------------------------------------------------------------------
// Resumable uploads (tus-js-client behind an interface)
// ---------------------------------------------------------------------------------------

export interface UploadRequest {
  blob: Blob;
  bucket: string;
  objectName: string;
  contentType: string;
  /** URL of a previous, unfinished upload of the same blob (resume), else null. */
  uploadUrl: string | null;
  /** The server assigned an upload URL — persist it so the upload survives a reload. */
  onUploadUrl(url: string): void;
  /** Bytes the server has acknowledged so far. */
  onProgress(offset: number, total: number): void;
  signal: AbortSignal;
}

export interface ResumableUploader {
  /** Resolves when the object is completely stored; rejects with a `SyncError`. */
  upload(req: UploadRequest): Promise<void>;
}

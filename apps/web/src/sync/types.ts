/**
 * Wire types of the sync protocol (docs/contracts/sync.md) and the public status shape
 * (docs/contracts/web.md §3.5). Pure types — no runtime code.
 */

export type OpKind = 'upsert' | 'delete';

/** One element of `p_ops` of `sync_push`. */
export interface PushOp {
  /** Idempotency key, generated once when the operation is queued. Never changes on retry. */
  op_id: string;
  table: string;
  /** Row id generated on the device (UUIDv7). */
  id: string;
  kind: OpKind;
  /** Version of the row the edit was made on; 0 = created on this device. */
  base_version: number;
  /** Upsert: changed fields only (all fields on insert). Omitted for deletes. */
  fields?: Record<string, unknown>;
  /** Informational: when the edit was made on the device. */
  client_ts: string;
}

export type AppliedStatus = 'applied' | 'merged' | 'conflict';
export type PushStatus = AppliedStatus | 'rejected' | 'duplicate';

export interface PushErrorInfo {
  code: string;
  message?: string;
  sqlstate?: string;
  constraint?: string;
  column?: string;
}

/** One element of `results` of `sync_push` (same order as the input). */
export interface PushResult {
  op_id: string;
  status: PushStatus;
  version?: number;
  /** Present when `status` is `duplicate`. */
  original_status?: AppliedStatus;
  conflict_ids?: string[];
  conflict_fields?: string[];
  /** Never present for restricted tables. A location conflict is `{ geom: { lon, lat } }`. */
  server_values?: Record<string, unknown>;
  error?: PushErrorInfo;
  /** The op was applied to a different, already existing row (natural keys). */
  row_id?: string;
  ignored_fields?: string[];
}

export interface PullChange {
  table: string;
  rows?: Array<Record<string, unknown>>;
  /** Ids that left the caller's scope. */
  gone?: string[];
}

export interface PullPage {
  changes: PullChange[];
  /** Opaque; sent back unchanged. */
  cursor: unknown;
  done: boolean;
  reset?: boolean;
  scope_epoch?: string;
  server_time?: string;
}

export interface TransportCallOptions {
  /** Cancels the request (stopSync, sign-out, connection lost). */
  signal?: AbortSignal;
}

/** Replaceable network layer (web.md §3.5). The trailing `options` argument is optional. */
export interface Transport {
  push(ops: PushOp[], deviceId: string, options?: TransportCallOptions): Promise<PushResult[]>;
  pull(cursor: unknown | null, limit: number, options?: TransportCallOptions): Promise<PullPage>;
  rpc<T>(fn: string, args?: Record<string, unknown>, options?: TransportCallOptions): Promise<T>;
}

export type SyncState = 'idle' | 'pushing' | 'pulling' | 'error';

export interface SyncStatus {
  online: boolean;
  state: SyncState;
  /** Live count of operations waiting in the outbox. */
  pendingOps: number;
  /** Live count of photos whose objects are not uploaded yet. */
  pendingPhotos: number;
  /** Operations the server rejected ("needs attention"). */
  failedOps: number;
  /** Epoch milliseconds of the last fully successful cycle. */
  lastSyncAt: number | null;
  /** Translation key (`sync.error_*`) of the last failure, null when healthy. */
  lastError: string | null;
}

/** Answer of `register_device` / `report_device_status`. */
export interface DeviceAnswer {
  device_id?: string;
  revoked?: boolean;
  revoked_at?: string | null;
  session_ok?: boolean;
  server_time?: string;
}

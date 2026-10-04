/**
 * Server calls of the people module (docs/contracts/people-admin.md §3–4). All of them go
 * through `transport.rpc` of src/sync (POST, timeout, typed errors). Nothing is called while
 * the device is offline (web.md §1): the callers check `isOnline()` first.
 */
import { supabase } from '../auth';
import { isSyncError, transport } from '../sync';
import { parseServerCandidates, type ServerCandidate } from './candidates';

export function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/** `person_candidates(p_name, p_phone, p_admin_area_id)` — read-only, never merges. */
export async function serverCandidates(input: {
  name: string;
  phone: string | null;
  adminAreaId: string | null;
}): Promise<ServerCandidate[]> {
  const data = await transport.rpc<unknown>('person_candidates', {
    p_name: input.name,
    p_phone: input.phone,
    p_admin_area_id: input.adminAreaId,
  });
  return parseServerCandidates(data);
}

export interface MergeResult {
  request_id: string;
  state: 'merged';
  source_id: string;
  target_id: string;
  moved_staff: number;
  collapsed_staff: number;
  filled_fields: string[];
}

export interface RevertResult {
  request_id: string;
  state: 'reverted';
  source_id: string;
  target_id: string;
  restored_staff: number;
  skipped_staff: number;
  restored_collapsed: number;
  reset_fields: string[];
}

export interface RequestResult {
  request_id: string;
  state: 'pending';
  created: boolean;
}

export interface RejectResult {
  request_id: string;
  state: 'rejected';
  source_id: string;
  target_id: string;
}

/** Reviewers: merge `source` into `target` now (undoable). */
export function mergePersons(source: string, target: string, reason: string): Promise<MergeResult> {
  return transport.rpc<MergeResult>('merge_persons', {
    p_source: source,
    p_target: target,
    p_reason: reason,
  });
}

/** Reviewers: undo a merge (`person_merge_requests.state = 'merged'`). */
export function revertPersonMerge(requestId: string): Promise<RevertResult> {
  return transport.rpc<RevertResult>('revert_person_merge', { p_request_id: requestId });
}

/** Anybody who sees both persons: propose a merge to a reviewer. Nothing is merged. */
export function requestPersonMerge(
  source: string,
  target: string,
  reason: string,
): Promise<RequestResult> {
  return transport.rpc<RequestResult>('request_person_merge', {
    p_source: source,
    p_target: target,
    p_reason: reason,
  });
}

/** Reviewers: decide a pending request. `approve` performs the merge under the same id. */
export function resolvePersonMergeRequest(
  requestId: string,
  decision: 'approve' | 'reject',
  note: string | null,
): Promise<MergeResult | RejectResult> {
  return transport.rpc<MergeResult | RejectResult>('resolve_person_merge_request', {
    p_request_id: requestId,
    p_decision: decision,
    p_note: note,
  });
}

/**
 * Names of persons that are no longer on the device (the source of a merge is soft-deleted
 * and its tombstone removes the local row). RLS keeps tombstones visible inside the scope
 * (authz.md §4.2). Failures resolve to an empty map: the list falls back to a placeholder.
 */
export async function fetchPersonNames(
  ids: readonly string[],
): Promise<Map<string, { name_ar: string | null; name_latin: string | null }>> {
  const out = new Map<string, { name_ar: string | null; name_latin: string | null }>();
  if (ids.length === 0 || !isOnline()) return out;
  try {
    const { data, error } = await supabase
      .from('persons')
      .select('id,name_ar,name_latin')
      .in('id', ids.slice(0, 200));
    if (error || !Array.isArray(data)) return out;
    for (const row of data as Array<{
      id: string;
      name_ar: string | null;
      name_latin: string | null;
    }>) {
      out.set(row.id, { name_ar: row.name_ar, name_latin: row.name_latin });
    }
  } catch {
    // offline in the meantime, or the server refused: keep the placeholder
  }
  return out;
}

/** Server error codes of this area that have their own text (people-admin.md §0). */
const KNOWN_CODES = new Set([
  'forbidden',
  'person_not_found',
  'merge_request_not_found',
  'person_already_merged',
  'merge_not_revertible',
  'request_not_pending',
  'invalid_argument',
  'rate_limited',
  'not_authenticated',
]);

/**
 * Locale key (namespace `people`) for a failed call. The transport keeps the server's
 * `message` in the error text as `<fn>: <code>`.
 */
export function rpcErrorKey(error: unknown): string {
  if (isSyncError(error)) {
    const code = error.message.split(': ').pop() ?? '';
    if (KNOWN_CODES.has(code)) return `people.err_${code}`;
    switch (error.kind) {
      case 'network':
      case 'timeout':
      case 'aborted':
        return 'people.err_network';
      case 'rate_limited':
        return 'people.err_rate_limited';
      case 'forbidden':
        return 'people.err_forbidden';
      case 'unauthenticated':
      case 'session_revoked':
        return 'people.err_not_authenticated';
      default:
        return 'people.err_unknown';
    }
  }
  return 'people.err_unknown';
}

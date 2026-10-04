/**
 * Search box of the project register (brief §5): 250 ms debounce, then the device index
 * (`searchLocal`) at once and — when online — the server `search` RPC; both answers are merged
 * and de-duplicated. Staff hits never reach a user who may not see people (the server and the
 * device already leave them out for viewers; this is the third line).
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { searchLocal, type SearchHit, type SearchKind } from '../db';
import { norm } from '../lib/normalize';
import { syncStatus, transport } from '../sync';

export const SEARCH_DEBOUNCE_MS = 250;
export const SEARCH_LIMIT = 20;

const KIND_ORDER: Record<SearchKind, number> = { project: 0, locality: 1, staff: 2, donor: 3 };

/** A merged hit: `local` = found on this device (a project hit can be opened offline). */
export type MergedHit = SearchHit & { local: boolean };

export function hitKey(hit: Pick<SearchHit, 'kind' | 'id'>): string {
  return `${hit.kind}:${hit.id}`;
}

/**
 * Local hits first (they reflect unsynced edits), server hits added when new; a staff or
 * donor hit present on both sides keeps the server's project list (it covers the whole read
 * scope). Best score first; on equal score projects, localities, staff, donors.
 */
export function mergeHits(
  local: readonly SearchHit[],
  server: readonly SearchHit[],
  opts: { seePeople: boolean; limit?: number },
): MergedHit[] {
  const byKey = new Map<string, MergedHit>();
  for (const hit of local) byKey.set(hitKey(hit), { ...hit, local: true });
  for (const hit of server) {
    const key = hitKey(hit);
    const known = byKey.get(key);
    if (!known) {
      byKey.set(key, { ...hit, local: false });
      continue;
    }
    const score = Math.max(known.score, hit.score);
    if ((hit.kind === 'staff' || hit.kind === 'donor') && known.kind === hit.kind) {
      byKey.set(key, { ...hit, score, local: true });
    } else {
      known.score = score;
    }
  }
  const merged = [...byKey.values()].filter((h) => opts.seePeople || h.kind !== 'staff');
  merged.sort(
    (a, b) =>
      b.score - a.score || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.id < b.id ? -1 : 1),
  );
  return merged.slice(0, opts.limit ?? SEARCH_LIMIT * 2);
}

export function isOnline(): boolean {
  const navOnline = typeof navigator === 'undefined' || navigator.onLine !== false;
  return navOnline && syncStatus.value.online !== false;
}

export interface SearchState {
  /** The query the hits belong to (after the debounce). */
  query: string;
  hits: MergedHit[];
  /** The server answer is still awaited. */
  pending: boolean;
  /** The server could not be asked (offline or failed): device results only. */
  localOnly: boolean;
}

const EMPTY: SearchState = { query: '', hits: [], pending: false, localOnly: false };

/** True when a query is long enough to search (two characters after normalisation). */
export function searchable(q: string): boolean {
  return norm(q ?? '').length >= 2;
}

/**
 * Debounced global search. Returns the merged hits of the last settled query; a newer query
 * discards the answers of older ones.
 */
export function useProjectSearch(q: string, seePeople: boolean): SearchState {
  const [state, setState] = useState<SearchState>(EMPTY);
  const generation = useRef(0);

  useEffect(() => {
    const text = (q ?? '').trim();
    const mine = ++generation.current;
    if (!searchable(text)) {
      setState(EMPTY);
      return;
    }
    const timer = setTimeout(() => {
      const online = isOnline();
      let local: SearchHit[] = [];
      let server: SearchHit[] = [];
      let serverDone = !online;
      let serverFailed = false;
      const publish = (): void => {
        if (generation.current !== mine) return;
        setState({
          query: text,
          hits: mergeHits(local, server, { seePeople }),
          pending: !serverDone,
          localOnly: !online || serverFailed,
        });
      };
      searchLocal(text, SEARCH_LIMIT)
        .then((hits) => {
          local = hits;
          publish();
        })
        .catch(publish);
      if (online) {
        transport
          .rpc<SearchHit[]>('search', { p_q: text, p_limit: SEARCH_LIMIT })
          .then((hits) => {
            server = Array.isArray(hits) ? hits : [];
          })
          .catch(() => {
            serverFailed = true;
          })
          .finally(() => {
            serverDone = true;
            publish();
          });
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q, seePeople]);

  return state;
}

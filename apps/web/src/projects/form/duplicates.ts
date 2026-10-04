/**
 * Duplicate check before saving (brief §7.3): the device index (`findLocalDuplicates`) always,
 * plus the server (`project_duplicates`) when online — the server also knows projects that are
 * not on this device. Hits are merged by id; the user decides ("same project — open it" /
 * "different project"). Nothing here changes any row.
 *
 * "Similar name in the same village" without a chosen locality: the server compares inside the
 * level-3 area that contains the point; the device only approximates that village with a
 * radius (`SAME_VILLAGE_RADIUS_M`, ward shapes are not on the device). Once the server answered,
 * its rule decides for every project it knows — a radius-only name hit is dropped (a "both" hit
 * keeps its 150 m part) unless the project never reached the server.
 */
import { findLocalDuplicates, type DuplicateHit } from '../../db';
import type { Rpc } from './geoCache';
import { localOnlyProjectIds } from './queries';

export const DUPLICATES_TIMEOUT_MS = 6000;

export interface DuplicateQuery {
  type: string;
  lon: number | null;
  lat: number | null;
  name: string;
  localityId: string | null;
  excludeId: string;
}

const REASON_RANK: Record<DuplicateHit['reason'], number> = { both: 0, nearby: 1, similar_name: 2 };

function rank(a: DuplicateHit, b: DuplicateHit): number {
  return (
    REASON_RANK[a.reason] - REASON_RANK[b.reason] ||
    (a.distance_m ?? Infinity) - (b.distance_m ?? Infinity) ||
    (b.similarity ?? 0) - (a.similarity ?? 0)
  );
}

function strongerReason(
  a: DuplicateHit['reason'],
  b: DuplicateHit['reason'],
): DuplicateHit['reason'] {
  if (a === b) return a;
  return 'both';
}

export function mergeDuplicates(
  local: readonly DuplicateHit[],
  server: readonly DuplicateHit[],
  excludeId: string,
): DuplicateHit[] {
  const out = new Map<string, DuplicateHit>();
  for (const hit of [...server, ...local]) {
    if (hit.id === excludeId) continue;
    const seen = out.get(hit.id);
    if (!seen) out.set(hit.id, { ...hit });
    else out.set(hit.id, { ...seen, reason: strongerReason(seen.reason, hit.reason) });
  }
  return [...out.values()].sort(rank).slice(0, 20);
}

/**
 * Local hits once the server answered a query WITHOUT a locality: the device's radius stand-in
 * for the "same village" name rule no longer decides for projects the server knows.
 */
export function withoutRadiusNameHits(
  local: readonly DuplicateHit[],
  localOnly: ReadonlySet<string>,
): DuplicateHit[] {
  const out: DuplicateHit[] = [];
  for (const hit of local) {
    if (localOnly.has(hit.id) || hit.reason === 'nearby') out.push(hit);
    else if (hit.reason === 'both') out.push({ ...hit, reason: 'nearby' });
    // 'similar_name' by radius only: the server's level-3 area rule found no such duplicate.
  }
  return out;
}

function timeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

export async function findDuplicates(
  q: DuplicateQuery,
  deps: {
    rpc: Rpc;
    online: boolean;
    local?: typeof findLocalDuplicates;
    /** Which of these projects the server has never stored (default: device rows). */
    localOnly?: (ids: readonly string[]) => Promise<Set<string>>;
    timeoutMs?: number;
  },
): Promise<DuplicateHit[]> {
  const hasPoint = typeof q.lon === 'number' && typeof q.lat === 'number';
  const name = q.name.trim();
  if (!q.type || (!hasPoint && !name)) return [];
  let local = await (deps.local ?? findLocalDuplicates)({
    type: q.type,
    lon: hasPoint ? (q.lon as number) : Number.NaN,
    lat: hasPoint ? (q.lat as number) : Number.NaN,
    name,
    localityId: q.localityId,
    excludeId: q.excludeId,
  }).catch((error: unknown) => {
    console.warn('[form] local duplicate check failed', error);
    return [] as DuplicateHit[];
  });
  let server: DuplicateHit[] = [];
  let answered = false;
  if (deps.online) {
    try {
      const result = await timeout(
        deps.rpc<DuplicateHit[]>('project_duplicates', {
          p_type: q.type,
          p_lon: hasPoint ? q.lon : null,
          p_lat: hasPoint ? q.lat : null,
          p_name: name || null,
          p_locality_id: q.localityId,
          p_exclude_id: q.excludeId,
        }),
        deps.timeoutMs ?? DUPLICATES_TIMEOUT_MS,
      );
      server = Array.isArray(result) ? result : [];
      answered = Array.isArray(result);
    } catch (error) {
      console.warn('[form] project_duplicates failed, using the device result only', error);
    }
  }
  if (answered && !q.localityId && local.some((h) => h.reason !== 'nearby')) {
    const ids = local.filter((h) => h.reason !== 'nearby').map((h) => h.id);
    const localOnly = await (deps.localOnly ?? localOnlyProjectIds)(ids).catch((error: unknown) => {
      console.warn('[form] could not tell which duplicates are on the server', error);
      return new Set(ids); // unsure: keep the device's warning
    });
    local = withoutRadiusNameHits(local, localOnly);
  }
  return mergeDuplicates(local, server, q.excludeId);
}

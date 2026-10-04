/**
 * Geofill and geo-validation (brief §7.1–7.2).
 *
 *  - Online: `locate_point` (country, deepest area, nearby localities — server truth, also
 *    level 3).
 *  - Offline (or when the call fails / times out): point-in-polygon on the cached level 1–2
 *    shapes (geoCache.ts). Level 3 stays for the user to choose.
 */
import type { LonLat } from '../../lib/geo';
import { cachedCountryIds, getCachedShapes, shapesContaining, type Rpc } from './geoCache';
import { getArea } from './queries';

export type AreaPath = [string | null, string | null, string | null];

export interface LocateResult {
  countryId: string | null;
  areaPath: AreaPath;
  /** Deepest area found (what the server trigger will store). */
  adminAreaId: string | null;
  /** Nearby localities reported by the server (online only). */
  localities: Array<{
    id: string;
    name_ar: string | null;
    name_latin: string | null;
    status: 'approved' | 'proposed';
    admin_area_id: string | null;
    distance_m: number | null;
  }>;
  source: 'server' | 'device' | 'none';
}

export const LOCATE_TIMEOUT_MS = 8000;

export function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

interface LocatePayload {
  country: { id: string } | null;
  admin_area_id: string | null;
  areas: Array<{ id: string; level: number }>;
  localities?: LocateResult['localities'];
}

export function fromLocatePayload(payload: LocatePayload | null | undefined): LocateResult {
  const path: AreaPath = [null, null, null];
  for (const a of payload?.areas ?? []) {
    if (a.level >= 1 && a.level <= 3) path[a.level - 1] = a.id;
  }
  return {
    countryId: payload?.country?.id ?? null,
    areaPath: path,
    adminAreaId: payload?.admin_area_id ?? path[2] ?? path[1] ?? path[0],
    localities: (payload?.localities ?? []).map((l) => ({
      id: l.id,
      name_ar: l.name_ar ?? null,
      name_latin: l.name_latin ?? null,
      status: l.status,
      admin_area_id: l.admin_area_id ?? null,
      distance_m: typeof l.distance_m === 'number' ? Math.round(l.distance_m) : null,
    })),
    source: 'server',
  };
}

/**
 * Offline lookup in the cached shapes. `preferCountries` are tried first (the user's own
 * countries), then every other cached country.
 */
export async function locateOnDevice(
  p: LonLat,
  preferCountries: readonly string[] = [],
): Promise<LocateResult> {
  const none: LocateResult = {
    countryId: null,
    areaPath: [null, null, null],
    adminAreaId: null,
    localities: [],
    source: 'none',
  };
  const cached = await cachedCountryIds();
  const order = [...new Set([...preferCountries.filter((c) => cached.includes(c)), ...cached])];
  for (const countryId of order) {
    const l1 = shapesContaining(await getCachedShapes(countryId, 1), p)[0];
    if (!l1) continue;
    const l2 = shapesContaining(await getCachedShapes(countryId, 2), p).find(
      (s) => s.parent_id === null || s.parent_id === l1.id,
    );
    return {
      countryId,
      areaPath: [l1.id, l2?.id ?? null, null],
      adminAreaId: l2?.id ?? l1.id,
      localities: [],
      source: 'device',
    };
  }
  return none;
}

/** Server first when online, the device cache otherwise (or when the server does not answer). */
export async function locatePoint(
  p: LonLat,
  deps: { rpc: Rpc; online: boolean; preferCountries?: readonly string[]; timeoutMs?: number },
): Promise<LocateResult> {
  if (deps.online) {
    try {
      const payload = await withTimeout(
        deps.rpc<LocatePayload>('locate_point', { p_lon: p.lon, p_lat: p.lat }),
        deps.timeoutMs ?? LOCATE_TIMEOUT_MS,
      );
      return fromLocatePayload(payload);
    } catch (error) {
      console.warn('[form] locate_point failed, using the device cache', error);
    }
  }
  return locateOnDevice(p, deps.preferCountries ?? []);
}

export type Containment = 'inside' | 'outside' | 'unknown';

export interface GeoCheck {
  country: Containment;
  area: Containment;
}

/**
 * Is the point inside the chosen country and area? `located` (the latest geofill result for
 * this very point, server or device) is used when available; otherwise the cached shapes.
 * `unknown` when nothing on the device can tell (no shapes cached for that country).
 */
export async function checkPoint(
  p: LonLat,
  chosen: { countryId: string | null; areaPath: AreaPath },
  located: LocateResult | null,
): Promise<GeoCheck> {
  const result: GeoCheck = { country: 'unknown', area: 'unknown' };
  const chosenAreas = chosen.areaPath.filter((a): a is string => !!a);

  if (located && located.source !== 'none') {
    if (chosen.countryId)
      result.country = located.countryId === chosen.countryId ? 'inside' : 'outside';
    if (chosenAreas.length > 0 && result.country !== 'outside') {
      // Compare level by level wherever both sides know the level.
      let decided = false;
      let inside = true;
      for (let i = 0; i < 3; i++) {
        const want = chosen.areaPath[i];
        const got = located.areaPath[i];
        if (!want || !got) continue;
        decided = true;
        if (want !== got) inside = false;
      }
      result.area = decided ? (inside ? 'inside' : 'outside') : 'unknown';
    }
    if (result.country !== 'unknown' && (result.area !== 'unknown' || chosenAreas.length === 0))
      return result;
  }

  if (!chosen.countryId) return result;
  const level1 = await getCachedShapes(chosen.countryId, 1);
  if (level1 && result.country === 'unknown') {
    result.country = shapesContaining(level1, p).length > 0 ? 'inside' : 'outside';
  }
  if (result.country === 'outside') {
    if (chosenAreas.length > 0) result.area = 'outside';
    return result;
  }
  if (result.area === 'unknown' && chosenAreas.length > 0) {
    // Deepest chosen area that has a cached shape (level 3 has none: test its parent).
    for (let i = 1; i >= 0; i--) {
      const id = chosen.areaPath[i];
      if (!id) continue;
      const shapes = await getCachedShapes(chosen.countryId, i + 1);
      const shape = shapes?.shapes.find((s) => s.id === id);
      if (!shape) continue;
      result.area =
        shapesContaining({ ...shapes!, shapes: [shape] }, p).length > 0 ? 'inside' : 'outside';
      break;
    }
  }
  return result;
}

/** Level of an area row on the device (1..3), or null. */
export async function areaLevel(id: string | null): Promise<number | null> {
  const row = await getArea(id);
  return row ? row.level : null;
}

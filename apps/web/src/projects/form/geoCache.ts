/**
 * Device cache of the simplified administrative shapes (`admin_area_shapes`, docs/contracts/
 * geo-search-tiles.md §2) for offline geofill and geo-validation (brief §7.1–7.2).
 *
 * Levels 1 and 2 carry geometry (level 3 has names only — those rows arrive through
 * `sync_pull`). One entry per (country, level) in the `meta` store, with the bounding box of
 * every feature precomputed so that a lookup tests only the few polygons whose box contains
 * the point. Refreshed when older than 30 days and the device is online.
 */
import type { MultiPolygon, Polygon } from 'geojson';
import { getMeta, listMeta, setMeta } from '../../db';
import {
  bboxContains,
  bboxOfGeometry,
  pointInPolygon,
  type BBox,
  type LonLat,
} from '../../lib/geo';

export const SHAPES_META_PREFIX = 'form.geo.shapes:';
export const SHAPES_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
export const SHAPE_LEVELS = [1, 2] as const;
export type ShapeLevel = (typeof SHAPE_LEVELS)[number];

export interface CachedShape {
  id: string;
  parent_id: string | null;
  level: number;
  bbox: BBox;
  geometry: Polygon | MultiPolygon;
}

export interface CachedShapes {
  countryId: string;
  level: number;
  fetchedAt: number;
  shapes: CachedShape[];
}

interface RpcFeature {
  id?: string;
  geometry: Polygon | MultiPolygon | null;
  properties?: { id?: string; parent_id?: string | null; level?: number };
}

export type Rpc = <T>(fn: string, args?: Record<string, unknown>) => Promise<T>;

const key = (countryId: string, level: number): string =>
  `${SHAPES_META_PREFIX}${countryId}:${level}`;

const memory = new Map<string, CachedShapes | null>();

/** Converts the RPC payload (FeatureCollection) into cache entries; features without geometry are skipped. */
export function toCachedShapes(
  countryId: string,
  level: number,
  payload: { features?: RpcFeature[] } | null | undefined,
  now = Date.now(),
): CachedShapes {
  const shapes: CachedShape[] = [];
  for (const f of payload?.features ?? []) {
    const id = f.properties?.id ?? f.id;
    if (!id || !f.geometry) continue;
    if (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon') continue;
    const bbox = bboxOfGeometry(f.geometry);
    if (!bbox) continue;
    shapes.push({
      id,
      parent_id: f.properties?.parent_id ?? null,
      level: f.properties?.level ?? level,
      bbox,
      geometry: f.geometry,
    });
  }
  return { countryId, level, fetchedAt: now, shapes };
}

export async function getCachedShapes(
  countryId: string,
  level: number,
): Promise<CachedShapes | null> {
  const k = key(countryId, level);
  if (memory.has(k)) return memory.get(k) ?? null;
  const stored = (await getMeta<CachedShapes>(k)) ?? null;
  memory.set(k, stored);
  return stored;
}

export async function putCachedShapes(entry: CachedShapes): Promise<void> {
  const k = key(entry.countryId, entry.level);
  memory.set(k, entry);
  await setMeta(k, entry);
}

/** Countries with at least the level-1 shapes on the device. */
export async function cachedCountryIds(): Promise<string[]> {
  const entries = await listMeta<CachedShapes>(SHAPES_META_PREFIX);
  const ids = new Set<string>();
  for (const e of entries) {
    if (e.value?.level === 1 && e.value.shapes?.length) ids.add(e.value.countryId);
  }
  return [...ids];
}

/**
 * Downloads (when missing or stale) the level 1–2 shapes of the given countries. Never
 * throws: a failed download keeps whatever is cached. Returns the countries refreshed.
 */
export async function ensureShapes(
  countryIds: readonly string[],
  rpc: Rpc,
  opts: { online: boolean; now?: number; maxAgeMs?: number } = { online: true },
): Promise<string[]> {
  if (!opts.online) return [];
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxAgeMs ?? SHAPES_MAX_AGE_MS;
  const refreshed: string[] = [];
  for (const countryId of new Set(countryIds)) {
    for (const level of SHAPE_LEVELS) {
      const cached = await getCachedShapes(countryId, level);
      if (cached && now - cached.fetchedAt < maxAge) continue;
      try {
        const payload = await rpc<{ features?: RpcFeature[] }>('admin_area_shapes', {
          p_country_id: countryId,
          p_level: level,
        });
        await putCachedShapes(toCachedShapes(countryId, level, payload, now));
        if (!refreshed.includes(countryId)) refreshed.push(countryId);
      } catch (error) {
        console.warn('[form] admin_area_shapes failed', error);
      }
    }
  }
  return refreshed;
}

/** The cached shapes of `level` that contain the point (normally one). */
export function shapesContaining(entry: CachedShapes | null, p: LonLat): CachedShape[] {
  if (!entry) return [];
  return entry.shapes.filter((s) => bboxContains(s.bbox, p) && pointInPolygon(p, s.geometry));
}

/** Forget the in-memory copies (tests, after a local data wipe). */
export function resetShapeMemory(): void {
  memory.clear();
}

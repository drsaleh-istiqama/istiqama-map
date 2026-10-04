/**
 * Small geodesy helpers for offline work: distances, point-in-polygon for the cached
 * administrative shapes (`admin_area_shapes`), bounding boxes and the coarse grid used by the
 * local spatial index.
 */
import type { MultiPolygon, Polygon, Position } from 'geojson';

export type LonLat = { lon: number; lat: number };

/** `[minLon, minLat, maxLon, maxLat]` (GeoJSON / MapLibre order). */
export type BBox = [number, number, number, number];

/** Mean Earth radius in metres (IUGG). */
export const EARTH_RADIUS_M = 6371008.8;
/** Metres per degree of latitude (and of longitude at the equator). */
export const METERS_PER_DEGREE = 111320;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

export function isValidLonLat<T extends { lon?: unknown; lat?: unknown }>(
  p: T | null | undefined,
): p is T & LonLat {
  return (
    !!p &&
    typeof p.lon === 'number' &&
    typeof p.lat === 'number' &&
    Number.isFinite(p.lon) &&
    Number.isFinite(p.lat) &&
    p.lon >= -180 &&
    p.lon <= 180 &&
    p.lat >= -90 &&
    p.lat <= 90
  );
}

/**
 * Great-circle distance in metres (haversine on a sphere). Within a few hundred metres it
 * differs from PostGIS' spheroid distance by less than 0.5 %.
 */
export function haversineMeters(a: LonLat, b: LonLat): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = lat2 - lat1;
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Even-odd ray casting on one linear ring. Points exactly on an edge may fall either way. */
function inRing(lon: number, lat: number, ring: readonly Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    const xi = a[0]!;
    const yi = a[1]!;
    const xj = b[0]!;
    const yj = b[1]!;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function inPolygonRings(lon: number, lat: number, rings: readonly Position[][]): boolean {
  const outer = rings[0];
  if (!outer || !inRing(lon, lat, outer)) return false;
  for (let i = 1; i < rings.length; i++) {
    if (inRing(lon, lat, rings[i]!)) return false; // inside a hole
  }
  return true;
}

/** True when the point lies inside the polygon (holes respected) or any part of the multi-polygon. */
export function pointInPolygon(p: LonLat, geometry: Polygon | MultiPolygon): boolean {
  if (geometry.type === 'Polygon') {
    return inPolygonRings(p.lon, p.lat, geometry.coordinates);
  }
  for (const polygon of geometry.coordinates) {
    if (inPolygonRings(p.lon, p.lat, polygon)) return true;
  }
  return false;
}

/** Bounding box of a polygon or multi-polygon, or `null` when it has no coordinates. */
export function bboxOfGeometry(geometry: Polygon | MultiPolygon): BBox | null {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const rings of polygons) {
    const outer = rings[0];
    if (!outer) continue;
    for (const pos of outer) {
      const lon = pos[0]!;
      const lat = pos[1]!;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return Number.isFinite(minLon) ? [minLon, minLat, maxLon, maxLat] : null;
}

export function bboxContains(bbox: BBox, p: LonLat): boolean {
  return p.lon >= bbox[0] && p.lon <= bbox[2] && p.lat >= bbox[1] && p.lat <= bbox[3];
}

export function bboxIntersects(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/**
 * Box that contains the circle of `radiusM` metres around `p` (clamped to valid coordinates;
 * same construction as the server's GiST pre-filter in `project_duplicates`).
 */
export function bboxAround(p: LonLat, radiusM: number): BBox {
  const dLat = radiusM / METERS_PER_DEGREE;
  const dLon = dLat / Math.max(Math.cos(toRad(p.lat)), 0.01);
  return [
    Math.max(-180, p.lon - dLon),
    Math.max(-90, p.lat - dLat),
    Math.min(180, p.lon + dLon),
    Math.min(90, p.lat + dLat),
  ];
}

// ---------------------------------------------------------------------------------------
// Coarse grid for the local spatial index. A cell is 0.01° × 0.01° (about 1.1 km north-south);
// the cell number orders cells row by row, so one row of a bounding box is one key range.
// ---------------------------------------------------------------------------------------

export const GRID_CELL_DEG = 0.01;
/** Cells per row (360° / 0.01°). */
export const GRID_COLUMNS = 36000;
const GRID_ROWS = 18000;

const clampInt = (v: number, max: number): number => (v < 0 ? 0 : v > max ? max : v);

/** Column / row of the cell that contains the coordinate. */
export function gridColumn(lon: number): number {
  return clampInt(Math.floor((lon + 180) / GRID_CELL_DEG + 1e-9), GRID_COLUMNS - 1);
}
export function gridRow(lat: number): number {
  return clampInt(Math.floor((lat + 90) / GRID_CELL_DEG + 1e-9), GRID_ROWS - 1);
}

/** Cell number of a point: `row * 36000 + column`. */
export function gridCell(p: LonLat): number {
  return gridRow(p.lat) * GRID_COLUMNS + gridColumn(p.lon);
}

/**
 * Inclusive cell-number ranges (one per grid row) covering a bounding box.
 * Returns `null` when the box spans more than `maxRows` rows — the caller should then fall
 * back to a coarser strategy instead of opening thousands of ranges.
 */
export function gridRangesForBBox(bbox: BBox, maxRows = 400): Array<[number, number]> | null {
  const row0 = gridRow(Math.min(bbox[1], bbox[3]));
  const row1 = gridRow(Math.max(bbox[1], bbox[3]));
  if (row1 - row0 + 1 > maxRows) return null;
  const col0 = gridColumn(Math.min(bbox[0], bbox[2]));
  const col1 = gridColumn(Math.max(bbox[0], bbox[2]));
  const ranges: Array<[number, number]> = [];
  for (let row = row0; row <= row1; row++) {
    ranges.push([row * GRID_COLUMNS + col0, row * GRID_COLUMNS + col1]);
  }
  return ranges;
}

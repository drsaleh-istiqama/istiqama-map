/**
 * "My location" (brief §12, docs/V2_PARITY.md 1.6). v2 added a new circle on every press;
 * here there is exactly ONE marker (dot + accuracy circle) that is created on the first fix
 * and moved in place afterwards. The map side is an adapter, so the rule is unit-tested
 * without MapLibre.
 */
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import { EARTH_RADIUS_M, type LonLat } from '../lib/geo';

export interface LocateAdapter<M> {
  createMarker(p: LonLat, accuracyM: number): M;
  updateMarker(marker: M, p: LonLat, accuracyM: number): void;
  removeMarker(marker: M): void;
  /** Bring the position into view. */
  focus(p: LonLat, accuracyM: number): void;
}

export interface GeolocationLike {
  getCurrentPosition(
    success: (position: {
      coords: { latitude: number; longitude: number; accuracy: number };
    }) => void,
    error?: (error: { code: number; message?: string }) => void,
    options?: { enableHighAccuracy?: boolean; timeout?: number; maximumAge?: number },
  ): void;
}

export type LocateError = 'unsupported' | 'denied' | 'unavailable' | 'timeout';

export type LocateResult =
  { ok: true; position: LonLat; accuracyM: number } | { ok: false; error: LocateError };

/** GeolocationPositionError codes. */
const ERROR_BY_CODE: Record<number, LocateError> = { 1: 'denied', 2: 'unavailable', 3: 'timeout' };

export class LocateController<M> {
  private marker: M | null = null;
  private pending: Promise<LocateResult> | null = null;
  private last: { position: LonLat; accuracyM: number } | null = null;

  constructor(
    private readonly adapter: LocateAdapter<M>,
    private readonly geolocation: GeolocationLike | null | undefined,
    private readonly options = { enableHighAccuracy: true, timeout: 15_000, maximumAge: 10_000 },
  ) {}

  /** The last known fix (to re-draw the marker after a style change). */
  get lastFix(): { position: LonLat; accuracyM: number } | null {
    return this.last;
  }

  get hasMarker(): boolean {
    return this.marker !== null;
  }

  /** One request at a time: a second press while waiting gets the same answer. */
  locate(): Promise<LocateResult> {
    if (this.pending) return this.pending;
    const geo = this.geolocation;
    if (!geo) return Promise.resolve({ ok: false, error: 'unsupported' });
    this.pending = new Promise<LocateResult>((resolve) => {
      geo.getCurrentPosition(
        (pos) => {
          const position = { lon: pos.coords.longitude, lat: pos.coords.latitude };
          const accuracyM = Math.max(0, pos.coords.accuracy || 0);
          this.show(position, accuracyM);
          this.adapter.focus(position, accuracyM);
          resolve({ ok: true, position, accuracyM });
        },
        (error) => resolve({ ok: false, error: ERROR_BY_CODE[error.code] ?? 'unavailable' }),
        this.options,
      );
    }).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** Draws (first time) or moves (every later time) the single marker. */
  show(position: LonLat, accuracyM: number): void {
    this.last = { position, accuracyM };
    if (this.marker === null) this.marker = this.adapter.createMarker(position, accuracyM);
    else this.adapter.updateMarker(this.marker, position, accuracyM);
  }

  /** The map was rebuilt: forget the old marker handle and draw the last fix again. */
  reattach(): void {
    this.marker = null;
    if (this.last) this.show(this.last.position, this.last.accuracyM);
  }

  clear(): void {
    if (this.marker !== null) this.adapter.removeMarker(this.marker);
    this.marker = null;
    this.last = null;
  }
}

/** Polygon approximating the accuracy circle (geodesic offsets, good to < 1 % up to 10 km). */
export function circlePolygon(center: LonLat, radiusM: number, steps = 48): Polygon {
  const ring: Array<[number, number]> = [];
  const r = Math.max(radiusM, 0) / EARTH_RADIUS_M;
  const lat1 = (center.lat * Math.PI) / 180;
  const lon1 = (center.lon * Math.PI) / 180;
  for (let i = 0; i < steps; i++) {
    const bearing = (2 * Math.PI * i) / steps;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(r) + Math.cos(lat1) * Math.sin(r) * Math.cos(bearing),
    );
    const lon2 =
      lon1 +
      Math.atan2(
        Math.sin(bearing) * Math.sin(r) * Math.cos(lat1),
        Math.cos(r) - Math.sin(lat1) * Math.sin(lat2),
      );
    ring.push([(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI]);
  }
  ring.push(ring[0]!);
  return { type: 'Polygon', coordinates: [ring] };
}

/** GeoJSON drawn by the map adapter: the accuracy circle and the dot, as ONE collection. */
export function locateFeatures(p: LonLat, accuracyM: number): FeatureCollection {
  const features: Feature[] = [];
  if (accuracyM > 0)
    features.push({ type: 'Feature', properties: {}, geometry: circlePolygon(p, accuracyM) });
  features.push({
    type: 'Feature',
    properties: { accuracy: accuracyM },
    geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
  });
  return { type: 'FeatureCollection', features };
}

/** Zoom that shows the accuracy circle comfortably (street level for a good GPS fix). */
export function zoomForAccuracy(accuracyM: number): number {
  if (accuracyM <= 50) return 16;
  if (accuracyM <= 200) return 15;
  if (accuracyM <= 1000) return 13;
  return 11;
}

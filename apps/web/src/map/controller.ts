/**
 * The map currently on screen, so that other modules can move it without importing MapLibre
 * (`flyToProject`, `fitToFilter` in index.ts). A camera request made while no map is mounted
 * (e.g. "show on map" from the details page) is kept and applied by the next map that mounts.
 * Pure module: no MapLibre, no DOM.
 */
import type { BBox, LonLat } from '../lib/geo';

export interface MapCameraTarget {
  flyTo(p: LonLat, zoom?: number): void;
  fitBounds(bounds: BBox, maxZoom?: number): void;
}

export type CameraRequest =
  { kind: 'fly'; point: LonLat; zoom?: number } | { kind: 'fit'; bounds: BBox; maxZoom?: number };

let active: MapCameraTarget | null = null;
let pending: CameraRequest | null = null;

function apply(target: MapCameraTarget, request: CameraRequest): void {
  if (request.kind === 'fly') target.flyTo(request.point, request.zoom);
  else target.fitBounds(request.bounds, request.maxZoom);
}

/**
 * Called by the main map when it is ready; applies a waiting request. Returns the function
 * that unregisters it (only if it is still the active one).
 */
export function registerMap(target: MapCameraTarget): () => void {
  active = target;
  if (pending) {
    const request = pending;
    pending = null;
    apply(target, request);
  }
  return () => {
    if (active === target) active = null;
  };
}

export function hasActiveMap(): boolean {
  return active !== null;
}

/** A camera request is waiting for the next map (e.g. "show on map" from another page). */
export function hasPendingCamera(): boolean {
  return pending !== null;
}

/** Moves the active map, or remembers the request for the next map. Returns true when applied now. */
export function requestCamera(request: CameraRequest): boolean {
  if (active) {
    apply(active, request);
    return true;
  }
  pending = request;
  return false;
}

/** The request waiting for a map (and forget it) — used by a map that mounts. */
export function takePendingCamera(): CameraRequest | null {
  const request = pending;
  pending = null;
  return request;
}

/** Test helper. */
export function resetMapController(): void {
  active = null;
  pending = null;
}
